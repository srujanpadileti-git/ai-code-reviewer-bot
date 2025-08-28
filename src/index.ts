import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";

import {
  getPRContext,
  getChangedFiles,
  getFileContentAtRef,
  postLineComment,
  createOrUpdateCheck,
  getPRLabels,
  getPRHeadInfo,
} from "./github.js";

import { parsePatchToHunks } from "./diff.js";
import { extractContextForRange, detectLang } from "./ast.js";
import { systemPrompt, buildUserPrompt, safeParseFindings } from "./prompts.js";
import { callModel, type ModelCall } from "./model.js";
import { aggregateFindings, type Finding } from "./aggregator.js";
import { toCommentBody } from "./suggestions.js";
import { buildConfig } from "./config.js";
import { ensureRepoIndex, retrieveSimilar } from "./context.js";
import { runRules } from "./rules.js";
import {
  collectFixes,
  applyFixesToDisk,
  gitCommitAndPush,
  toAllowedCats,
} from "./autofix.js";

async function run() {
  try {
    // Tokens:
    // - GITHUB_TOKEN (from Actions): for reads + Checks API
    // - REVIEWER_TOKEN (optional PAT): for posting comments & commits as YOU
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) throw new Error("GITHUB_TOKEN missing (Actions should provide this automatically).");
    const reviewerToken = process.env.REVIEWER_TOKEN || "";

    // Clients
    const dataClient = new Octokit({ auth: githubToken });                      // reads (files/PR info)
    const commentsClient = new Octokit({ auth: reviewerToken || githubToken }); // review comments
    const checksClient = new Octokit({ auth: githubToken });                    // Checks summary

    const { owner, repo, prNumber, headSha } = getPRContext();
    const fullRepo = `${owner}/${repo}`;

    // Labels → config (controls, filters, caps)
    const labels = await getPRLabels(dataClient, owner, repo, prNumber);
    const cfg = buildConfig(labels, process.env);
    if (cfg.skipAll) {
      console.log("⏭️  Skipping review due to label `ai-review:skip` or SKIP_ALL=1.");
      return;
    }
    console.log(
      `🛠️  Config: max=${cfg.maxComments}, dryRun=${cfg.dryRun}, only=[${cfg.onlyGlobs.join(
        ", "
      )}], skip=[${cfg.skipGlobs.join(", ")}]`
    );
    console.log(`   Comments via ${reviewerToken ? "REVIEWER_TOKEN (your account)" : "GITHUB_TOKEN (bot)"}`);
    console.log(`   Rules: enabled=${cfg.rulesEnabled}, rulesOnly=${cfg.rulesOnly}, allowConsole=${cfg.allowConsole}`);
    console.log(`   Auto-fix: enabled=${cfg.autoFix}, scopes=[${cfg.fixScopes.join(", ")}], maxFixLines=${cfg.maxFixLines}`);

    // Day 6: Build/load repo RAG index (fail-open) and set Top-K
    const ragK = Math.max(0, Number(process.env.RAG_K || "6"));
    const repoIndex = ragK > 0 ? await ensureRepoIndex(labels, process.env) : null;
    console.log(`📚 RAG index: ${repoIndex ? repoIndex.entries.length : 0} chunks loaded, topK=${ragK}`);

    // Metrics
    const runStart = Date.now();
    let totalPrompt = 0;
    let totalOut = 0;
    let totalTokens = 0;

    const allFindings: Finding[] = [];
    const changed = await getChangedFiles(dataClient, owner, repo, prNumber);

    for (const file of changed) {
      const filePath = file.filename;

      // Path filters (labels/env)
      if (!cfg.allowFile(filePath)) {
        console.log(`   🚫 Skipping ${filePath} (filtered)`);
        continue;
      }

      // Language scope (TS/JS/PY)
      const lang = detectLang(filePath);
      if (!["ts", "js", "py"].includes(lang)) continue;

      // Current file contents at PR head
      const source = await getFileContentAtRef(dataClient, owner, repo, filePath, headSha);

      // Parse unified diff patch → hunks
      const hunks = parsePatchToHunks(file.patch);
      if (hunks.length === 0) continue;

      for (const h of hunks) {
        // AST context around the changed range
        const ctx = extractContextForRange(filePath, source, h.startLine, h.endLine);

        // 1) Deterministic rules on the changed lines (no tokens)
        if (cfg.rulesEnabled) {
          const ruleFindings = runRules({
            path: filePath,
            source,
            startLine: h.startLine,
            endLine: h.endLine,
            allowConsole: cfg.allowConsole,
          });
          allFindings.push(...ruleFindings);
        }

        // 2) Skip model entirely if rules-only mode is on
        if (cfg.rulesOnly) continue;

        // Retrieve related repo context (RAG) for the model
        const related = ragK > 0 ? await retrieveSimilar(repoIndex, ctx.snippet, filePath, ragK) : [];

        // Build messages for the model
        const messages = [
          { role: "system" as const, content: systemPrompt() },
          {
            role: "user" as const,
            content: buildUserPrompt({
              repo: fullRepo,
              filePath,
              startLine: h.startLine,
              endLine: h.endLine,
              symbolType: ctx.symbolType,
              symbolName: ctx.symbolName,
              snippetStart: ctx.snippetStartLine,
              snippetEnd: ctx.snippetEndLine,
              snippet: ctx.snippet,
              related,
            }),
          },
        ];

        // Call model (returns text + token usage)
        let out: ModelCall = { text: "[]", promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        try {
          out = await callModel(messages);
        } catch (e: any) {
          console.log(`  ⚠️  Model error: ${String(e?.message || e).slice(0, 200)}`);
        }
        totalPrompt += out.promptTokens;
        totalOut += out.completionTokens;
        totalTokens += out.totalTokens;

        // Parse JSON → findings
        const findings = safeParseFindings(out.text);
        for (const f of findings) {
          f.path = f.path || filePath;
          f.start_line = f.start_line || h.startLine;
          f.end_line = f.end_line || h.endLine;
          if (!f.category) f.category = "style";
          if (!f.severity) f.severity = "low";
          if (!f.title) f.title = "Suggested improvement";
        }
        allFindings.push(...findings);
      }
    }

    // Rank, dedupe, cap
    const { top, counts } = aggregateFindings(allFindings, cfg.maxComments);

    // === Day 9: Auto-fix (optional) ===
    let autoFixSha: string | null = null;

    if (cfg.autoFix) {
      // Only fix a subset we’ll actually post (avoid surprise edits outside cap)
      const allowedCats = toAllowedCats(cfg.fixScopes);
      const fixes = collectFixes(top, { allowedCats, maxLines: cfg.maxFixLines });

      if (fixes.length) {
        console.log(`🛠️  Auto-fix planning: ${fixes.length} small edits across ${new Set(fixes.map(f => f.path)).size} file(s).`);

        // We’re running in a checked-out repo (actions/checkout), so write to disk
        applyFixesToDisk(process.cwd(), fixes);

        // Figure out PR head branch and push
        const headInfo = await getPRHeadInfo(dataClient as any, owner, repo, prNumber);
        const headRef = headInfo.headRef;

        // Use REVIEWER_TOKEN if provided so the commit counts for you
        const token = process.env.REVIEWER_TOKEN || "";
        const actor = process.env.GITHUB_ACTOR || "ai-reviewer";
        const email = `${actor}@users.noreply.github.com`;
        const remote = token
          ? `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
          : undefined;

        try {
          autoFixSha = gitCommitAndPush(headRef, actor, email, remote) || null;
          if (autoFixSha) {
            console.log(`  ✅ Auto-fix commit pushed: ${autoFixSha}`);
          }
        } catch (e: any) {
          console.log(`  ⚠️  Auto-fix push skipped: ${String(e?.message || e).slice(0, 200)}`);
        }
      } else {
        console.log("ℹ️  Auto-fix found nothing safe to change in the capped findings.");
      }
    }

    // Post comments (unless dry-run)
    if (cfg.dryRun) {
      console.log("🧪 Dry-run mode: not posting comments. Findings would be:");
      console.log(JSON.stringify(top, null, 2));
    } else {
      for (const f of top) {
        const body = toCommentBody(f);
        try {
          await postLineComment(commentsClient, owner, repo, prNumber, headSha, f.path, f.end_line, body);
          console.log(`  ✅ Comment posted: ${f.path}:${f.end_line} — ${f.title}`);
        } catch (e: any) {
          console.log(
            `  ⚠️  Failed to post comment at ${f.path}:${f.end_line} — ${String(e?.message || e).slice(0, 200)}`
          );
        }
      }
    }

    // Build Checks summary (tokens, time, cost, rag info, auto-fix)
    const seconds = ((Date.now() - runStart) / 1000).toFixed(1);
    let costLine = "_Set COST_IN_PER_1K and COST_OUT_PER_1K in the workflow to estimate $ cost._";
    const costInPer1K = Number(process.env.COST_IN_PER_1K || 0);
    const costOutPer1K = Number(process.env.COST_OUT_PER_1K || 0);
    if (costInPer1K > 0 || costOutPer1K > 0) {
      const est = (totalPrompt / 1000) * costInPer1K + (totalOut / 1000) * costOutPer1K;
      costLine = `Estimated cost: ~$${est.toFixed(4)} (in=${costInPer1K}/1k, out=${costOutPer1K}/1k)`;
    }

    const ragLine = `RAG: index **${repoIndex ? repoIndex.entries.length : 0}** chunks, topK **${ragK}**.`;

    const summaryMd =
      `**AI Code Review summary**\n\n` +
      `- Total posted: **${cfg.dryRun ? 0 : top.length}** (cap ${cfg.maxComments})\n` +
      `- Severity: high **${counts.high}**, medium **${counts.medium}**, low **${counts.low}**\n` +
      `- Tokens: prompt **${totalPrompt}**, out **${totalOut}**, total **${totalTokens}**\n` +
      `- Time: **${seconds}s**\n` +
      `- ${costLine}\n` +
      `- ${ragLine}\n` +
      `- Rules: enabled **${cfg.rulesEnabled}**, rules-only **${cfg.rulesOnly}**, allowConsole **${cfg.allowConsole}**\n` +
      `- Auto-fix: ${cfg.autoFix ? (autoFixSha ? `pushed commit \`${autoFixSha.slice(0,7)}\`` : "no changes") : "disabled"}\n\n` +
      (top.length
        ? top
            .map(
              (f, i) =>
                `${i + 1}. \`${f.path}:${f.start_line}-${f.end_line}\` — **${f.severity.toUpperCase()} ${f.category}** — ${escapeMd(
                  f.title
                )}`
            )
            .join("\n")
        : "_No material issues._");

    try {
      await createOrUpdateCheck(checksClient, owner, repo, headSha, summaryMd);
      console.log("  ✅ Checks summary posted.");
    } catch (e: any) {
      console.log(`  ⚠️  Failed to post Checks summary — ${String(e?.message || e).slice(0, 200)}`);
    }

    console.log("\n✅ Day 9 complete: rule-based + RAG review, comments, and optional auto-fix commit.");
  } catch (err: any) {
    core.setFailed(err.message);
  }
}

function escapeMd(s: string) {
  return s.replace(/[_*`]/g, (m) => "\\" + m);
}

run();
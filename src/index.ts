import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";

import {
  getPRContext,
  getChangedFiles,
  getFileContentAtRef,
  postLineComment,
  createOrUpdateCheck,
  getPRLabels,
} from "./github.js";

import { parsePatchToHunks } from "./diff.js";
import { extractContextForRange, detectLang } from "./ast.js";
import { systemPrompt, buildUserPrompt, safeParseFindings } from "./prompts.js";
import { callModel, type ModelCall } from "./model.js";
import { aggregateFindings, type Finding } from "./aggregator.js";
import { toCommentBody } from "./suggestions.js";
import { buildConfig } from "./config.js";
import { ensureRepoIndex, retrieveSimilar } from "./context.js";

async function run() {
  try {
    // Tokens:
    // - GITHUB_TOKEN (from Actions): use for reads + Checks API
    // - REVIEWER_TOKEN (optional PAT): use for posting comments as YOU
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) throw new Error("GITHUB_TOKEN missing (Actions should provide this automatically).");
    const reviewerToken = process.env.REVIEWER_TOKEN || "";

    // Clients
    const dataClient = new Octokit({ auth: githubToken });                     // reads (files/PR info)
    const commentsClient = new Octokit({ auth: reviewerToken || githubToken }); // review comments
    const checksClient = new Octokit({ auth: githubToken });                   // Checks summary

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

    // Day 6: Build/load repo RAG index and set Top-K
    const ragK = Number(process.env.RAG_K || "6");
    const repoIndex = await ensureRepoIndex(labels, process.env);
    console.log(`📚 RAG index: ${repoIndex ? repoIndex.entries.length : 0} chunks loaded, topK=${ragK}`);

    const runStart = Date.now();
    let totalPrompt = 0,
      totalOut = 0,
      totalTokens = 0;

    const allFindings: Finding[] = [];
    const changed = await getChangedFiles(dataClient, owner, repo, prNumber);

    for (const file of changed) {
      const path = file.filename;

      // Path filters (labels/env)
      if (!cfg.allowFile(path)) {
        console.log(`   🚫 Skipping ${path} (filtered)`);
        continue;
      }

      // Language scope (Day 4/5: TS/JS)
      const lang = detectLang(path);
      if (!["ts", "js"].includes(lang)) continue;

      // Current file contents at PR head
      const source = await getFileContentAtRef(dataClient, owner, repo, path, headSha);

      // Parse unified diff patch → hunks
      const hunks = parsePatchToHunks(file.patch);
      if (hunks.length === 0) continue;

      for (const h of hunks) {
        // AST context around the changed range
        const ctx = extractContextForRange(path, source, h.startLine, h.endLine);

        // Retrieve related repo context (RAG)
        const related = await retrieveSimilar(repoIndex, ctx.snippet, path, ragK);

        // Build messages for the model
        const messages = [
          { role: "system" as const, content: systemPrompt() },
          {
            role: "user" as const,
            content: buildUserPrompt({
              repo: fullRepo,
              filePath: path,
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
          f.path = f.path || path;
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

    // Build Checks summary (tokens, time, cost, rag info)
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
      `- ${ragLine}\n\n` +
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

    console.log("\n✅ Day 6 complete: comments + summary with RAG context.");
  } catch (err: any) {
    core.setFailed(err.message);
  }
}

function escapeMd(s: string) {
  return s.replace(/[_*`]/g, (m) => "\\" + m);
}

run();
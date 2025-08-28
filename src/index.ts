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

async function run() {
  try {
    // Tokens:
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) throw new Error("GITHUB_TOKEN missing (Actions should provide this automatically).");
    const reviewerToken = process.env.REVIEWER_TOKEN || "";

    // Clients
    const dataClient     = new Octokit({ auth: githubToken });                  // reads
    const commentsClient = new Octokit({ auth: reviewerToken || githubToken }); // comments (your PAT if provided)
    const checksClient   = new Octokit({ auth: githubToken });                  // checks

    const { owner, repo, prNumber, headSha } = getPRContext();
    const fullRepo = `${owner}/${repo}`;

    // === New: read labels → build config ===
    const labels = await getPRLabels(dataClient, owner, repo, prNumber);
    const cfg = buildConfig(labels, process.env);

    if (cfg.skipAll) {
      console.log("⏭️  Skipping review due to label `ai-review:skip` or SKIP_ALL=1.");
      return;
    }

    console.log(`🛠️  Config: max=${cfg.maxComments}, dryRun=${cfg.dryRun}, only=[${cfg.onlyGlobs.join(", ")}], skip=[${cfg.skipGlobs.join(", ")}]`);
    console.log(`   Comments via ${reviewerToken ? "REVIEWER_TOKEN (your account)" : "GITHUB_TOKEN (bot)"}`);

    const t0 = Date.now();
    let totalPrompt = 0, totalOut = 0, totalTokens = 0;

    // Collect findings
    const allFindings: Finding[] = [];
    const changed = await getChangedFiles(dataClient, owner, repo, prNumber);

    for (const file of changed) {
      const path = file.filename;
      if (!cfg.allowFile(path)) {
        console.log(`   🚫 Skipping ${path} (filtered)`);
        continue;
      }

      const lang = detectLang(path);
      if (!["ts", "js"].includes(lang)) continue; // scope

      const source = await getFileContentAtRef(dataClient, owner, repo, path, headSha);
      const hunks = parsePatchToHunks(file.patch);
      if (hunks.length === 0) continue;

      for (const h of hunks) {
        const ctx = extractContextForRange(path, source, h.startLine, h.endLine);

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
            }),
          },
        ];

        let out: ModelCall = { text: "[]", promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        try { out = await callModel(messages); }
        catch (e: any) { console.log(`  ⚠️  Model error: ${String(e?.message || e).slice(0, 200)}`); }

        totalPrompt += out.promptTokens;
        totalOut    += out.completionTokens;
        totalTokens += out.totalTokens;

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
          console.log(`  ⚠️  Failed to post comment at ${f.path}:${f.end_line} — ${String(e?.message || e).slice(0, 200)}`);
        }
      }
    }

    // Metrics
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    let costLine = "_Set COST_IN_PER_1K and COST_OUT_PER_1K in the workflow to estimate $ cost._";
    if (cfg.costInPer1K > 0 || cfg.costOutPer1K > 0) {
      const est = (totalPrompt / 1000) * cfg.costInPer1K + (totalOut / 1000) * cfg.costOutPer1K;
      costLine = `Estimated cost: ~$${est.toFixed(4)} (in=${cfg.costInPer1K}/1k, out=${cfg.costOutPer1K}/1k)`;
    }

    const summaryMd =
      `**AI Code Review summary**\n\n` +
      `- Total posted: **${cfg.dryRun ? 0 : top.length}** (cap ${cfg.maxComments})\n` +
      `- Severity: high **${counts.high}**, medium **${counts.medium}**, low **${counts.low}**\n` +
      `- Tokens: prompt **${totalPrompt}**, out **${totalOut}**, total **${totalTokens}**\n` +
      `- Time: **${seconds}s**\n` +
      `- ${costLine}\n\n` +
      (top.length
        ? top.map((f, i) => `${i + 1}. \`${f.path}:${f.start_line}-${f.end_line}\` — **${f.severity.toUpperCase()} ${f.category}** — ${escapeMd(f.title)}`).join("\n")
        : "_No material issues._");

    try {
      await createOrUpdateCheck(checksClient, owner, repo, headSha, summaryMd);
      console.log("  ✅ Checks summary posted.");
    } catch (e: any) {
      console.log(`  ⚠️  Failed to post Checks summary — ${String(e?.message || e).slice(0, 200)}`);
    }

    console.log("\n✅ Day 5 complete: labels, filters, and metrics added.");
  } catch (err: any) {
    core.setFailed(err.message);
  }
}

function escapeMd(s: string) { return s.replace(/[_*`]/g, (m) => "\\" + m); }

run();
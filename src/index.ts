import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";

import {
  getPRContext,
  getChangedFiles,
  getFileContentAtRef,
  postLineComment,
  createOrUpdateCheck,
} from "./github.js";

import { parsePatchToHunks } from "./diff.js";
import { extractContextForRange, detectLang } from "./ast.js";
import { systemPrompt, buildUserPrompt, safeParseFindings } from "./prompts.js";
import { callModel } from "./model.js";
import { aggregateFindings, type Finding } from "./aggregator.js";
import { toCommentBody } from "./suggestions.js";

async function run() {
  try {
    // Tokens:
    // - GITHUB_TOKEN (always present in Actions): use for reading repo + creating Checks
    // - REVIEWER_TOKEN (optional, your fine-grained PAT): use for posting comments as YOU
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) throw new Error("GITHUB_TOKEN missing (Actions should provide this automatically).");
    const reviewerToken = process.env.REVIEWER_TOKEN || "";

    // Three clients (can point to different tokens)
    const dataClient = new Octokit({ auth: githubToken });                 // reads (files/PR info)
    const commentsClient = new Octokit({ auth: reviewerToken || githubToken }); // posts review comments
    const checksClient = new Octokit({ auth: githubToken });               // Checks API

    const { owner, repo, prNumber, headSha } = getPRContext();
    const fullRepo = `${owner}/${repo}`;
    const maxComments = Number(process.env.MAX_COMMENTS || "10");

    console.log(`📝 Day 4: posting real comments on PR #${prNumber} (${fullRepo})`);
    console.log(`   Using ${reviewerToken ? "REVIEWER_TOKEN (comments as YOU)" : "GITHUB_TOKEN (bot)"} for comments`);
    console.log(`   MAX_COMMENTS = ${maxComments}`);

    // Collect all findings across all changed hunks
    const allFindings: Finding[] = [];

    const changed = await getChangedFiles(dataClient, owner, repo, prNumber);

    for (const file of changed) {
      const lang = detectLang(file.filename);
      if (!["ts", "js"].includes(lang)) continue; // Day 4 scope: TS/JS only

      // Source at PR head
      const source = await getFileContentAtRef(dataClient, owner, repo, file.filename, headSha);

      // Parse unified diff to hunks
      const hunks = parsePatchToHunks(file.patch);
      if (hunks.length === 0) continue;

      for (const h of hunks) {
        // AST context + snippet window
        const ctx = extractContextForRange(file.filename, source, h.startLine, h.endLine);

        // Build messages for the model
        const messages = [
          { role: "system" as const, content: systemPrompt() },
          {
            role: "user" as const,
            content: buildUserPrompt({
              repo: fullRepo,
              filePath: file.filename,
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

        // Query model → JSON array (or [])
        let raw = "[]";
        try {
          raw = await callModel(messages);
        } catch (e: any) {
          console.log(`  ⚠️  Model error: ${String(e?.message || e).slice(0, 200)}`);
          raw = "[]";
        }
        const findings = safeParseFindings(raw);

        // Ensure required fields are set
        for (const f of findings) {
          f.path = f.path || file.filename;
          f.start_line = f.start_line || h.startLine;
          f.end_line = f.end_line || h.endLine;
          // Basic sanity defaults
          if (!f.category) f.category = "style";
          if (!f.severity) f.severity = "low";
          if (!f.title) f.title = "Suggested improvement";
        }

        allFindings.push(...findings);
      }
    }

    // Rank + dedupe + cap
    const { top, counts } = aggregateFindings(allFindings, maxComments);

    // Post line comments
    for (const f of top) {
      const body = toCommentBody(f);
      try {
        await postLineComment(
          commentsClient,
          owner,
          repo,
          prNumber,
          headSha,
          f.path,
          f.end_line, // single-line comment on the changed end line
          body
        );
        console.log(`  ✅ Comment posted: ${f.path}:${f.end_line} — ${f.title}`);
      } catch (e: any) {
        console.log(
          `  ⚠️  Failed to post comment at ${f.path}:${f.end_line} — ${String(e?.message || e).slice(0, 200)}`
        );
      }
    }

    // Checks summary (created with GITHUB_TOKEN)
    const summaryMd =
      `**AI Code Review summary**\n\n` +
      `- Total posted: **${top.length}** (cap ${maxComments})\n` +
      `- Severity: high **${counts.high}**, medium **${counts.medium}**, low **${counts.low}**\n\n` +
      (top.length
        ? top
            .map(
              (f, i) =>
                `${i + 1}. \`${f.path}:${f.start_line}-${f.end_line}\` — **${f.severity.toUpperCase()} ${f.category}** — ${escapeMd(
                  f.title
                )}`
            )
            .join("\n")
        : "_No material issues posted._");

    try {
      await createOrUpdateCheck(checksClient, owner, repo, headSha, summaryMd);
      console.log("  ✅ Checks summary posted.");
    } catch (e: any) {
      console.log(`  ⚠️  Failed to post Checks summary — ${String(e?.message || e).slice(0, 200)}`);
    }

    console.log("\n✅ Day 4 complete: comments + summary posted.");
  } catch (err: any) {
    core.setFailed(err.message);
  }
}

function escapeMd(s: string) {
  return s.replace(/[_*`]/g, (m) => "\\" + m);
}

run();
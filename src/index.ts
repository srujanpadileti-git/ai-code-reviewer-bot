import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { getPRContext, getChangedFiles, getFileContentAtRef, postLineComment, createOrUpdateCheck } from "./github.js";
import { parsePatchToHunks } from "./diff.js";
import { extractContextForRange, detectLang } from "./ast.js";
import { systemPrompt, buildUserPrompt, safeParseFindings } from "./prompts.js";
import { callModel } from "./model.js";
import { aggregateFindings, type Finding } from "./aggregator.js";
import { toCommentBody } from "./suggestions.js";

async function run() {
  try {
    // Prefer REVIEWER_TOKEN so comments come from YOUR account (counts as contributions)
    const token = process.env.REVIEWER_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) throw new Error("No token found. Provide GITHUB_TOKEN (default) or REVIEWER_TOKEN (to comment as yourself).");

    const octokit = new Octokit({ auth: token });
    const { owner, repo, prNumber, headSha } = getPRContext();
    const fullRepo = `${owner}/${repo}`;
    const changed = await getChangedFiles(octokit, owner, repo, prNumber);

    console.log(`📝 Day 4: posting real comments on PR #${prNumber} (${fullRepo})`);

    const allFindings: Finding[] = [];

    for (const file of changed) {
      const lang = detectLang(file.filename);
      if (!["ts", "js"].includes(lang)) continue;

      const source = await getFileContentAtRef(octokit, owner, repo, file.filename, headSha);
      const hunks = parsePatchToHunks(file.patch);
      if (hunks.length === 0) continue;

      for (const h of hunks) {
        const ctx = extractContextForRange(file.filename, source, h.startLine, h.endLine);

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
              snippet: ctx.snippet
            })
          }
        ];

        let raw = "[]";
        try {
          raw = await callModel(messages);
        } catch (e: any) {
          console.log(`  ⚠️  Model error: ${e.message?.slice(0, 200)}`);
        }
        const findings = safeParseFindings(raw);

        // Annotate with path + lines from this hunk (model already has them but be safe)
        for (const f of findings) {
          f.path = f.path || file.filename;
          f.start_line = f.start_line || h.startLine;
          f.end_line = f.end_line || h.endLine;
        }
        allFindings.push(...findings);
      }
    }

    // Rank, dedupe, and cap
    const max = Number(process.env.MAX_COMMENTS || "10");
    const { top, counts } = aggregateFindings(allFindings, max);

    // Post comments (one per finding)
    for (const f of top) {
      const body = toCommentBody(f);
      try {
        await postLineComment(octokit, owner, repo, prNumber, headSha, f.path, f.end_line, body);
        console.log(`  ✅ Comment posted: ${f.path}:${f.end_line} — ${f.title}`);
      } catch (e: any) {
        console.log(`  ⚠️  Failed to post comment at ${f.path}:${f.end_line} — ${e.message?.slice(0, 200)}`);
      }
    }

    // Post a Checks summary
    const summaryMd =
      `**AI Code Review summary**\n\n` +
      `- Total posted: **${top.length}** (cap ${max})\n` +
      `- Severity: high **${counts.high}**, medium **${counts.medium}**, low **${counts.low}**\n\n` +
      (top.length
        ? top.map((f, i) => `${i + 1}. \`${f.path}:${f.start_line}-${f.end_line}\` — **${f.severity.toUpperCase()} ${f.category}** — ${escapeMd(f.title)}`).join("\n")
        : "_No material issues posted._");

    await createOrUpdateCheck(octokit, owner, repo, headSha, summaryMd);

    console.log("\n✅ Day 4 complete: comments + summary posted.");
  } catch (err: any) {
    core.setFailed(err.message);
  }
}

function escapeMd(s: string) { return s.replace(/[_*`]/g, (m) => "\\" + m); }

run();
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { getPRContext, getChangedFiles, getFileContentAtRef } from "./github.js";
import { parsePatchToHunks } from "./diff.js";
import { extractContextForRange, detectLang } from "./ast.js";

async function run() {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is missing");
    const octokit = new Octokit({ auth: token });

    const { owner, repo, prNumber, headSha } = getPRContext();
    const changed = await getChangedFiles(octokit, owner, repo, prNumber);

    console.log(`🔎 Reviewing PR #${prNumber} in ${owner}/${repo}`);
    for (const file of changed) {
      const lang = detectLang(file.filename);
      if (!["ts", "js"].includes(lang)) continue; // Day 2: only TS/JS

      // Get the latest file contents at the PR head
      const source = await getFileContentAtRef(octokit, owner, repo, file.filename, headSha);

      // Turn the unified diff patch into (start,end) line ranges
      const hunks = parsePatchToHunks(file.patch);
      if (hunks.length === 0) continue;

      console.log(`\n📄 ${file.filename}`);
      for (const h of hunks) {
        const ctx = extractContextForRange(file.filename, source, h.startLine, h.endLine);
        console.log(`  • Changed lines: ${h.startLine}-${h.endLine}`);
        console.log(`    Nearest: ${ctx.symbolType}${ctx.symbolName ? ` ${ctx.symbolName}` : ""}`);
        console.log(`    Snippet ${ctx.snippetStartLine}-${ctx.snippetEndLine}:\n${indent(ctx.snippet, 6)}`);
      }
    }

    console.log("\n✅ Day 2 complete: AST context + snippets printed.");
  } catch (err: any) {
    core.setFailed(err.message);
  }
}

function indent(text: string, n: number) {
  const pad = " ".repeat(n);
  return text.split("\n").map(l => pad + l).join("\n");
}

run();
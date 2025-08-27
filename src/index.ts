import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { getPRContext, getChangedFiles, getFileContentAtRef } from "./github.js";
import { parsePatchToHunks } from "./diff.js";
import { extractContextForRange, detectLang } from "./ast.js";
import { systemPrompt, buildUserPrompt, safeParseFindings } from "./prompts.js";
import { callModel } from "./model.js";

async function run() {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is missing");
    const octokit = new Octokit({ auth: token });

    const { owner, repo, prNumber, headSha } = getPRContext();
    const fullRepo = `${owner}/${repo}`;
    const changed = await getChangedFiles(octokit, owner, repo, prNumber);

    console.log(`🤖 Day 3: LLM dry-run review for PR #${prNumber} in ${fullRepo}`);

    for (const file of changed) {
      const lang = detectLang(file.filename);
      if (!["ts", "js"].includes(lang)) continue;

      const source = await getFileContentAtRef(octokit, owner, repo, file.filename, headSha);
      const hunks = parsePatchToHunks(file.patch);
      if (hunks.length === 0) continue;

      console.log(`\n📄 ${file.filename}`);

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

        // Call the model and print the JSON findings
        let raw = "[]";
        try {
          raw = await callModel(messages);
        } catch (e: any) {
          console.log(`  ⚠️  Model error: ${e.message?.slice(0, 200)}`);
          raw = "[]";
        }
        const findings = safeParseFindings(raw);

        console.log(`  • Changed lines ${h.startLine}-${h.endLine}`);
        if (findings.length === 0) {
          console.log("    (no material issues found)");
        } else {
          console.log("    Findings (JSON):");
          console.log(indent(JSON.stringify(findings, null, 2), 6));
        }
      }
    }

    console.log("\n✅ Day 3 complete: model-produced JSON printed (dry-run).");
  } catch (err: any) {
    core.setFailed(err.message);
  }
}

function indent(text: string, n: number) {
  const pad = " ".repeat(n);
  return text.split("\n").map(l => pad + l).join("\n");
}

run();
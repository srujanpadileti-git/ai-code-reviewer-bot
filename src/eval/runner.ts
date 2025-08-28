import fs from "node:fs";
import path from "node:path";
import { cases, type EvalCase } from "./cases.js";
import { runRules } from "../rules.js";
import type { Finding } from "../aggregator.js";

type Match = { ok: boolean; reason?: string };

function matchOne(expected: EvalCase["expect"][number], got: Finding): Match {
  if (got.start_line !== expected.line) return { ok: false, reason: `line mismatch: got ${got.start_line}` };
  if (got.category !== expected.category) return { ok: false, reason: `category mismatch: got ${got.category}` };
  if (expected.severity && got.severity !== expected.severity) {
    return { ok: false, reason: `severity mismatch: got ${got.severity}` };
  }
  if (expected.titleIncludes && !(got.title || "").toLowerCase().includes(expected.titleIncludes.toLowerCase())) {
    return { ok: false, reason: `title missing "${expected.titleIncludes}"` };
  }
  return { ok: true };
}

function runCase(c: EvalCase) {
  const findings: Finding[] = [];
  for (const ch of c.changes) {
    const f = runRules({
      path: c.path,
      source: c.source,
      startLine: ch.startLine,
      endLine: ch.endLine,
      allowConsole: false,
    });
    findings.push(...f);
  }

  const matched: boolean[] = new Array(c.expect.length).fill(false);
  const details: string[] = [];

  // Try to match each expected with any finding on that line/category (loose)
  c.expect.forEach((exp, i) => {
    const candidates = findings.filter((g) => g.start_line === exp.line && g.category === exp.category);
    if (candidates.length === 0) {
      details.push(`✗ expected ${exp.category} at line ${exp.line} — none found`);
      matched[i] = false;
      return;
    }
    // take the best candidate
    const best = candidates[0];
    const m = matchOne(exp, best);
    if (m.ok) {
      details.push(`✓ ${exp.category} at line ${exp.line} (${best.severity}) — "${best.title}"`);
      matched[i] = true;
    } else {
      details.push(`✗ ${exp.category} at line ${exp.line} — ${m.reason}`);
      matched[i] = false;
    }
  });

  // Count extra FPs (anything not matched by expectations)
  const expectedKeys = new Set(c.expect.map((e) => `${e.line}:${e.category}`));
  const extras = findings.filter((g) => !expectedKeys.has(`${g.start_line}:${g.category}`));

  return {
    name: c.name,
    tp: matched.filter(Boolean).length,
    fn: matched.filter((x) => !x).length,
    fp: extras.length,
    details,
  };
}

function writeReport(rows: ReturnType<typeof runCase>[]) {
  const totalTP = rows.reduce((a, r) => a + r.tp, 0);
  const totalFN = rows.reduce((a, r) => a + r.fn, 0);
  const totalFP = rows.reduce((a, r) => a + r.fp, 0);
  const recall = totalTP / (totalTP + totalFN || 1);
  const precision = totalTP / (totalTP + totalFP || 1);

  const lines: string[] = [];
  lines.push(`# AI Code Reviewer — Rules Evaluation`);
  lines.push(``);
  lines.push(`**Precision:** ${(precision * 100).toFixed(1)}%  |  **Recall:** ${(recall * 100).toFixed(1)}%`);
  lines.push(``);
  lines.push(`| Case | TP | FN | FP |`);
  lines.push(`| --- | ---: | ---: | ---: |`);
  for (const r of rows) {
    lines.push(`| ${r.name} | ${r.tp} | ${r.fn} | ${r.fp} |`);
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  for (const r of rows) {
    lines.push(`## ${r.name}`);
    for (const d of r.details) lines.push(`- ${d}`);
    lines.push(``);
  }

  const outDir = path.join(process.cwd(), ".aicr");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "eval_report.md");
  fs.writeFileSync(outPath, lines.join("\n"));
  return { outPath, precision, recall, totalTP, totalFN, totalFP };
}

async function main() {
  const results = cases.map(runCase);
  const { outPath, precision, recall } = writeReport(results);

  // Print a short console summary
  console.log(`Eval report written to ${outPath}`);
  console.log(`Precision ${(precision * 100).toFixed(1)}%  |  Recall ${(recall * 100).toFixed(1)}%`);

  // Exit non-zero if recall is very low (optional threshold)
  const minRecall = Number(process.env.MIN_RULES_RECALL || "0.5");
  if (recall < minRecall) {
    console.error(`Recall ${recall.toFixed(3)} < min ${minRecall}.`);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

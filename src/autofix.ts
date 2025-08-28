import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import type { Finding } from "./aggregator.js";

// What we consider “safe” to auto-fix by default
const DEFAULT_SAFE_CATEGORIES = new Set< Finding["category"] >(["style", "docs", "test", "performance"]);

export type FixPlan = {
  path: string;
  start: number;   // 1-based inclusive
  end: number;     // 1-based inclusive
  replacement: string[]; // lines to insert
  title: string;
};

export function collectFixes(
  findings: Finding[],
  opts: { allowedCats: Set<Finding["category"]>, maxLines: number }
): FixPlan[] {
  const plans: FixPlan[] = [];
  for (const f of findings) {
    // Require a suggestion block
    if (!f.suggestion || !f.suggestion.trim()) continue;
    // Category must be allowed and not high severity
    if (!opts.allowedCats.has(f.category)) continue;
    if (f.severity === "high") continue;

    const lineCount = Math.max(1, (f.end_line ?? f.start_line) - (f.start_line ?? 0) + 1);
    if (lineCount > opts.maxLines) continue;

    const replacement = f.suggestion.replace(/\r\n/g, "\n").split("\n");

    plans.push({
      path: f.path,
      start: f.start_line,
      end: f.end_line,
      replacement,
      title: f.title || "Auto-fix"
    });
  }

  // Dedupe overlapping fixes per file by keeping the earliest, stronger one
  const byFile = new Map<string, FixPlan[]>();
  for (const p of plans) {
    const arr = byFile.get(p.path) || [];
    arr.push(p);
    byFile.set(p.path, arr);
  }
  const merged: FixPlan[] = [];
  for (const [file, arr] of byFile) {
    arr.sort((a, b) => a.start - b.start);
    const keep: FixPlan[] = [];
    for (const p of arr) {
      if (keep.length === 0) { keep.push(p); continue; }
      const last = keep[keep.length - 1];
      if (p.start <= last.end) {
        // overlap — keep the earlier one (skip p)
        continue;
      }
      keep.push(p);
    }
    merged.push(...keep);
  }
  return merged;
}

export function applyFixesToDisk(root: string, fixes: FixPlan[]) {
  // Group by file and apply line replacements
  const byFile = new Map<string, FixPlan[]>();
  for (const p of fixes) {
    const arr = byFile.get(p.path) || [];
    arr.push(p);
    byFile.set(p.path, arr);
  }

  for (const [rel, arr] of byFile) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n");
    const lines = text.split("\n");

    // Apply from bottom to top so indexes don’t shift
    arr.sort((a, b) => b.start - a.start);

    let changed = false;
    for (const fix of arr) {
      const s = Math.max(1, fix.start) - 1;
      const e = Math.max(1, fix.end) - 1;
      lines.splice(s, e - s + 1, ...fix.replacement);
      changed = true;
    }
    if (changed) {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, lines.join("\n"));
    }
  }
}

export function gitCommitAndPush(headRef: string, actor: string, email: string, remoteUrlWithToken?: string) {
  const sh = (cmd: string) => cp.execSync(cmd, { stdio: "inherit" });

  // Make sure we’re on the PR branch
  try { sh(`git checkout ${headRef}`); } catch { /* already there */ }

  // Stage changes; if nothing changed, this will be empty
  sh("git add -A");
  try {
    sh(`git diff --cached --quiet`);
    console.log("ℹ️  No auto-fix changes to commit.");
    return null;
  } catch {
    // there are staged changes
  }

  // Configure author
  sh(`git config user.name "${actor}"`);
  sh(`git config user.email "${email}"`);

  // Commit
  const msg = `chore(ai-fix): apply safe auto-fixes (style/docs/test)\n\nAutomated by AI reviewer (Day 9).`;
  sh(`git commit -m "${msg.replace(/"/g, '\\"')}"`);

  // Set remote (if a token is provided, use it so the commit is authored by the token’s account)
  if (remoteUrlWithToken) {
    try { sh(`git remote set-url origin ${remoteUrlWithToken}`); } catch { /* ignore */ }
  }

  // Push to the same branch
  sh(`git push origin ${headRef}`);

  // Return latest commit SHA for summary
  const sha = cp.execSync("git rev-parse HEAD").toString().trim();
  return sha;
}

export function toAllowedCats(scope: Array<"style" | "docs" | "test" | "performance"> | undefined) {
  const s = new Set(DEFAULT_SAFE_CATEGORIES);
  if (scope && scope.length) {
    return new Set(scope);
  }
  return s;
}
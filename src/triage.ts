// src/triage.ts
import type { Octokit } from "@octokit/rest";
import type { Finding } from "./aggregator.js";

type DiffStats = { added: number; removed: number; changed: number };
type Triage = {
  sizeBucket: "XS" | "S" | "M" | "L" | "XL";
  linesChanged: number;
  filesChanged: number;
  languages: string[];   // ["ts","js","py","other"]
  areas: string[];       // ["security","deps","ci","tests","docs"]
  risk: "low" | "medium" | "high";
  labels: string[];
  notes: string[];
};

export type ChangedFile = {
  filename: string;
  patch?: string;
};

function diffStatsFromPatch(patch: string | undefined): DiffStats {
  if (!patch) return { added: 0, removed: 0, changed: 0 };
  let added = 0, removed = 0;
  for (const line of patch.split("\n")) {
    if (!line) continue;
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) continue;
    if (line[0] === "+") added++;
    else if (line[0] === "-") removed++;
  }
  return { added, removed, changed: added + removed };
}

function langOf(path: string): "ts"|"js"|"py"|"other" {
  if (/\.(ts|tsx)$/.test(path)) return "ts";
  if (/\.(m?js|jsx)$/.test(path)) return "js";
  if (/\.py$/.test(path)) return "py";
  return "other";
}

function sizeBucket(lines: number): Triage["sizeBucket"] {
  if (lines <= 20) return "XS";
  if (lines <= 60) return "S";
  if (lines <= 200) return "M";
  if (lines <= 500) return "L";
  return "XL";
}

function bumpRisk(r: Triage["risk"], to: Triage["risk"]) {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  return (rank[to] > rank[r]) ? to : r;
}

function isTest(path: string) {
  return /(^|\/)(test|tests|__tests__)\//.test(path) || /\.(spec|test)\.(t|j)sx?$/.test(path) || /_test\.py$/.test(path);
}
function isDoc(path: string) { return /\.md$/.test(path) || /^docs\//.test(path); }
function isCI(path: string) { return /^\.github\/workflows\//.test(path); }
function isDeps(path: string) {
  return /(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|pyproject\.toml|Pipfile|Pipfile\.lock)$/i.test(path);
}
function isSecuritySensitive(path: string) {
  return /(auth|secur|token|secret|crypto|Dockerfile|compose\.ya?ml|nginx|Caddyfile|server)/i.test(path);
}

export function computeTriage(changedFiles: ChangedFile[], findings: Finding[]): Triage {
  let total = 0;
  const langs = new Set<string>();
  const areas = new Set<string>();
  const notes: string[] = [];

  for (const f of changedFiles) {
    const { changed } = diffStatsFromPatch(f.patch);
    total += changed;
    const l = langOf(f.filename);
    langs.add(l);

    if (isTest(f.filename)) areas.add("tests");
    if (isDoc(f.filename)) areas.add("docs");
    if (isCI(f.filename)) areas.add("ci");
    if (isDeps(f.filename)) areas.add("deps");
    if (isSecuritySensitive(f.filename)) areas.add("security");
  }

  // Risk from findings
  let risk: Triage["risk"] = "low";
  if (findings.some((x) => x.severity === "high" || x.category === "security"))
    risk = bumpRisk(risk, "high");
  else if (findings.some((x) => x.severity === "medium"))
    risk = bumpRisk(risk, "medium");

  // Risk bumps from areas
  if (areas.has("deps") || areas.has("ci")) risk = bumpRisk(risk, "medium");
  if (areas.has("security")) risk = bumpRisk(risk, "high");

  const bucket = sizeBucket(total);
  const filesChanged = changedFiles.length;

  // Labels
  const labels: string[] = [];
  labels.push(`ai:risk-${risk}`);
  labels.push(`size:${bucket}`);
  const langsList = Array.from(langs);
  for (const l of langsList) {
    if (l === "ts" || l === "js" || l === "py") labels.push(`lang:${l}`);
  }
  for (const a of Array.from(areas)) labels.push(`area:${a}`);

  // Notes (for summary comment)
  if (areas.has("deps")) notes.push("Dependency files changed");
  if (areas.has("ci")) notes.push("CI workflow changed");
  if (areas.has("tests")) notes.push("Tests updated/added");
  if (areas.has("docs")) notes.push("Docs updated");
  if (areas.has("security")) notes.push("Security-sensitive files touched");

  return {
    sizeBucket: bucket,
    linesChanged: total,
    filesChanged,
    languages: langsList,
    areas: Array.from(areas),
    risk,
    labels,
    notes,
  };
}

const DEFAULT_LABELS: Array<{name: string; color: string; description: string}> = [
  { name: "ai:risk-high",   color: "d73a4a", description: "AI triage: high risk change" },
  { name: "ai:risk-medium", color: "dbab09", description: "AI triage: medium risk change" },
  { name: "ai:risk-low",    color: "0e8a16", description: "AI triage: low risk change" },
  { name: "size:XS", color: "ededed", description: "≤20 lines changed" },
  { name: "size:S",  color: "cfd3d7", description: "≤60 lines changed" },
  { name: "size:M",  color: "bfdadc", description: "≤200 lines changed" },
  { name: "size:L",  color: "b3c2f2", description: "≤500 lines changed" },
  { name: "size:XL", color: "b2a0fa", description: ">500 lines changed" },
  { name: "lang:ts", color: "0b61a4", description: "TypeScript change" },
  { name: "lang:js", color: "0366d6", description: "JavaScript change" },
  { name: "lang:py", color: "2b7489", description: "Python change" },
  { name: "area:security", color: "b60205", description: "Security-related area" },
  { name: "area:deps",     color: "5319e7", description: "Dependencies / lockfiles" },
  { name: "area:ci",       color: "1d76db", description: "CI / workflow" },
  { name: "area:tests",    color: "0e8a16", description: "Tests" },
  { name: "area:docs",     color: "bfdadc", description: "Documentation" },
];

async function ensureLabelsExist(octokit: Octokit, owner: string, repo: string, names: string[]) {
  // Best-effort: create missing labels; ignore errors if no permission
  const existing = new Set<string>();
  try {
    const list = await octokit.issues.listLabelsForRepo({ owner, repo, per_page: 100 });
    for (const l of list.data) existing.add(l.name);
  } catch {}
  for (const wanted of names) {
    if (existing.has(wanted)) continue;
    const meta = DEFAULT_LABELS.find((l) => l.name === wanted);
    if (!meta) continue;
    try {
      await octokit.issues.createLabel({ owner, repo, name: meta.name, color: meta.color, description: meta.description });
    } catch {}
  }
}

export async function applyTriage(octokit: Octokit, owner: string, repo: string, prNumber: number, triage: Triage, opts?: { comment?: boolean }) {
  // Add labels
  try {
    await ensureLabelsExist(octokit, owner, repo, triage.labels);
    await octokit.issues.addLabels({ owner, repo, issue_number: prNumber, labels: triage.labels });
  } catch (e) {
    console.log("⚠️  Could not apply labels (fork or perms). Continuing.");
  }

  if (opts?.comment) {
    const body = buildComment(triage);
    try {
      // Upsert: update previous triage comment if present
      const { data: comments } = await octokit.issues.listComments({ owner, repo, issue_number: prNumber, per_page: 100 });
      const header = "**AI Triage Report**";
      const mine = comments.find((c) => c.user?.type === "Bot" && c.body && c.body.includes(header));
      if (mine) {
        await octokit.issues.updateComment({ owner, repo, comment_id: mine.id, body });
      } else {
        await octokit.issues.createComment({ owner, repo, issue_number: prNumber, body });
      }
    } catch (e) {
      console.log("⚠️  Could not post triage comment (fork or perms).");
    }
  }
}

export function buildComment(t: Triage) {
  const bullets = [
    `- **Risk:** ${t.risk.toUpperCase()}  |  **Size:** ${t.sizeBucket}  |  **Files:** ${t.filesChanged}  |  **Lines:** ${t.linesChanged}`,
    `- **Languages:** ${t.languages.length ? t.languages.join(", ") : "—"}`,
    `- **Areas:** ${t.areas.length ? t.areas.join(", ") : "—"}`,
    t.notes.length ? `- **Notes:** ${t.notes.join("; ")}` : "",
    `- **Applied labels:** ${t.labels.join(", ")}`,
  ].filter(Boolean).join("\n");

  return [
    `**AI Triage Report**`,
    ``,
    bullets,
    ``,
    `_Tip: labels help codeowners & reviewers focus the right eyes on your PR._`
  ].join("\n");
}
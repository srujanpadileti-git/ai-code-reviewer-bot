import picomatch from "picomatch";

export type ReviewConfig = {
  skipAll: boolean;
  dryRun: boolean;
  maxComments: number;
  onlyGlobs: string[];
  skipGlobs: string[];
  allowFile: (p: string) => boolean;
  // metrics
  costInPer1K: number;   // optional: $ per 1k prompt tokens
  costOutPer1K: number;  // optional: $ per 1k completion tokens
};

function parseIntFromLabel(labels: string[], prefix: string, fallback: number) {
  const hit = labels.find(l => l.startsWith(prefix));
  if (!hit) return fallback;
  const n = parseInt(hit.slice(prefix.length), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseCsvFromLabel(labels: string[], prefix: string): string[] {
  const hit = labels.find(l => l.startsWith(prefix));
  if (!hit) return [];
  const csv = hit.slice(prefix.length).trim();
  return csv ? csv.split(",").map(s => s.trim()).filter(Boolean) : [];
}

export function buildConfig(labels: string[], env: NodeJS.ProcessEnv): ReviewConfig {
  const skipAll = labels.includes("ai-review:skip") || env.SKIP_ALL === "1";
  const dryRun  = labels.includes("ai-review:dry-run") || env.DRY_RUN === "1";

  // Max comments: env → label (label wins so reviewers can change per-PR)
  let maxComments = parseInt(env.MAX_COMMENTS || "10", 10);
  maxComments = parseIntFromLabel(labels, "ai-review:max-", maxComments);

  // File filters (labels override env)
  const onlyFromEnv = (env.ONLY || "").split(",").map(s => s.trim()).filter(Boolean);
  const skipFromEnv = (env.SKIP || "").split(",").map(s => s.trim()).filter(Boolean);

  const onlyGlobs = parseCsvFromLabel(labels, "ai-review:only=") || onlyFromEnv;
  const skipGlobs = parseCsvFromLabel(labels, "ai-review:skip-paths=") || skipFromEnv;

  // Build allow function
  const allow = onlyGlobs.length ? picomatch(onlyGlobs) : () => true;
  const deny  = skipGlobs.length ? picomatch(skipGlobs) : () => false;

  const allowFile = (p: string) => allow(p) && !deny(p);

  // Optional pricing for cost estimate (0 = disabled)
  const costInPer1K  = Number(env.COST_IN_PER_1K || 0);
  const costOutPer1K = Number(env.COST_OUT_PER_1K || 0);

  return { skipAll, dryRun, maxComments, onlyGlobs, skipGlobs, allowFile, costInPer1K, costOutPer1K };
}
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

function parseManyFromLabels(labels: string[], prefix: string): string[] {
  // Collect all labels that start with the prefix, and also allow comma-separated lists in any of them
  const hits = labels.filter(l => l.startsWith(prefix));
  const parts = hits.flatMap(l => l.slice(prefix.length).split(","));
  return parts.map(s => s.trim()).filter(Boolean);
}

export function buildConfig(labels: string[], env: NodeJS.ProcessEnv): ReviewConfig {
  const skipAll = labels.includes("ai-review:skip") || env.SKIP_ALL === "1";
  const dryRun  = labels.includes("ai-review:dry-run") || env.DRY_RUN === "1";

  // max comments
  let maxComments = parseInt(env.MAX_COMMENTS || "10", 10);
  const maxHit = labels.find(l => l.startsWith("ai-review:max-"));
  if (maxHit) {
    const n = parseInt(maxHit.slice("ai-review:max-".length), 10);
    if (Number.isFinite(n) && n > 0) maxComments = n;
  }

  // ENV patterns
  const onlyFromEnv = (env.ONLY || "").split(",").map(s => s.trim()).filter(Boolean);
  const skipFromEnv = (env.SKIP || "").split(",").map(s => s.trim()).filter(Boolean);

  // Labels with explicit patterns (no * allowed in label names, but we still parse if present)
  const onlyFromLabels = parseManyFromLabels(labels, "ai-review:only=");
  const skipFromLabels = parseManyFromLabels(labels, "ai-review:skip-paths=");

  // Shorthand labels → real globs (safe characters only)
  const shorthandMap: Record<string, string[]> = {
    "ai-review:only-src-ts": ["src/**/*.ts"],
    "ai-review:only-lib-js": ["lib/**/*.js"],
    "ai-review:skip-dist": ["dist/**"],
    "ai-review:skip-minjs": ["**/*.min.js"],
    "ai-review:skip-node_modules": ["node_modules/**"],
    "ai-review:skip-lockfiles": ["**/*.lock", "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock"],
  };
  const shorthandOnly: string[] = [];
  const shorthandSkip: string[] = [];
  for (const label of labels) {
    const globs = shorthandMap[label];
    if (!globs) continue;
    if (label.startsWith("ai-review:only-")) shorthandOnly.push(...globs);
    if (label.startsWith("ai-review:skip-")) shorthandSkip.push(...globs);
  }

  const onlyGlobs = [...onlyFromEnv, ...onlyFromLabels, ...shorthandOnly];
  const skipGlobs = [...skipFromEnv, ...skipFromLabels, ...shorthandSkip];

  const allow = onlyGlobs.length ? picomatch(onlyGlobs) : () => true;
  const deny  = skipGlobs.length ? picomatch(skipGlobs) : () => false;
  const allowFile = (p: string) => allow(p) && !deny(p);

  const costInPer1K  = Number(env.COST_IN_PER_1K || 0);
  const costOutPer1K = Number(env.COST_OUT_PER_1K || 0);

  return { skipAll, dryRun, maxComments, onlyGlobs, skipGlobs, allowFile, costInPer1K, costOutPer1K };
}
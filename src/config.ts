import picomatch from "picomatch";

/** Categories your pipeline understands for auto-fix scope */
type FixCategory = "style" | "docs" | "test" | "performance";

export type ReviewConfig = {
  // Core controls
  skipAll: boolean;
  dryRun: boolean;
  maxComments: number;

  // Path filtering
  onlyGlobs: string[];
  skipGlobs: string[];
  allowFile: (p: string) => boolean;

  // Cost estimate (optional)
  costInPer1K: number;
  costOutPer1K: number;

  // Rules engine (Day 7)
  rulesEnabled: boolean;
  rulesOnly: boolean;
  allowConsole: boolean;

  // Auto-fix (Day 9)
  autoFix: boolean;
  fixScopes: FixCategory[];
  maxFixLines: number;

  // Performance budgets (Day 10)
  maxModelCalls: number;
  timeBudgetSec: number;
  tokenBudget: number;
  maxParallel: number;
  useCache: boolean;
};

function parseManyFromLabels(labels: string[], prefix: string): string[] {
  // Collect all labels that start with the prefix, allow comma-separated lists within any of them
  const hits = labels.filter((l) => l.startsWith(prefix));
  const parts = hits.flatMap((l) => l.slice(prefix.length).split(","));
  return parts.map((s) => s.trim()).filter(Boolean);
}

function pickMaxFromLabel(labels: string[], prefix: string): number | null {
  const hit = labels.find((l) => l.startsWith(prefix));
  if (!hit) return null;
  const n = parseInt(hit.slice(prefix.length), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function buildConfig(labels: string[], env: NodeJS.ProcessEnv): ReviewConfig {
  // Base toggles
  const skipAll = labels.includes("ai-review:skip") || env.SKIP_ALL === "1";
  const dryRun = labels.includes("ai-review:dry-run") || env.DRY_RUN === "1";

  // Max comments (env default, label override like ai-review:max-20)
  let maxComments = parseInt(env.MAX_COMMENTS || "10", 10);
  const maxFromLabel = pickMaxFromLabel(labels, "ai-review:max-");
  if (maxFromLabel) maxComments = maxFromLabel;

  // Path filters from ENV
  const onlyFromEnv = (env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
  const skipFromEnv = (env.SKIP || "").split(",").map((s) => s.trim()).filter(Boolean);

  // Explicit patterns from labels (note: GitHub labels often can't contain '*', but we still parse in case)
  const onlyFromLabels = parseManyFromLabels(labels, "ai-review:only=");
  const skipFromLabels = parseManyFromLabels(labels, "ai-review:skip-paths=");

  // Shorthand labels → real globs (safe names, no '*')
  const shorthandMap: Record<string, string[]> = {
    // JS/TS
    "ai-review:only-src-ts": ["src/**/*.ts"],
    "ai-review:only-lib-js": ["lib/**/*.js"],
    "ai-review:skip-dist": ["dist/**"],
    "ai-review:skip-minjs": ["**/*.min.js"],
    "ai-review:skip-node_modules": ["node_modules/**"],
    "ai-review:skip-lockfiles": ["**/*.lock", "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock"],
    // Python (Day 8)
    "ai-review:only-py": ["**/*.py"],
    "ai-review:skip-py": ["**/*.py"],
    // Index artifacts
    "ai-review:skip-aicr": [".aicr/**"],
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

  // Build path allow/deny matchers
  const allowMatcher = onlyGlobs.length ? picomatch(onlyGlobs) : () => true;
  const denyMatcher = skipGlobs.length ? picomatch(skipGlobs) : () => false;
  const allowFile = (p: string) => allowMatcher(p) && !denyMatcher(p);

  // Optional pricing for summaries
  const costInPer1K = Number(env.COST_IN_PER_1K || 0);
  const costOutPer1K = Number(env.COST_OUT_PER_1K || 0);

  // Rules toggles (Day 7)
  const rulesOnly = labels.includes("ai-review:rules-only") || env.RULES_ONLY === "1";
  const rulesEnabled = !labels.includes("ai-review:no-rules") && env.NO_RULES !== "1";
  const allowConsole = labels.includes("ai-review:allow-console") || env.ALLOW_CONSOLE === "1";

  // Auto-fix (Day 9)
  const autoFix = labels.includes("ai-review:auto-fix") || env.AUTO_FIX === "1";

  // FIX_SCOPE can be env "style,docs,test,performance" or label(s) "ai-review:fix-scope=style,docs"
  const scopeFromEnv = (env.FIX_SCOPE || "").split(",").map((s) => s.trim()).filter(Boolean);
  // If parseManyFromLabels exists here (it does), allow labels too
  const scopeFromLabels = parseManyFromLabels(labels, "ai-review:fix-scope=");
  const mergedScopes = (scopeFromLabels.length ? scopeFromLabels : scopeFromEnv) as FixCategory[];
  const fixScopes: FixCategory[] = mergedScopes.length ? mergedScopes : ["style", "docs", "test"];
  const maxFixLines = Number(env.MAX_FIX_LINES || "20");

  // Performance budgets (Day 10) — defaults from env
  let maxModelCalls = Number(env.MAX_MODEL_CALLS || "12");
  let timeBudgetSec = Number(env.TIME_BUDGET_S || "60");
  let tokenBudget = Number(env.TOKEN_BUDGET || "20000"); // soft cap
  let maxParallel = Math.max(1, Number(env.MAX_PARALLEL || "3"));
  let useCache = (env.USE_CACHE || "1") === "1";

  // Preset labels
  if (labels.includes("ai-review:fast")) {
    maxModelCalls = Math.min(maxModelCalls, 6);
    timeBudgetSec = Math.min(timeBudgetSec, 30);
    tokenBudget = Math.min(tokenBudget, 10000);
    maxParallel = Math.max(2, Math.min(maxParallel, 3));
  }
  if (labels.includes("ai-review:thorough")) {
    maxModelCalls = Math.max(maxModelCalls, 24);
    timeBudgetSec = Math.max(timeBudgetSec, 120);
    tokenBudget = Math.max(tokenBudget, 40000);
    maxParallel = Math.max(maxParallel, 5);
  }
  if (labels.includes("ai-review:no-cache")) {
    useCache = false;
  }

  return {
    // core
    skipAll,
    dryRun,
    maxComments,

    // paths
    onlyGlobs,
    skipGlobs,
    allowFile,

    // cost
    costInPer1K,
    costOutPer1K,

    // rules
    rulesEnabled,
    rulesOnly,
    allowConsole,

    // auto-fix
    autoFix,
    fixScopes,
    maxFixLines,

    // performance
    maxModelCalls,
    timeBudgetSec,
    tokenBudget,
    maxParallel,
    useCache,
  };
}
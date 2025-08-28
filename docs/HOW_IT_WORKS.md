# 🧠 How It Works

This doc explains the end-to-end flow of the **AI Code Reviewer** GitHub Action — from detecting changes, to rules + LLM review, to optional auto-fix, triage labels, and the final report.

For feature lists & configuration knobs, see **[FEATURES.md](./FEATURES.md)**.  
For quick start and repo layout, see the **README**.

---

## 🗺️ High-Level Pipeline

    Pull Request
       │
       ├─ 1) Collect changed files + diff hunks
       │
       ├─ 2) Rules pass (deterministic, zero tokens)
       │
       ├─ 3) (Optional) Build/load RAG index, retrieve Top-K related chunks
       │
       ├─ 4) LLM review per hunk → JSON findings
       │
       ├─ 5) Aggregate (rank, dedupe, cap)
       │
       ├─ 6) (Optional) Auto-fix: apply safe patches, commit & push to PR branch
       │
       ├─ 7) Triage: risk/size/languages/areas → labels + triage comment
       │
       └─ 8) Checks summary: counts, tokens, time, budgets, RAG stats, top items

Everything is orchestrated by **`src/index.ts`** with helpers in **`src/`**.

---

## 🔩 Core Components

### 1) Diff collection (GitHub API)
- Fetch **changed files** and each file’s **unified patch** from the PR.
- Split patches into **hunks** (`@@ -old,+new @@`) so we review **only** affected line ranges.
- Apply file-path filters early (`ONLY`, `SKIP`, and shorthand labels).

### 2) Rules engine — `src/rules.ts`
Deterministic checks on **changed lines** (fast & zero-token). Examples:
- **Security:** `eval`, `child_process.exec*`, `subprocess(..., shell=True)`, `os.system`, insecure `http://`, `yaml.load` without `SafeLoader`, weak hashes, suspicious tokens/keys
- **Reliability / Perf:** missing timeouts in `fetch` / `requests`
- **Style:** noisy `console.log` / `print`, TypeScript `any`, etc.

Each rule yields a structured **Finding** (shape used across the pipeline):

    export type Finding = {
      path: string;
      start_line: number;
      end_line: number;
      category: "security" | "style" | "performance" | "docs" | "test";
      severity: "high" | "medium" | "low";
      title: string;
      rationale: string;
      suggestion?: string; // may be auto-applied if safe & small
    };

Rules always run first; their results are later merged with LLM findings.

### 3) RAG (retrieval-augmented generation) — `src/context.ts`
Purpose: give the model **local repo context** (nearby functions/types) so suggestions are accurate.

- **Indexing:** parse files with **Tree-sitter** (JS/TS/Python) and chunk by **symbol** (function/method/class).  
  For each chunk store: `path`, `startLine`, `endLine`, `symbolType`, `symbolName`, `snippet`, and an **embedding**.
- **Storage:** `.aicr/repo_index.json` in the workspace (auto-built on demand).
- **Retrieval:** for each hunk, embed the snippet and fetch Top-K similar chunks (`RAG_K`).

Fail-open: if embeddings are rate-limited or unavailable, continue **without RAG** (the review still runs).

### 4) LLM review — `src/model.ts` + `src/prompts.ts`
- Prompt = **system guidance** + **user payload** with file path, changed range, pretty-printed snippet, and any RAG chunks.
- The model is instructed to return a **JSON array** of findings (same shape as above).
- A tolerant parser validates & cleans the JSON; malformed items are dropped.

### 5) Aggregation & capping — `src/aggregator.ts`
- Combines rule & LLM findings, dedupes near-duplicates, sorts by severity/signal, and applies a hard cap (`MAX_COMMENTS`).
- Only the **top** N items proceed to posting.

### 6) Auto-fix (optional) — `src/autofix.ts`
- Enable via the label `ai-review:auto-fix` or env `AUTO_FIX="1"`.
- Collect **safe** replacements from findings whose category is allowed by `FIX_SCOPE` (default: `style,docs,test,performance`) and whose line span ≤ `MAX_FIX_LINES`.
- Apply edits to the checked-out workspace, **commit**, and **push** to the PR branch.
- Use `REVIEWER_TOKEN` (if set) so the commit is authored as **you** (great for contribution graphs). If pushing isn’t allowed (e.g., fork PR without permissions), log a warning and continue.

### 7) Triage & labels — `src/triage.ts`
- Compute **risk** (low/medium/high), **size** (XS–XL), **languages** (`lang:ts/js/py`), and **areas** (`area:security/ci/deps/tests/docs`) from patches and findings.
- Ensure labels exist (best-effort), apply them to the PR, and post an **AI Triage Report** comment (toggle with `TRIAGE` / `TRIAGE_COMMENT`).

### 8) Checks summary — `createOrUpdateCheck(...)`
Posts a single summary with:
- counts by severity
- runtime in seconds
- token usage (prompt/out/total)
- optional $ estimate (if `COST_IN_PER_1K` / `COST_OUT_PER_1K` are set)
- RAG stats (index size, Top-K)
- auto-fix status (commit SHA if pushed)
- budgets status (calls, cache on/off, parallelism)

---

## ⚡ Performance Model

To keep runs fast and cheap:

- **Budgets** (early-stop):
  - `MAX_MODEL_CALLS` — limit total LLM invocations
  - `TIME_BUDGET_S` — wall-clock time cap
  - `TOKEN_BUDGET` — soft cap; when exceeded, stop scheduling new model tasks
- **Parallelism:** model tasks run via `p-limit` with `MAX_PARALLEL`
- **Cache:** `.aicr/cache.json` (keyed by `sha1(model + messages)`) with TTL `CACHE_TTL_HOURS`
- **Presets:** labels `ai-review:fast` and `ai-review:thorough` tune these automatically

---

## 🔐 Data Minimization & Security

- Send only the **changed snippet** plus a few tiny **related chunks** (if RAG on).
- Secrets detection runs before model calls to reduce leakage.
- API keys live in **Actions Secrets** (`OPENAI_API_KEY`, optional `REVIEWER_TOKEN`).
- On **forked PRs** where comments/labels/commits are restricted, operations are skipped gracefully (job still passes).

---

## 🔁 Failure Modes & “Fail-Open” Strategy

- **Embeddings 429 / outage:** skip RAG, continue with rules + LLM on snippet.
- **Model error for a hunk:** log, skip that hunk, continue others.
- **Push denied (no perms):** skip auto-fix push; still post comments/summary.
- **Cache I/O issues:** run without cache.
- **JSON parse issues:** drop the malformed item; keep the rest.

---

## 🧩 Extension Points

- **Rules:** add checks to `src/rules.ts` (return a `Finding` with rationale + suggestion).
- **Languages:** add a grammar in `src/ast.ts`, update `detectLang`, and include extensions in `src/context.ts` indexing.
- **Prompting:** tweak tone/constraints in `src/prompts.ts`; parser expects a JSON array.
- **Auto-fix:** widen `FIX_SCOPE` or add category-specific patchers in `src/autofix.ts`.
- **Outputs:** add SARIF export or annotations in `src/suggestions.ts` / `src/index.ts`.

---

## 🧭 File Map (where things live)

    src/
      index.ts        → main pipeline (orchestration)
      rules.ts        → deterministic checks (JS/TS + Python)
      ast.ts          → Tree-sitter parsing & symbol chunking
      context.ts      → RAG index build/load + retrieval
      embeddings.ts   → embedding client (quota-aware)
      model.ts        → chat model caller
      prompts.ts      → system/user prompts (JSON contract)
      aggregator.ts   → rank/dedupe/cap findings
      suggestions.ts  → render markdown comments
      github.ts       → PR files, comments, Checks, head ref
      config.ts       → env + labels → runtime config
      autofix.ts      → collect/apply safe edits + commit/push
      cache.ts        → disk cache (hash → model output)
      triage.ts       → risk/size/lang/areas labels + report
      eval/
        cases.ts      → sample rule tests
        runner.ts     → writes .aicr/eval_report.md

---

## 🧪 Dev Loop Tips

- Work on **rules** first (fast feedback, zero tokens).  
  Use `npm run eval` to see precision/recall and iterate.
- When testing LLM prompts, lower budgets (`ai-review:fast`) and keep cache on (`USE_CACHE=1`) to avoid repeated spend.
- Disable RAG with `RAG_K=0` for speed while prototyping prompts.

---

## ✅ End-to-End Summary

The action reviews only what changed, blends **cheap deterministic checks** with **LLM suggestions** enriched by **RAG**, optionally **auto-fixes** trivial issues, **labels** the PR for triage, and posts a single **Checks** summary with metrics and costs — all under **strict budgets** with caching for repeat runs.

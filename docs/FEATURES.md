# ✨ Features

This document is the **deep-dive** for the AI Code Reviewer. For an end-to-end overview of the pipeline, see **[HOW_IT_WORKS.md](./HOW_IT_WORKS.md)**.  
For quick setup and usage, see the main **README**.

---

## 1) 🔎 Rules Engine (JS/TS + Python)

High-signal, deterministic checks that run on **changed lines only** (so they’re fast and low-noise). Each finding includes:
- `category` (`security | style | performance | docs | test`)
- `severity` (`high | medium | low`)
- `title`, `rationale`, and a concrete `suggestion`

**Examples of built-ins**
- **Security**
  - Dangerous execution: `eval`, `Function`, `child_process.exec*`, `subprocess.run(..., shell=True)`, `os.system`
  - Insecure network: `http://` URLs where `https://` is expected
  - Unsafe parsing: `yaml.load` without `SafeLoader`, `pickle.loads`
  - Weak crypto / secrets: weak hashes, suspicious tokens (AWS, GitHub, OpenAI) in code
- **Reliability / Performance**
  - Missing timeouts: `fetch(...)`, `requests.get(...)` without a timeout
- **Style / Maintainability**
  - Noisy logs on committed code: `console.log`, `print` (toggleable)
  - TypeScript `any` usage in public APIs

Rules run **before** any model calls (zero tokens) and findings are merged with the LLM results.

---

## 2) 💬 LLM Suggestions with RAG (optional)

When not in `rules-only` mode, the reviewer asks a chat model to propose improvements:

- **Prompt window**: the changed **snippet** (with a context window), file path, and line numbers
- **RAG**: fetches Top-K **related code chunks** from a lightweight repository index so the model understands surrounding APIs and patterns
- **Structured output**: the model returns a JSON array of findings; we parse, validate, and cap the results

> If embeddings are rate-limited or unavailable, the run **fails open** (continues **without** RAG).

---

## 3) 🛠️ Auto-Fix (optional)

Enable via the **`ai-review:auto-fix`** PR label or `AUTO_FIX="1"` in workflow env.

- Applies **small, safe** replacements (default scopes: `style`, `docs`, `test`, `performance`)
- Guardrails:
  - `MAX_FIX_LINES` per finding
  - Overlap dedupe (skips conflicting edits)
  - Restrict by category via `FIX_SCOPE` (e.g., `style,docs`)
- Commits and **pushes to the PR branch**  
  If you provide `REVIEWER_TOKEN` (a fine-grained PAT), commits & comments are authored **as you** (nice for contribution graphs).

---

## 4) ⚡ Speed, Budgets & Cache

- **Budgets** (early-stop):
  - `MAX_MODEL_CALLS`: limit total chat calls for a run
  - `TIME_BUDGET_S`: time cap in seconds
  - `TOKEN_BUDGET`: soft cap on total tokens (stops scheduling new tasks when reached)
- **Parallelism**: `MAX_PARALLEL` controls concurrent model calls (via `p-limit`)
- **Cache**: disk cache in `.aicr/cache.json` keyed by `sha1(model + messages)`  
  Configure TTL with `CACHE_TTL_HOURS`. Use label `ai-review:no-cache` to bypass.

**Presets (labels)**
- `ai-review:fast` → tighter budgets for quick feedback
- `ai-review:thorough` → larger budgets for deeper review

---

## 5) 🏷️ PR Triage & Labels

Every PR gets a quick triage:

- **Risk**: `ai:risk-low | ai:risk-medium | ai:risk-high`  
  (computed from rule severities and touched areas)
- **Size**: `size:XS | S | M | L | XL` (based on lines added+removed)
- **Languages**: `lang:ts`, `lang:js`, `lang:py`
- **Areas**: `area:security`, `area:deps`, `area:ci`, `area:tests`, `area:docs`

Also posts an **AI Triage Report** comment (toggle with `TRIAGE_COMMENT`).

> On forked PRs where labels/comments are blocked by repo policy, the action logs a warning and continues.

---

## 6) 📊 Evaluation Harness (rules precision/recall)

A tiny testbed to measure rule quality across curated cases:

- Add/edit cases in `src/eval/cases.ts` (JS/TS + Python examples included)
- Run locally: `npm run eval` → writes `.aicr/eval_report.md` and prints precision/recall
- CI workflow `eval.yml` uploads the artifact and comments a table on the PR

Great for incremental improvements — each new case can be a quick PR.

---

## ⚙️ Configuration & Labels

### Core environment variables

| Name | Purpose | Example |
|---|---|---|
| `CHAT_MODEL` | LLM used for review | `gpt-4o-mini` |
| `EMBEDDING_MODEL` | Embedding model for RAG | `text-embedding-3-small` |
| `ONLY` / `SKIP` | File globs (picomatch) | `ONLY="src/**/*.ts,**/*.py"` / `SKIP="dist/**,**/*.min.js"` |
| `MAX_COMMENTS` | Cap posted comments | `10` |
| `DRY_RUN` | Log findings without posting | `0` or `1` |

### RAG

| Name | Purpose | Example |
|---|---|---|
| `RAG_K` | Top-K related chunks (0 disables RAG) | `6` |

### Auto-Fix

| Name | Purpose | Example |
|---|---|---|
| `AUTO_FIX` | Enable auto-fix | `0` or `1` |
| `FIX_SCOPE` | Allowed categories to fix | `style,docs,test,performance` |
| `MAX_FIX_LINES` | Max replaced lines per finding | `20` |

### Performance (speed & cost)

| Name | Purpose | Example |
|---|---|---|
| `MAX_MODEL_CALLS` | Limit chat calls | `12` |
| `TIME_BUDGET_S` | Time cap (seconds) | `60` |
| `TOKEN_BUDGET` | Soft token cap | `20000` |
| `MAX_PARALLEL` | Concurrency for chat | `3` |
| `USE_CACHE` | Enable cache | `1` |
| `CACHE_TTL_HOURS` | Cache TTL | `168` |

### Triage

| Name | Purpose | Example |
|---|---|---|
| `TRIAGE` | Enable label application | `1` |
| `TRIAGE_COMMENT` | Post triage comment | `1` |

### Optional cost lines in Checks summary

| Name | Purpose | Example |
|---|---|---|
| `COST_IN_PER_1K` | $ per 1k prompt tokens (for estimate only) | `0.15` |
| `COST_OUT_PER_1K` | $ per 1k completion tokens | `0.60` |

---

## 🎛️ Handy PR Labels (in-PR controls)

**Control**
- `ai-review:skip` — skip the run
- `ai-review:dry-run` — don’t post comments
- `ai-review:max-20` — cap posted comments to 20

**Rules**
- `ai-review:rules-only` — run only rules (no LLM)
- `ai-review:no-rules` — disable rules
- `ai-review:allow-console` — allow `console.log`/`print`

**Scope (shorthands)**
- `ai-review:only-src-ts`, `ai-review:only-py`
- `ai-review:skip-dist`, `ai-review:skip-node_modules`, `ai-review:skip-aicr`

**Performance**
- `ai-review:fast`, `ai-review:thorough`, `ai-review:no-cache`

**Auto-Fix**
- `ai-review:auto-fix`
- `ai-review:fix-scope=style,docs`

---

## 🔐 Security & Privacy

- Sends only the **changed code snippet** and a few small **related chunks** to the LLM.
- Secrets detection runs **before** model calls to reduce accidental leakage.
- Store keys in **GitHub Actions Secrets** (`OPENAI_API_KEY`, optional `REVIEWER_TOKEN`).
- The bot flags hardcoded keys/tokens in code.

---

## 🧩 Example `env` block (from workflow)

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  REVIEWER_TOKEN: ${{ secrets.REVIEWER_TOKEN }}   # optional (authored as you)
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}

  CHAT_MODEL: gpt-4o-mini
  EMBEDDING_MODEL: text-embedding-3-small

  ONLY: "src/**/*.ts,lib/**/*.js,**/*.py"
  SKIP: "dist/**,**/*.min.js,node_modules/**,.aicr/**"

  # RAG
  RAG_K: "6"

  # Budgets
  MAX_MODEL_CALLS: "12"
  TIME_BUDGET_S: "60"
  TOKEN_BUDGET: "20000"
  MAX_PARALLEL: "3"
  USE_CACHE: "1"
  CACHE_TTL_HOURS: "168"

  # Auto-fix
  AUTO_FIX: "0"
  FIX_SCOPE: "style,docs,test"
  MAX_FIX_LINES: "20"

  # Triage
  TRIAGE: "1"
  TRIAGE_COMMENT: "1"

  # Optional cost estimate
  COST_IN_PER_1K: "0"
  COST_OUT_PER_1K: "0"

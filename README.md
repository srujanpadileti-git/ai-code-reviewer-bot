# 🤖 AI Code Reviewer
_A lightweight GitHub Action that reviews pull requests with LLMs + rules — and can even auto-fix safe issues._

---

## 📖 Overview
AI Code Reviewer leaves inline comments on your PRs using:
- **Deterministic rules** (security & best practices) for JS/TS & Python
- **LLM suggestions** with optional repo **RAG** context
- Optional **Auto-fix** that pushes small, safe edits to your PR branch
- **PR triage**: adds labels for risk, size, languages, and areas (e.g., security, tests)

> Want details? See **[FEATURES](./docs/FEATURES.md)** and **[HOW IT WORKS](./docs/HOW_IT_WORKS.md)**.

---

## 🧰 Tech Stack
- **Runtime:** Node.js (TypeScript)
- **Parsing:** Tree-sitter (JS/TS/Python)
- **LLM/RAG:** OpenAI Chat + Embeddings
- **CI:** GitHub Actions

---

## 🚀 Getting Started
1. **Fork or clone** this repo into your project.
2. **Add secrets** (GitHub ➜ _Settings_ ➜ _Secrets and variables_ ➜ _Actions_ ➜ _New repository secret_):
   - `OPENAI_API_KEY` (required)
   - `REVIEWER_TOKEN` (optional PAT to post comments/commits as **you**)
3. Ensure the workflow file exists: `.github/workflows/review.yml` (included in this repo).
4. Open or update a **pull request** — the action runs automatically.

---

## 🕹️ How to Use
- Push commits to your PR; the bot will:
  - Run **rules** on changed lines,
  - (Optionally) call the **LLM** with RAG,
  - Post **inline comments** and a **Checks** summary,
  - (If enabled) push an **auto-fix commit**,
  - Apply **labels** and post a brief **AI Triage Report**.
- Handy labels (add to the PR):
  - `ai-review:auto-fix` – apply safe changes and push
  - `ai-review:fast` / `ai-review:thorough` – speed vs depth
  - `ai-review:rules-only` – skip LLM calls (zero tokens)
  - `ai-review:skip-dist`, `ai-review:only-py`, etc. – scope files

> Full label list & env knobs: **[FEATURES ➜ Configuration & Labels](./docs/FEATURES.md#configuration--labels)**

---

## 🗂️ Project Structure

```text
.
├─ src/
│  ├─ index.ts          # Action entry (pipeline)
│  ├─ rules.ts          # Deterministic checks (JS/TS + Python)
│  ├─ ast.ts            # Tree-sitter parsing & symbol chunking
│  ├─ context.ts        # RAG index & retrieval
│  ├─ embeddings.ts     # Embedding client (fail-open on quota)
│  ├─ model.ts          # Chat model caller
│  ├─ prompts.ts        # System & user prompts
│  ├─ suggestions.ts    # Markdown formatting for comments
│  ├─ aggregator.ts     # Rank/dedupe/cap findings
│  ├─ github.ts         # GitHub helpers (files, checks, comments)
│  ├─ config.ts         # Env + label configuration
│  ├─ autofix.ts        # Plan/apply/push safe edits
│  ├─ cache.ts          # Disk cache for model outputs
│  ├─ triage.ts         # Labels + triage comment
│  └─ eval/
│     ├─ cases.ts       # Sample rule test cases
│     └─ runner.ts      # Writes .aicr/eval_report.md
├─ .github/workflows/
│  ├─ review.yml        # Main reviewer workflow
│  └─ eval.yml          # Optional rules evaluation
└─ docs/
   ├─ FEATURES.md
   └─ HOW_IT_WORKS.md

AI Code Reviewer — LLM + Rules + RAG + Auto-Fix for GitHub PRs

A production-ready GitHub Action that reviews pull requests with:
- LLM suggestions (JS/TS + Python) with optional RAG repo context
- Deterministic rules (security + best practices) that run on changed lines
- Optional Auto-fix that pushes safe edits to the PR branch
- Budgets & caching for speed/cost control
- PR triage & labels (risk, size, languages, areas) with a summary comment
- A tiny evaluation harness to track precision/recall of rules

Quick Start:
1. Clone this repo (or copy the src/ and .github/workflows/ to your project).
2. Add secrets (repo → Settings → Secrets and variables → Actions → New repository secret):
   - OPENAI_API_KEY — for LLM + embeddings
3. Drop the review workflow (or keep ours: .github/workflows/review.yml)
4. Add eval workflow for rules report:
.github/workflows/eval.yml
5. Open or update a PR and watch:
   - Inline comments (rules + LLM)
   - A Checks summary with metrics
   - Labels & a triage comment
   - (If enabled) an auto-fix commit on your PR branch

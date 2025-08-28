AI Code Reviewer — LLM + Rules + RAG + Auto-Fix for GitHub PRs

A production-ready GitHub Action that reviews pull requests with:
- LLM suggestions (JS/TS + Python) with optional RAG repo context
- Deterministic rules (security + best practices) that run on changed lines
- Optional Auto-fix that pushes safe edits to the PR branch
- Budgets & caching for speed/cost control
- PR triage & labels (risk, size, languages, areas) with a summary comment
- A tiny evaluation harness to track precision/recall of rules

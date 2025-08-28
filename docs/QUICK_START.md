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

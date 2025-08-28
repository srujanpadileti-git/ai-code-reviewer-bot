import { type Finding } from "./aggregator.js";

type RuleCtx = {
  path: string;
  source: string;      // full file text
  startLine: number;   // changed range (1-based)
  endLine: number;
  allowConsole?: boolean;
};

// Small helper to push a finding
function add(
  out: Finding[],
  ctx: RuleCtx,
  line: number,
  category: Finding["category"],
  severity: Finding["severity"],
  title: string,
  rationale: string,
  suggestion?: string
) {
  out.push({
    path: ctx.path,
    start_line: line,
    end_line: line,
    category,
    severity,
    title,
    rationale,
    suggestion
  });
}

/**
 * Scan ONLY the changed lines for high-signal patterns.
 * Returns an array of Finding objects (same shape the LLM returns).
 */
export function runRules(ctx: RuleCtx): Finding[] {
  const out: Finding[] = [];
  const lines = ctx.source.split("\n");

  const start = Math.max(1, ctx.startLine);
  const end = Math.min(lines.length, ctx.endLine);

  for (let lineNo = start; lineNo <= end; lineNo++) {
    const line = lines[lineNo - 1];

    // --- Secrets (high) ---
    if (/\bAKIA[0-9A-Z]{16}\b/.test(line)) {
      add(out, ctx, lineNo, "security", "high",
        "Possible AWS access key committed",
        "Hardcoded AWS keys can grant full access. Rotate immediately and load from env/secret store.",
        "// Move this key to a secret manager or env var and rotate the credential.");
    }
    if (/\bghp_[A-Za-z0-9]{36}\b/.test(line)) {
      add(out, ctx, lineNo, "security", "high",
        "Possible GitHub token committed",
        "Personal access tokens in code are a critical secret leak. Revoke/rotate and use env secrets.",
        "// Remove this token, read it from process.env, and rotate it.");
    }
    if (/\bsk-[A-Za-z0-9]{20,}\b/.test(line)) {
      add(out, ctx, lineNo, "security", "high",
        "Possible OpenAI API key committed",
        "API keys must not be in source control. Store in repo secrets and read at runtime.",
        "// Replace with process.env.OPENAI_API_KEY and add to GitHub Actions secrets.");
    }

    // --- Dangerous APIs (high) ---
    if (/\beval\s*\(/.test(line) || /\bnew\s+Function\s*\(/.test(line)) {
      add(out, ctx, lineNo, "security", "high",
        "Use of eval / Function constructor",
        "`eval` executes arbitrary code and is a common injection vector. Avoid it.",
        "// Refactor to avoid eval; use a whitelist / a safe parser / a lookup table instead.");
    }
    if (/\bchild_process\.(exec|execSync|spawn|spawnSync)\s*\(/.test(line)) {
      add(out, ctx, lineNo, "security", "high",
        "Shell execution may be unsafe",
        "Passing user-controlled data to shell commands can lead to command injection.",
        "// Prefer library APIs or sanitize arguments; avoid shell when possible.");
    }

    // --- Crypto pitfalls (medium) ---
    if (/crypto\.createHash\(['"](md5|sha1)['"]\)/i.test(line)) {
      add(out, ctx, lineNo, "security", "medium",
        "Weak hash algorithm (MD5/SHA-1)",
        "MD5 and SHA-1 are broken. Use SHA-256+ or a KDF like scrypt/argon2.",
        "// crypto.createHash('sha256')");
    }

    // --- HTTP pitfalls (medium) ---
    if (/fetch\s*\(\s*['"]http:\/\//.test(line) || /axios\.\w*\(\s*['"]http:\/\//.test(line)) {
      add(out, ctx, lineNo, "security", "medium",
        "Insecure HTTP request",
        "Unencrypted HTTP exposes credentials and data. Prefer HTTPS whenever possible.",
        line.replace("http://", "https://"));
    }

    // fetch without timeout/abort (heuristic)
    if (/\bfetch\s*\(/.test(line)) {
      // within the changed hunk, also look ahead a couple lines for AbortController usage
      const windowText = lines.slice(Math.max(0, lineNo - 1), Math.min(lines.length, lineNo + 3)).join("\n");
      if (!/AbortController|signal\s*:/.test(windowText)) {
        add(out, ctx, lineNo, "performance", "low",
          "Network request without timeout/abort",
          "A stuck network call can hang. Add an AbortController with a timeout.",
          [
            "const c = new AbortController();",
            "const t = setTimeout(() => c.abort(), 10_000);",
            "const res = await fetch(url, { signal: c.signal });",
            "clearTimeout(t);"
          ].join("\n"));
      }
    }

    // --- JWT secret hardcoded (high) ---
    if (/jwt\.sign\s*\([^,]+,\s*['"][^'"]+['"]/.test(line)) {
      add(out, ctx, lineNo, "security", "high",
        "Hardcoded JWT secret",
        "Secrets must be loaded from env or secret store, not source code.",
        "jwt.sign(payload, process.env.JWT_SECRET!)");
    }

    // --- Any type (low) ---
    if (/: \s*any(\W|$)/.test(line)) {
      add(out, ctx, lineNo, "style", "low",
        "Loose `any` type",
        "`any` turns off type safety. Prefer generics or unknown with type guards.",
        line.replace(/:\s*any/, ": unknown"));
    }

    // --- console.log in code (low) ---
    if (!ctx.allowConsole && /\bconsole\.log\s*\(/.test(line)) {
      add(out, ctx, lineNo, "style", "low",
        "Leftover console.log",
        "Console noise makes logs hard to read. Use a logger or remove before merge.",
        "// TODO: remove or replace with logger.debug(...)");
    }
  }

  return out;
}
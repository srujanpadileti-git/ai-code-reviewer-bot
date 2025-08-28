import { type Finding } from "./aggregator.js";

type RuleCtx = {
  path: string;
  source: string;      // full file text
  startLine: number;   // changed range (1-based)
  endLine: number;
  allowConsole?: boolean;
};

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

export function runRules(ctx: RuleCtx): Finding[] {
  const out: Finding[] = [];
  const lines = ctx.source.split("\n");

  const start = Math.max(1, ctx.startLine);
  const end = Math.min(lines.length, ctx.endLine);
  const isPy = /\.py$/.test(ctx.path);

  for (let lineNo = start; lineNo <= end; lineNo++) {
    const line = lines[lineNo - 1];

    // --- Secrets (both) ---
    if (/\bAKIA[0-9A-Z]{16}\b/.test(line)) {
      add(out, ctx, lineNo, "security", "high",
        "Possible AWS access key committed",
        "Hardcoded AWS keys can grant full access. Rotate immediately and load from env/secret store.",
        "# Move this key to a secret manager or env var and rotate the credential.");
    }
    if (/\bghp_[A-Za-z0-9]{36}\b/.test(line)) {
      add(out, ctx, lineNo, "security", "high",
        "Possible GitHub token committed",
        "Personal access tokens in code are a critical secret leak. Revoke/rotate and use env secrets.",
        isPy ? "# Remove this token, read from os.environ, and rotate it." : "// Remove this token, read it from process.env, and rotate it.");
    }
    if (/\bsk-[A-Za-z0-9]{20,}\b/.test(line)) {
      add(out, ctx, lineNo, "security", "high",
        "Possible OpenAI API key committed",
        "API keys must not be in source control. Store in repo secrets and read at runtime.",
        isPy ? `# os.getenv("OPENAI_API_KEY")` : `// process.env.OPENAI_API_KEY`);
    }

    if (!isPy) {
      // ===== JS/TS rules (unchanged) =====
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
      if (/crypto\.createHash\(['"](md5|sha1)['"]\)/i.test(line)) {
        add(out, ctx, lineNo, "security", "medium",
          "Weak hash algorithm (MD5/SHA-1)",
          "MD5 and SHA-1 are broken. Use SHA-256+ or a KDF like scrypt/argon2.",
          "// crypto.createHash('sha256')");
      }
      if (/fetch\s*\(\s*['"]http:\/\//.test(line) || /axios\.\w*\(\s*['"]http:\/\//.test(line)) {
        add(out, ctx, lineNo, "security", "medium",
          "Insecure HTTP request",
          "Unencrypted HTTP exposes credentials and data. Prefer HTTPS whenever possible.",
          line.replace("http://", "https://"));
      }
      if (/\bfetch\s*\(/.test(line)) {
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
      if (/jwt\.sign\s*\([^,]+,\s*['"][^'"]+['"]/.test(line)) {
        add(out, ctx, lineNo, "security", "high",
          "Hardcoded JWT secret",
          "Secrets must be loaded from env or secret store, not source code.",
          "jwt.sign(payload, process.env.JWT_SECRET!)");
      }
      if (/: \s*any(\W|$)/.test(line)) {
        add(out, ctx, lineNo, "style", "low",
          "Loose `any` type",
          "`any` turns off type safety. Prefer generics or unknown with type guards.",
          line.replace(/:\s*any/, ": unknown"));
      }
      if (!ctx.allowConsole && /\bconsole\.log\s*\(/.test(line)) {
        add(out, ctx, lineNo, "style", "low",
          "Leftover console.log",
          "Console noise makes logs hard to read. Use a logger or remove before merge.",
          "// TODO: remove or replace with logger.debug(...)");
      }
    } else {
      // ===== Python rules =====
      if (/\beval\s*\(/.test(line) || /\bexec\s*\(/.test(line)) {
        add(out, ctx, lineNo, "security", "high",
          "Use of eval/exec",
          "`eval/exec` runs arbitrary code and is dangerous with untrusted input.",
          "# Avoid eval/exec; use safe parsing or a dispatch table instead.");
      }
      if (/\bsubprocess\.(Popen|run|call|check_output)\s*\(.*shell\s*=\s*True/.test(line)) {
        add(out, ctx, lineNo, "security", "high",
          "subprocess with shell=True",
          "shell=True enables command injection when inputs are not strictly controlled.",
          "# Use shell=False and pass args as a list; validate inputs.");
      }
      if (/\bos\.system\s*\(/.test(line)) {
        add(out, ctx, lineNo, "security", "high",
          "os.system call",
          "Running shell commands directly is risky. Prefer subprocess with args, not a shell string.",
          "# Replace with subprocess.run([...], check=True)");
      }
      if (/\bpickle\.loads?\s*\(/.test(line)) {
        add(out, ctx, lineNo, "security", "high",
          "Unsafe pickle load",
          "`pickle` can execute code while deserializing. Do not load untrusted data.",
          "# Use json or a safe serializer; if unavoidable, only load trusted data.");
      }
      if (/\byaml\.load\s*\(/.test(line) && !/SafeLoader/.test(line)) {
        add(out, ctx, lineNo, "security", "medium",
          "yaml.load without SafeLoader",
          "Use SafeLoader to avoid arbitrary object construction.",
          "yaml.load(data, Loader=yaml.SafeLoader)");
      }
      if (/requests\.\w+\s*\(\s*['"]http:\/\//.test(line)) {
        add(out, ctx, lineNo, "security", "medium",
          "Insecure HTTP request",
          "Prefer HTTPS to protect data in transit.",
          line.replace("http://", "https://"));
      }
      if (/requests\.\w+\s*\(/.test(line) && !/timeout\s*=/.test(line)) {
        add(out, ctx, lineNo, "performance", "low",
          "Network request without timeout",
          "A hanging request can stall the program. Set a timeout.",
          "requests.get(url, timeout=10)");
      }
      if (/^\s*except\s+Exception\s*:\s*$/.test(line)) {
        add(out, ctx, lineNo, "style", "low",
          "Overly broad exception handler",
          "Catching Exception masks real errors. Catch specific exceptions and log details.",
          "# except (ValueError, IOError) as e: ...");
      }
      if (!ctx.allowConsole && /\bprint\s*\(/.test(line)) {
        add(out, ctx, lineNo, "style", "low",
          "Leftover print",
          "Use a logger instead of print in production code.",
          "# TODO: replace print with logger.debug/info");
      }
    }
  }

  return out;
}
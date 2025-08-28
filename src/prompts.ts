type ReviewFinding = {
  path: string;
  start_line: number;
  end_line: number;
  category: "bug" | "security" | "performance" | "style" | "docs" | "test";
  title: string;
  rationale: string;
  suggestion?: string;
  severity: "high" | "medium" | "low";
  references?: string[];
};

export function systemPrompt() {
  return [
    "You are a senior software engineer giving focused code review on diff hunks.",
    "Only produce actionable comments that improve correctness, security, performance, readability, docs, or tests.",
    "Return a JSON array ONLY, using this schema:",
    `[
      {
        "path": "src/file.ts",
        "start_line": 10,
        "end_line": 18,
        "category": "bug|security|performance|style|docs|test",
        "title": "short headline",
        "rationale": "why this matters in 1-3 sentences",
        "suggestion": "optional: a minimal code change or markdown tip",
        "severity": "high|medium|low",
        "references": ["optional rule or link"]
      }
    ]`,
    "If nothing material: return []. No prose outside JSON."
  ].join("\n");
}

export function buildUserPrompt(args: {
  repo: string;
  filePath: string;
  startLine: number;
  endLine: number;
  symbolType: string;
  symbolName: string | null;
  snippetStart: number;
  snippetEnd: number;
  snippet: string;
  related?: Array<{ path: string; startLine: number; endLine: number; symbolType: string; symbolName: string | null; snippet: string }>;
}) {
  const header =
    `Repository: ${args.repo}\n` +
    `File: ${args.filePath}\n` +
    `Changed lines: ${args.startLine}-${args.endLine}\n` +
    `Nearest symbol: ${args.symbolType}${args.symbolName ? " " + args.symbolName : ""}\n` +
    `Context snippet ${args.snippetStart}-${args.snippetEnd}:\n`;
  let body = header + "```ts\n" + args.snippet + "\n```";

  if (args.related && args.related.length) {
    body += `\n\nRelated repo context (top ${args.related.length}):\n`;
    for (const r of args.related) {
      body += `\n- ${r.path}:${r.startLine}-${r.endLine} (${r.symbolType}${r.symbolName ? " " + r.symbolName : ""})\n`;
      body += "```ts\n" + r.snippet + "\n```\n";
    }
  }

  return body;
}

// Helper to safely parse whatever the model spits out into an array
export function safeParseFindings(text: string): ReviewFinding[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  const json = text.slice(start, end + 1);
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
import type { Finding } from "./aggregator.js";

export function toCommentBody(f: Finding) {
  const lines: string[] = [];
  lines.push(`**${capitalize(f.category)}** — **${escapeMd(f.title || "")}**`);
  lines.push("");
  lines.push(escapeMd(f.rationale || "").trim() || "_No rationale provided._");

  if (f.suggestion && f.suggestion.trim().length > 0) {
    lines.push("");
    lines.push("```suggestion");
    lines.push(f.suggestion.trim());
    lines.push("```");
  }

  if (f.references && f.references.length > 0) {
    lines.push("");
    lines.push("_Refs:_ " + f.references.map(escapeMd).join("; "));
  }

  return lines.join("\n");
}

function escapeMd(s: string) {
  return s.replace(/[_*`]/g, (m) => "\\" + m);
}
function capitalize(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
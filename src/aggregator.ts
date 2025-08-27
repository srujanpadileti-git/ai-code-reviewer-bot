export type Finding = {
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

const sevWeight: Record<Finding["severity"], number> = { high: 3, medium: 2, low: 1 };
const catWeight: Record<Finding["category"], number> = {
  security: 4, bug: 3, performance: 2, test: 2, docs: 1, style: 1
};

export function aggregateFindings(all: Finding[], max = 10) {
  // 1) Dedupe near-identical items
  const seen = new Map<string, Finding>();
  for (const f of all) {
    const key = `${f.path}:${f.start_line}:${(f.title || "").toLowerCase().slice(0, 60)}`;
    const existing = seen.get(key);
    if (!existing) seen.set(key, f);
    else {
      // keep stronger one
      if (score(f) > score(existing)) seen.set(key, f);
    }
  }
  let arr = Array.from(seen.values());

  // 2) Sort by severity + category importance + earlier line
  arr.sort((a, b) => {
    const d1 = score(b) - score(a);
    if (d1 !== 0) return d1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.start_line - b.start_line;
  });

  // 3) Cap to max
  arr = arr.slice(0, max);

  // 4) Summary counts
  const counts = { high: 0, medium: 0, low: 0, total: arr.length };
  for (const f of arr) counts[f.severity]++;

  return { top: arr, counts };
}

function score(f: Finding) {
  return sevWeight[f.severity] * 10 + catWeight[f.category];
}
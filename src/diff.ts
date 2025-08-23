export type Hunk = { startLine: number; endLine: number };

export function parsePatchToHunks(patch: string): Hunk[] {
  if (!patch) return [];
  const hunks: Hunk[] = [];
  const lines = patch.split("\n");
  const hunkHeader = /^@@\s-\d+(?:,\d+)?\s\+(\d+)(?:,(\d+))?\s@@/;

  for (const line of lines) {
    const m = hunkHeader.exec(line);
    if (m) {
      const start = parseInt(m[1], 10);
      const len = m[2] ? parseInt(m[2], 10) : 1;
      hunks.push({ startLine: start, endLine: start + Math.max(len - 1, 0) });
    }
  }
  return hunks;
}
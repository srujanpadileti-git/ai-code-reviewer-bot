import type { Finding } from "../aggregator.js";

export type EvalCase = {
  name: string;
  path: string;               // repo-relative file path
  source: string;             // full file content to scan
  changes: Array<{ startLine: number; endLine: number }>; // changed lines to scan
  expect: Array<{
    line: number;             // line we expect a finding on
    category: Finding["category"];
    // optional checks (loose compare)
    severity?: Finding["severity"];
    titleIncludes?: string;
  }>;
};

// A few starter cases (JS/TS + Python). Add more over time!
export const cases: EvalCase[] = [
  {
    name: "JS insecure http -> should flag",
    path: "src/net/http.ts",
    source: `export async function getUser(id: string) {
  const res = await fetch("http://api.example.com/users/" + id);
  return res.json();
}`,
    changes: [{ startLine: 2, endLine: 2 }],
    expect: [{ line: 2, category: "security", severity: "medium", titleIncludes: "Insecure HTTP" }],
  },
  {
    name: "JS eval -> high severity",
    path: "src/misc/eval.ts",
    source: `export function run(code: string) {
  // bad:
  return eval(code);
}`,
    changes: [{ startLine: 3, endLine: 3 }],
    expect: [{ line: 3, category: "security", severity: "high", titleIncludes: "eval" }],
  },
  {
    name: "TS any type -> style",
    path: "src/types/loose.ts",
    source: `export function add(a: any, b: any) {
  return a + b;
}`,
    changes: [{ startLine: 1, endLine: 1 }],
    expect: [{ line: 1, category: "style", titleIncludes: "`any`" }],
  },
  {
    name: "JS hardcoded OpenAI key -> high",
    path: "src/keys/openai.ts",
    source: `export const KEY = "sk-veryobviouslyfakebutshouldmatchxxxxxxxxx";`,
    changes: [{ startLine: 1, endLine: 1 }],
    expect: [{ line: 1, category: "security", severity: "high", titleIncludes: "OpenAI API key" }],
  },
  {
    name: "Python subprocess shell=True -> high",
    path: "tools/run_cmd.py",
    source: `import subprocess
def go(cmd):
    return subprocess.run(cmd, shell=True)`,
    changes: [{ startLine: 3, endLine: 3 }],
    expect: [{ line: 3, category: "security", severity: "high", titleIncludes: "shell=True" }],
  },
  {
    name: "Python requests without timeout + http",
    path: "tools/net.py",
    source: `import requests
def ping(url):
    return requests.get("http://example.com")`,
    changes: [{ startLine: 3, endLine: 3 }],
    expect: [
      { line: 3, category: "security", titleIncludes: "Insecure HTTP" },
      { line: 3, category: "performance", titleIncludes: "timeout" },
    ],
  },
  {
    name: "Python yaml.load without SafeLoader",
    path: "tools/yml.py",
    source: `import yaml
def load(s):
    return yaml.load(s)`,
    changes: [{ startLine: 3, endLine: 3 }],
    expect: [{ line: 3, category: "security", severity: "medium", titleIncludes: "SafeLoader" }],
  },
];

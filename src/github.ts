import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";

export type ChangedFile = {
  filename: string;
  patch: string;
  status: string;
  additions: number;
  deletions: number;
};

export function getPRContext() {
  const ctx = github.context;
  const { owner, repo } = ctx.repo;
  const prNumber = ctx.payload.pull_request?.number;
  const headSha = ctx.payload.pull_request?.head?.sha;
  if (!prNumber || !headSha) {
    throw new Error("This action must run on a pull_request event with head SHA.");
  }
  return { owner, repo, prNumber, headSha };
}

export async function getChangedFiles(octokit: Octokit, owner: string, repo: string, prNumber: number) {
  const { data } = await octokit.pulls.listFiles({ owner, repo, pull_number: prNumber, per_page: 100 });
  return data.map<ChangedFile>(f => ({
    filename: f.filename,
    patch: f.patch ?? "",
    status: f.status ?? "modified",
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0
  }));
}

// Get the *new* version of the file at the PR's head SHA
export async function getFileContentAtRef(octokit: Octokit, owner: string, repo: string, path: string, ref: string) {
  const res = await octokit.repos.getContent({ owner, repo, path, ref });
  if (!("content" in res.data)) throw new Error(`Cannot fetch content for ${path}`);
  const b64 = (res.data as any).content as string;
  const buff = Buffer.from(b64, "base64");
  return buff.toString("utf-8");
}

export async function postLineComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  path: string,
  line: number,
  body: string
) {
  // Single-line comment on the RIGHT (new) side using absolute new-file line number
  await (octokit as any).pulls.createReviewComment({
    owner, repo, pull_number: prNumber,
    commit_id: headSha,
    path,
    side: "RIGHT",
    line,
    body
  });
}

export async function createOrUpdateCheck(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  summaryMd: string
) {
  // Create a neutral check run with our summary
  await (octokit as any).checks.create({
    owner, repo,
    name: "ai-code-review summary",
    head_sha: headSha,
    status: "completed",
    conclusion: "neutral",
    output: {
      title: "AI Code Review",
      summary: summaryMd
    }
  });
}
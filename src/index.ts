// src/index.ts
import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";

async function run() {
  try {
    // 1) Read GitHub info
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is missing");

    const ctx = github.context;
    const { owner, repo } = ctx.repo;

    // If this job didn't run on a pull_request, stop early
    if (ctx.eventName !== "pull_request") {
      console.log("Not a pull_request event. Bye!");
      return;
    }

    const prNumber = ctx.payload.pull_request?.number;
    if (!prNumber) throw new Error("No pull request number in context");

    const octokit = new Octokit({ auth: token });

    // 2) What files changed in this PR?
    const filesResp = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });

    const files = filesResp.data.map(f => ({
      filename: f.filename,
      additions: f.additions,
      deletions: f.deletions,
      status: f.status,
    }));

    // 3) Print them
    console.log("🎉 AI Reviewer Day 1 is working!");
    console.log(`Repo: ${owner}/${repo} | PR #${prNumber}`);
    console.log("Changed files:");
    for (const f of files) {
      console.log(`- ${f.filename} (+${f.additions} -${f.deletions}) [${f.status}]`);
    }
  } catch (err: any) {
    core.setFailed(err.message);
  }
}
run();
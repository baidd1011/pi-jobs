import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pi-jobs-pr-"));
process.env.PI_JOBS_DATA_DIR = join(root, "data");
const store = await import(`../lib/store.mjs?pr-store=${Date.now()}`);
const pr = await import(`../lib/pr-delivery.mjs?pr=${Date.now()}`);

const baseSha = "a".repeat(40);
const resultSha = "b".repeat(40);
const remoteUrl = "https://github.com/example/project.git";

function fakeExecutor(options = {}) {
  const state = { remoteBranches: new Map(), pull: options.pull || null, calls: [], body: null };
  const execute = (command, args) => {
    state.calls.push([command, ...args]);
    if (command === "git" && args.includes("remote") && args.includes("get-url")) return options.remoteUrl || remoteUrl;
    if (command === "git" && args.includes("ls-remote")) {
      const ref = args.at(-1);
      const branch = ref.replace("refs/heads/", "");
      if (branch === "main") return `${baseSha}\t${ref}`;
      const sha = state.remoteBranches.get(branch);
      return sha ? `${sha}\t${ref}` : "";
    }
    if (command === "git" && args.includes("rev-parse")) return resultSha;
    if (command === "git" && args.includes("push")) {
      if (options.failPush) throw new Error("simulated push failure");
      const spec = args.at(-1);
      const branch = spec.split(":").at(-1).replace("refs/heads/", "");
      state.remoteBranches.set(branch, resultSha);
      return "";
    }
    if (command === "gh" && args[0] === "auth" && args[1] === "status") return "authenticated";
    if (command === "gh" && args[0] === "auth" && args[1] === "setup-git") return "";
    if (command === "gh" && args[0] === "api" && args.includes("user")) return options.account || "alice";
    if (command === "gh" && args[0] === "api" && args.some((arg) => String(arg).startsWith("repos/"))) {
      return JSON.stringify({ default_branch: "main", permissions: { push: options.pushPermission !== false } });
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "list") return JSON.stringify(state.pull ? [state.pull] : []);
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      if (options.failPrCreate) throw new Error("simulated PR failure");
      const bodyPath = args[args.indexOf("--body-file") + 1];
      state.body = readFileSync(bodyPath, "utf8");
      state.pull = { number: 7, url: "https://github.com/example/project/pull/7", state: "OPEN", isDraft: true, headRefName: args[args.indexOf("--head") + 1], baseRefName: "main" };
      return state.pull.url;
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "view") return JSON.stringify(state.pull);
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  return { execute, state };
}

test("GitHub remote parsing rejects credential-bearing URLs", () => {
  assert.deepEqual(pr.parseGitHubRemote(remoteUrl), { host: "github.com", repository: "example/project", transport: "https", sanitizedUrl: remoteUrl });
  assert.equal(pr.parseGitHubRemote("git@github.com:example/project.git").transport, "ssh");
  assert.throws(() => pr.parseGitHubRemote("https://token@github.com/example/project.git"), /credential-bearing/);
  assert.throws(() => pr.parseGitHubRemote("ssh://token@github.com/example/project.git"), /credential-bearing/);
  assert.throws(() => pr.parseGitHubRemote("file:///tmp/repo"), /HTTPS or SSH/);
});

test("setup and job preflight require an explicit remote, push permission, and exact base", () => {
  const { execute } = fakeExecutor();
  const setup = pr.inspectPrSetup(root, { remoteName: "origin" }, { execute, ghPath: "gh" });
  assert.equal(setup.account, "alice");
  assert.equal(setup.baseBranch, "main");
  const config = pr.configurePrRepository({ budgetUsd: 2, timeoutMin: 30, maxTurns: 200 }, setup, { execute });
  assert.equal(config.prRepositories.length, 1);
  const delivery = pr.preflightPrJob({ repoRoot: root, baseCommit: baseSha }, config, "job-pr-1", { execute });
  assert.equal(delivery.target.repository, "example/project");
  assert.equal(delivery.authorization.confirmedBy, "alice");
  assert.throws(() => pr.preflightPrJob({ repoRoot: root, baseCommit: "c".repeat(40) }, config, "job-pr-2", { execute }), /local HEAD must equal/);
  const denied = fakeExecutor({ pushPermission: false });
  assert.throws(() => pr.inspectPrSetup(root, { remoteName: "origin" }, { execute: denied.execute, ghPath: "gh" }), /push permission/);
});

test("Draft PR delivery pushes without force, records the PR, and cleans its body file", () => {
  const { execute, state } = fakeExecutor();
  const branch = "pi-jobs-job-pr-deliver";
  const pushed = [];
  const job = {
    id: "job-pr-deliver", prompt: "implement delivery", repoRoot: root, baseCommit: baseSha,
    branch, filesChanged: ["A\tresult.txt"], summary: "implemented", costUsd: 0.01,
    policy: { tools: ["read", "edit", "write"], noNetwork: true, maxTurns: 20 },
    runtime: { policy: { tools: ["read", "edit", "write"], noNetwork: true, maxTurns: 20 } },
    delivery: {
      type: "pr", status: "push-pending", branch, commit: resultSha.slice(0, 7),
      target: { remoteName: "origin", remoteUrl, host: "github.com", repository: "example/project", baseBranch: "main", ghPath: "gh" },
      authorization: { confirmedBy: "alice", confirmedAt: "2026-07-30T00:00:00.000Z" },
    },
  };
  const result = pr.deliverPullRequest(job, { execute, onPushed: (value) => pushed.push(value) });
  assert.equal(result.prUrl, "https://github.com/example/project/pull/7");
  assert.equal(result.prDraft, true);
  assert.equal(pushed.length, 1);
  assert.ok(state.calls.some((call) => call[0] === "git" && call.includes("push") && !call.some((arg) => /force/i.test(arg))));
  assert.match(state.body, /job-pr-deliver/);
  assert.doesNotMatch(state.body, /token|credential/i);
});

test("delivery reuses an existing PR and refuses a conflicting remote branch", () => {
  const existing = { number: 8, url: "https://github.com/example/project/pull/8", state: "OPEN", isDraft: true, headRefName: "pi-jobs-job-existing", baseRefName: "main" };
  const same = fakeExecutor({ pull: existing });
  same.state.remoteBranches.set(existing.headRefName, resultSha);
  const job = {
    id: "job-existing", prompt: "resume", repoRoot: root, baseCommit: baseSha, branch: existing.headRefName,
    delivery: { type: "pr", status: "pushed", branch: existing.headRefName,
      target: { remoteName: "origin", remoteUrl, host: "github.com", repository: "example/project", baseBranch: "main", ghPath: "gh" },
      authorization: { confirmedBy: "alice", confirmedAt: "2026-07-30T00:00:00.000Z" } },
  };
  assert.equal(pr.deliverPullRequest(job, { execute: same.execute }).prNumber, 8);
  assert.equal(same.state.calls.some((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create"), false);
  const conflict = fakeExecutor();
  conflict.state.remoteBranches.set(existing.headRefName, "c".repeat(40));
  assert.throws(() => pr.deliverPullRequest(job, { execute: conflict.execute }), /refusing to force push/);
  const canceled = fakeExecutor();
  assert.throws(() => pr.deliverPullRequest(job, { execute: canceled.execute, shouldContinue: () => false }), (error) => error.code === "DELIVERY_CANCELED");
  assert.equal(canceled.state.calls.some((call) => call[0] === "git" && call.includes("push")), false);
});

test("delivery rechecks account, permission, remote identity, push, and PR creation", () => {
  const branch = "pi-jobs-job-recheck";
  const job = {
    id: "job-recheck", prompt: "recheck authorization", repoRoot: root, baseCommit: baseSha, branch,
    delivery: { type: "pr", status: "push-pending", branch,
      target: { remoteName: "origin", remoteUrl, host: "github.com", repository: "example/project", baseBranch: "main", ghPath: "gh" },
      authorization: { confirmedBy: "alice", confirmedAt: "2026-07-30T00:00:00.000Z" } },
  };
  assert.throws(() => pr.deliverPullRequest(job, { execute: fakeExecutor({ account: "bob" }).execute }), /account changed/);
  assert.throws(() => pr.deliverPullRequest(job, { execute: fakeExecutor({ pushPermission: false }).execute }), /push permission/);
  assert.throws(() => pr.deliverPullRequest(job, { execute: fakeExecutor({ remoteUrl: "https:\/\/github.com\/other\/repo.git" }).execute }), /remote changed/);
  const pushFailed = fakeExecutor({ failPush: true });
  assert.throws(() => pr.deliverPullRequest(job, { execute: pushFailed.execute }), /result branch push failed/);
  assert.equal(pushFailed.state.pull, null);
  const prFailed = fakeExecutor({ failPrCreate: true });
  assert.throws(() => pr.deliverPullRequest(job, { execute: prFailed.execute }), /Draft PR creation failed/);
  assert.equal(prFailed.state.remoteBranches.get(branch), resultSha, "successful push is retained when PR creation fails");
});

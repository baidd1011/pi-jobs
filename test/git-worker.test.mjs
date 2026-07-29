import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const suiteRoot = mkdtempSync(join(tmpdir(), "pi-jobs-git-"));
process.env.PI_JOBS_DATA_DIR = join(suiteRoot, "data");
process.env.PI_JOBS_LEGACY_DIR = join(suiteRoot, "no-legacy");
const store = await import(`../lib/store.mjs?git-store=${Date.now()}`);
const gitops = await import(`../lib/gitops.mjs?git-ops=${Date.now()}`);
const runner = await import(`../runner/run.mjs?git-runner=${Date.now()}`);

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo(name) {
  const repo = join(suiteRoot, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "pi-jobs-test");
  git(repo, "config", "user.email", "pi-jobs@example.invalid");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");
  return repo;
}

function add(repo, prompt) {
  const frozen = gitops.inspectRepo(repo);
  return store.createJob({ ...frozen, prompt, budgetUsd: 1, timeoutMin: 1, maxTurns: 10 });
}

const configFor = (name) => ({ worktreeRoot: join(suiteRoot, name), heartbeatMs: 10, maxTurns: 10 });
const success = async (job) => {
  writeFileSync(join(job.worktreePath, "result.txt"), "job output\n");
  return { status: "done", cost: 0.01, summary: "done", tokens: null, sessionFile: null, error: null };
};

test("dirty submit workspace remains untouched while result is delivered on an independent branch", async () => {
  const repo = makeRepo("dirty-repo");
  writeFileSync(join(repo, "local-only.txt"), "uncommitted\n");
  const baseHead = git(repo, "rev-parse", "HEAD");
  const created = add(repo, "write a result");
  assert.equal(created.dirtyAtSubmit, true);
  const claimed = store.claimNextJob("worker-dirty");
  const terminal = await runner.runOne(claimed, configFor("worktrees-dirty"), success);
  assert.equal(terminal.state, "done");
  assert.equal(terminal.delivery.status, "branch-ready");
  assert.equal(git(repo, "rev-parse", "HEAD"), baseHead);
  assert.equal(existsSync(join(repo, "local-only.txt")), true);
  assert.equal(existsSync(join(repo, "result.txt")), false);
  assert.equal(git(repo, "show", `${terminal.delivery.branch}:result.txt`), "job output");
  assert.equal(existsSync(join(configFor("worktrees-dirty").worktreeRoot, created.id)), false);
});

test("job starts from frozen base even if the main branch advances before execution", async () => {
  const repo = makeRepo("frozen-repo");
  const created = add(repo, "use frozen base");
  writeFileSync(join(repo, "advanced.txt"), "new main commit\n");
  git(repo, "add", "advanced.txt");
  git(repo, "commit", "-m", "advance main");
  const claimed = store.claimNextJob("worker-frozen");
  const terminal = await runner.runOne(claimed, configFor("worktrees-frozen"), success);
  assert.equal(git(repo, "rev-parse", `${terminal.delivery.branch}^`), created.baseCommit);
  assert.throws(() => git(repo, "show", `${terminal.delivery.branch}:advanced.txt`));
  assert.equal(existsSync(join(repo, "advanced.txt")), true);
});

test("no-change result removes the empty branch and reports no-changes", async () => {
  const repo = makeRepo("no-change-repo");
  const created = add(repo, "inspect only");
  const claimed = store.claimNextJob("worker-no-change");
  const terminal = await runner.runOne(claimed, configFor("worktrees-no-change"), async () => ({ status: "done", cost: 0, summary: "nothing", error: null }));
  assert.equal(terminal.state, "done");
  assert.equal(terminal.delivery.status, "no-changes");
  assert.equal(git(repo, "branch", "--list", gitops.jobBranch(created.id)), "");
});

test("fresh execution never adopts a pre-existing result branch or calls the model", async () => {
  const repo = makeRepo("branch-collision-repo");
  const created = add(repo, "must not adopt collision");
  const branch = gitops.jobBranch(created.id);
  git(repo, "branch", branch, created.baseCommit);
  const claimed = store.claimNextJob("worker-collision");
  let calls = 0;
  const terminal = await runner.runOne(claimed, configFor("worktrees-collision"), async () => { calls++; return success(claimed); });
  assert.equal(calls, 0);
  assert.equal(terminal.state, "failed");
  assert.equal(terminal.statusDetail, "cleanup-needed");
  assert.equal(terminal.delivery.status, "failed");
  assert.equal(git(repo, "rev-parse", branch), created.baseCommit);
});

test("stale running recovery commits partial work without invoking the model", () => {
  const repo = makeRepo("recovery-repo");
  const created = add(repo, "partial recovery");
  let running = store.claimNextJob("dead-worker");
  const cfg = configFor("worktrees-recovery");
  running = store.transitionJob(running.id, { branch: gitops.jobBranch(running.id), worktreePath: gitops.jobWorktreePath(running.id, cfg) }, "preparing:worktree");
  gitops.createJobWorktree(running, cfg);
  writeFileSync(join(running.worktreePath, "partial.txt"), "partial\n");
  store.transitionJob(running.id, { phase: "agent", delivery: { status: "pending" } }, "phase:agent");
  store.writeHeartbeat(running.id, "dead-worker", "2020-01-01T00:00:00.000Z");
  const recovered = runner.recoverStaleJobs(cfg);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].state, "failed");
  assert.equal(recovered[0].statusDetail, "worker-crashed");
  assert.equal(recovered[0].delivery.status, "branch-ready");
  assert.equal(git(repo, "show", `${recovered[0].delivery.branch}:partial.txt`), "partial");
});

test("stale recovery preserves a persisted stopCause", () => {
  const repo = makeRepo("stop-recovery-repo");
  const created = add(repo, "cancel then crash");
  store.claimNextJob("dead-canceled-worker");
  const at = "2026-02-03T04:05:06.000Z";
  store.recordStopRequest(created.id, "canceled", at);
  store.writeHeartbeat(created.id, "dead-canceled-worker", "2020-01-01T00:00:00.000Z");
  const [recovered] = runner.recoverStaleJobs(configFor("worktrees-stop-recovery"));
  assert.equal(recovered.state, "canceled");
  assert.equal(recovered.stopCause, "canceled");
  assert.equal(recovered.stopRequestedAt, at);
});

test("worktree cleanup failure preserves the worktree and reports cleanup-needed", () => {
  const repo = makeRepo("cleanup-repo");
  const created = add(repo, "cleanup failure");
  const cfg = configFor("worktrees-cleanup");
  const job = { ...created, branch: gitops.jobBranch(created.id), worktreePath: gitops.jobWorktreePath(created.id, cfg) };
  gitops.createJobWorktree(job, cfg);
  writeFileSync(join(job.worktreePath, "keep.txt"), "keep me\n");
  const result = gitops.finalizeJobWorktree({ ...job, repoRoot: join(suiteRoot, "missing-repo") }, "test finalize");
  assert.equal(result.ok, false);
  assert.equal(result.cleanupNeeded, true);
  assert.equal(existsSync(job.worktreePath), true);
  store.requestCancel(created.id, "test-cleanup");
});

test("detached HEAD submission records a null baseRef and still delivers", async () => {
  const repo = makeRepo("detached-repo");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "--detach", head);
  const created = add(repo, "detached task");
  assert.equal(created.baseRef, null);
  const claimed = store.claimNextJob("worker-detached");
  const terminal = await runner.runOne(claimed, configFor("worktrees-detached"), success);
  assert.equal(terminal.delivery.status, "branch-ready");
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
});

test("runOne captures the runtime field once when entering the agent phase", async () => {
  const repo = makeRepo("runtime-repo");
  const cfg = configFor("worktrees-runtime");
  const created = add(repo, "runtime task");
  const claimed = store.claimNextJob("worker-runtime");
  const terminal = await runner.runOne(claimed, { ...cfg, provider: "test-provider", model: "test-model", piPath: process.execPath }, success);
  const persisted = store.readJob(created.id);
  assert.equal(persisted.runtime.provider, "test-provider");
  assert.equal(persisted.runtime.model, "test-model");
  assert.equal(persisted.runtime.piPath, process.execPath);
  assert.ok(persisted.runtime.capturedAt, "capturedAt is set");
  assert.equal(terminal.runtime.provider, "test-provider");
});

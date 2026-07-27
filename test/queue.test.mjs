import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pi-jobs-queue-"));
process.env.PI_JOBS_DATA_DIR = join(root, "data");
process.env.PI_JOBS_LEGACY_DIR = join(root, "no-legacy");
const store = await import(`../lib/store.mjs?queue-store=${Date.now()}`);
const { inspectRepo } = await import(`../lib/gitops.mjs?queue-git=${Date.now()}`);
const { drainQueue } = await import(`../runner/run.mjs?queue-runner=${Date.now()}`);

function git(repo, ...args) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function makeRepo(name) {
  const repo = join(root, name); mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "queue-test"); git(repo, "config", "user.email", "queue@example.invalid");
  writeFileSync(join(repo, "base.txt"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-m", "base");
  return repo;
}
function enqueue(repo, prompt) { return store.createJob({ ...inspectRepo(repo), prompt, budgetUsd: 1, timeoutMin: 1, maxTurns: 10 }); }
const fakeResult = async () => ({ status: "done", cost: 0, summary: "fake", error: null });

test("one drain processes two quickly-added jobs exactly once", async () => {
  const repo = makeRepo("two-jobs");
  const a = enqueue(repo, "first"); const b = enqueue(repo, "second");
  const calls = new Map();
  const rpc = async (job) => { calls.set(job.id, (calls.get(job.id) || 0) + 1); return fakeResult(); };
  const processed = await drainQueue({ worktreeRoot: join(root, "wt-two") }, { rpcRunner: rpc, idlePollMs: 5, emptyScans: 2 });
  assert.equal(processed, 2);
  assert.equal(calls.get(a.id), 1); assert.equal(calls.get(b.id), 1);
  assert.equal(store.readJob(a.id).state, "done"); assert.equal(store.readJob(b.id).state, "done");
});

test("short empty polling catches a job added near the exit scan boundary", async () => {
  const repo = makeRepo("boundary-job");
  let added;
  const drain = drainQueue({ worktreeRoot: join(root, "wt-boundary") }, { rpcRunner: fakeResult, idlePollMs: 25, emptyScans: 5 });
  setTimeout(() => { added = enqueue(repo, "arrived during empty polling"); }, 70);
  const processed = await drain;
  assert.equal(processed, 1);
  assert.equal(store.readJob(added.id).state, "done");
});

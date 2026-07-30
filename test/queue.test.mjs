import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("soft pause lets the current job finish and blocks the next claim until resume", async () => {
  const repo = makeRepo("paused-queue");
  const first = enqueue(repo, "first before pause");
  const second = enqueue(repo, "second after pause");
  let calls = 0;
  const rpc = async () => {
    calls++;
    if (calls === 1) store.setQueuePaused(true, "queue-test");
    return fakeResult();
  };
  const processed = await drainQueue({ worktreeRoot: join(root, "wt-paused") }, { rpcRunner: rpc, idlePollMs: 5, emptyScans: 2 });
  assert.equal(processed, 1);
  assert.equal(store.readJob(first.id).state, "done");
  assert.equal(store.readJob(second.id).state, "queued");
  assert.equal(store.readQueueState().paused, true);
  assert.equal(store.setQueuePaused(true, "queue-test").changed, false);
  store.setQueuePaused(false, "queue-test");
  assert.equal(await drainQueue({ worktreeRoot: join(root, "wt-paused") }, { rpcRunner: fakeResult, idlePollMs: 5, emptyScans: 2 }), 1);
  assert.equal(store.readJob(second.id).state, "done");
});

test("prioritize moves queued jobs to the front deterministically and is audited", () => {
  const repo = makeRepo("priority-queue");
  const a = enqueue(repo, "normal oldest");
  const b = enqueue(repo, "priority first");
  const c = enqueue(repo, "normal newest");
  const firstPriority = store.prioritizeJob(b.id, "2026-07-30T00:00:00.000Z");
  const secondPriority = store.prioritizeJob(a.id, "2026-07-30T00:00:01.000Z");
  assert.ok(secondPriority.queuePriority > firstPriority.queuePriority);
  assert.equal(store.readJobEvents(a.id).at(-1).reason, "queue:prioritized");
  const claimedA = store.claimNextJob("priority-worker-a");
  assert.equal(claimedA.id, a.id);
  store.completeJob(a.id, { state: "canceled", phase: null, finishedAt: new Date().toISOString(), delivery: { status: "not-started" } });
  const claimedB = store.claimNextJob("priority-worker-b");
  assert.equal(claimedB.id, b.id);
  store.completeJob(b.id, { state: "canceled", phase: null, finishedAt: new Date().toISOString(), delivery: { status: "not-started" } });
  assert.equal(store.claimNextJob("priority-worker-c").id, c.id);
  assert.throws(() => store.prioritizeJob(c.id), /only queued jobs/);
  store.completeJob(c.id, { state: "canceled", phase: null, finishedAt: new Date().toISOString(), delivery: { status: "not-started" } });
});

test("queue state is authoritative and missing derived events are diagnosed without mutation", () => {
  store.setQueuePaused(true, "queue-reconcile", "2026-07-30T02:00:00.000Z");
  store.setQueuePaused(false, "queue-reconcile", "2026-07-30T02:01:00.000Z");
  const state = store.readQueueState();
  const events = store.readQueueEvents();
  const removedRevision = state.revision;
  writeFileSync(store.QUEUE_EVENTS_PATH, events.filter((event) => event.revision !== removedRevision).map((event) => JSON.stringify(event)).join("\n") + "\n");
  assert.equal(store.readQueueState().paused, false, "derived log loss cannot alter queue state");
  const before = readFileSync(store.QUEUE_EVENTS_PATH, "utf8");
  assert.deepEqual(store.inspectQueueAudit().missingRevisions, [removedRevision]);
  assert.equal(readFileSync(store.QUEUE_EVENTS_PATH, "utf8"), before, "diagnosis must not invent queue history");
  store.setQueuePaused(true, "queue-after-gap", "2026-07-30T02:02:00.000Z");
  assert.equal(store.readQueueState().paused, true);
  assert.ok(store.readQueueEvents().some((event) => event.reason !== "queue:event-reconciled" && event.revision === removedRevision + 1));
  store.setQueuePaused(false, "queue-after-gap", "2026-07-30T02:03:00.000Z");
});

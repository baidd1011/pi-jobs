import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pi-jobs-store-"));
process.env.PI_JOBS_DATA_DIR = join(root, "jobs-data");
process.env.PI_JOBS_LEGACY_DIR = join(root, "no-legacy");
const store = await import(`../lib/store.mjs?store=${Date.now()}`);

const fields = (prompt = "test") => ({
  prompt, repoRoot: root, baseRef: "main", baseCommit: "a".repeat(40),
  budgetUsd: 1, timeoutMin: 1, maxTurns: 10,
});

test("heartbeat is separate from authoritative revisions and events", () => {
  const job = store.createJob(fields("heartbeat"));
  const before = readFileSync(store.EVENTS_PATH, "utf8");
  store.writeHeartbeat(job.id, "worker-a", "2026-01-01T00:00:00.000Z");
  assert.equal(store.readJob(job.id).revision, 1);
  assert.equal(readFileSync(store.EVENTS_PATH, "utf8"), before);
  assert.equal(store.isHeartbeatStale(job.id, new Date("2026-01-01T00:05:00.001Z").getTime()), true);
  store.clearHeartbeat(job.id);
  assert.equal(existsSync(store.heartbeatPath(job.id)), false);
  store.completeJob(job.id, { state: "canceled", phase: null, delivery: { status: "not-started" } });
});

test("non-semantic worktree metadata persists without creating an audit transition", () => {
  const job = store.createJob(fields("metadata"));
  const before = readFileSync(store.EVENTS_PATH, "utf8");
  const updated = store.updateJobMetadata(job.id, { branch: `pi-jobs-${job.id}`, worktreePath: join(root, "worktrees", job.id) });
  assert.equal(updated.revision, job.revision);
  assert.equal(readFileSync(store.EVENTS_PATH, "utf8"), before);
  store.completeJob(job.id, { state: "canceled", phase: null, delivery: { status: "not-started" } });
});

test("queued cancel is immediate, audited, and clears its marker", () => {
  const job = store.createJob(fields("cancel queued"));
  const at = "2026-03-01T01:02:03.004Z";
  const canceled = store.requestCancel(job.id, "test", at);
  assert.equal(canceled.state, "canceled");
  assert.equal(canceled.delivery.status, "not-started");
  assert.equal(canceled.stopRequestedAt, at);
  assert.equal(existsSync(store.cancelPath(job.id)), false);
  const events = readFileSync(store.EVENTS_PATH, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse).filter((event) => event.jobId === job.id);
  assert.equal(events.at(-1).reason, "stop:canceled");
});

test("claim observes a cancel marker written before the job lock is obtained", () => {
  const job = store.createJob(fields("claim cancel race"));
  store.atomicWriteJson(store.cancelPath(job.id), { jobId: job.id, requestedAt: "2026-04-01T00:00:00.000Z", source: "race" });
  const claimed = store.claimNextJob("worker-race");
  assert.equal(claimed.state, "canceled");
  assert.equal(store.readJob(job.id).state, "canceled");
  assert.equal(existsSync(store.cancelPath(job.id)), false);
});

test("stop arbitration uses requested time then deterministic same-millisecond priority", () => {
  const laterBudget = { cause: "overbudget", requestedAt: "2026-01-01T00:00:01.000Z" };
  const earlierCancel = { cause: "canceled", requestedAt: "2026-01-01T00:00:00.500Z" };
  assert.deepEqual(store.chooseStopCause(laterBudget, earlierCancel), earlierCancel);
  const at = "2026-01-01T00:00:00.000Z";
  assert.equal(store.chooseStopCause({ cause: "timeout", requestedAt: at }, { cause: "overbudget", requestedAt: at }).cause, "overbudget");
  assert.equal(store.chooseStopCause({ cause: "overbudget", requestedAt: at }, { cause: "canceled", requestedAt: at }).cause, "canceled");
});

test("terminal write observes a running cancel marker and emits stop then terminal revisions", () => {
  const created = store.createJob(fields("cancel during finalizing"));
  const running = store.claimNextJob("worker-finalizing");
  assert.equal(running.id, created.id);
  const at = "2026-05-01T01:02:03.004Z";
  store.atomicWriteJson(store.cancelPath(created.id), { jobId: created.id, requestedAt: at, source: "test" });
  const terminal = store.completeJob(created.id, {
    state: "done", phase: null, finishedAt: new Date().toISOString(),
    delivery: { type: "branch", status: "no-changes", branch: null, commit: null },
  });
  assert.equal(terminal.state, "canceled");
  assert.equal(terminal.stopRequestedAt, at);
  const events = readFileSync(store.EVENTS_PATH, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse).filter((event) => event.jobId === created.id);
  assert.deepEqual(events.slice(-2).map((event) => event.reason), ["stop:canceled", "terminal:canceled"]);
});

test("cleanup-needed overrides stopCause while preserving it for audit", () => {
  const created = store.createJob(fields("cleanup priority"));
  store.claimNextJob("worker-cleanup-priority");
  store.recordStopRequest(created.id, "overbudget", "2026-05-02T00:00:00.000Z");
  const terminal = store.completeJob(created.id, {
    state: "failed", phase: null, statusDetail: "cleanup-needed",
    delivery: { type: "branch", status: "failed" },
  });
  assert.equal(terminal.state, "failed");
  assert.equal(terminal.statusDetail, "cleanup-needed");
  assert.equal(terminal.stopCause, "overbudget");
});

test("job ids reject path traversal", () => {
  assert.equal(store.readJob("../outside"), null);
  assert.throws(() => store.requestCancel("../outside"), /invalid job id/);
  assert.throws(() => store.createJob(fields("bad id"), { id: "../outside" }), /invalid job id/);
});

test("missing revisions are derived without duplicating existing jobId+revision events", () => {
  const job = store.createJob(fields("audit repair"));
  const mutated = { ...job, revision: 3, state: "running", phase: "agent", updatedAt: new Date().toISOString() };
  store.atomicWriteJson(store.jobPath(job.id), mutated);
  assert.equal(store.reconcileEvents(), 2);
  assert.equal(store.reconcileEvents(), 0);
  const events = readFileSync(store.EVENTS_PATH, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse).filter((event) => event.jobId === job.id);
  assert.deepEqual(events.map((event) => event.revision).sort(), [1, 2, 3]);
  assert.equal(events.find((event) => event.revision === 2).from.state, "queued");
});

test("stale runner lock is stealable and release verifies its token", () => {
  store.ensureDirs();
  writeFileSync(store.RUNNER_LOCK_PATH, `4294967294\n0\nstale-token\n0\n`);
  const lock = store.acquireRunnerLock();
  assert.equal(lock.held, false);
  store.releaseRunnerLock({ ...lock, token: "wrong" });
  assert.equal(existsSync(store.RUNNER_LOCK_PATH), true);
  store.releaseRunnerLock(lock);
  assert.equal(existsSync(store.RUNNER_LOCK_PATH), false);
});

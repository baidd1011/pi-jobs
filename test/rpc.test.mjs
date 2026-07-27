import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const fakePi = join(here, "..", "fake-pi.fixture.mjs");
const fakePiCmd = join(here, "..", "fake-pi.cmd");
const cwd = mkdtempSync(join(tmpdir(), "pi-jobs-rpc-"));
process.env.PI_JOBS_DATA_DIR = join(cwd, "data");
const { runPiTask, selectStopCandidate } = await import(`../lib/rpc.mjs?rpc=${Date.now()}`);

const task = (extra = {}) => ({ id: `rpc-${Math.random()}`, prompt: "test", worktreePath: cwd, budgetUsd: 1, timeoutMin: 1, maxTurns: 10, ...extra });
const config = (mode, extra = {}) => ({
  piPath: process.execPath, piArgs: [fakePi, mode], provider: null, model: null,
  costSource: "stats", statsPollMs: 20, cancelPollMs: 10, abortGraceMs: 500, finalStatsMs: 10, maxTurns: 10,
  ...extra,
});

test("fake RPC completes and reports final stats without a provider", async () => {
  const usage = [];
  const result = await runPiTask(task(), config("done"), null, { onUsage: (value) => usage.push(value) });
  assert.equal(result.status, "done");
  assert.equal(result.cost, 0.003);
  assert.match(result.summary, /fake task complete/);
  assert.equal(usage.at(-1).cost, 0.003);
});

test("Windows cmd shim piPath is spawned successfully even when its path contains spaces", { skip: process.platform !== "win32" }, async () => {
  const result = await runPiTask(task(), { ...config("done"), piPath: fakePiCmd, piArgs: [] });
  assert.equal(result.status, "done");
});

test("default bare piPath resolves a pi.cmd from PATH on Windows", { skip: process.platform !== "win32" }, async () => {
  const bin = join(cwd, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "pi.cmd"), `@echo off\r\n"${process.execPath}" "${fakePi}" done %*\r\n`);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin};${previousPath}`;
  try {
    const result = await runPiTask(task(), { ...config("done"), piPath: "pi", piArgs: [] });
    assert.equal(result.status, "done");
  } finally { process.env.PATH = previousPath; }
});

test("settled model error is failed rather than done", async () => {
  const result = await runPiTask(task(), config("error"));
  assert.equal(result.status, "failed");
  assert.match(result.error, /fake 401/);
});

test("budget stop is persisted before abort and produces overbudget", async () => {
  const persisted = [];
  const result = await runPiTask(task({ budgetUsd: 0.1 }), config("budget"), null, {
    onStopRequested: (cause, requestedAt) => persisted.push({ cause, requestedAt }),
  });
  assert.equal(result.status, "overbudget");
  assert.equal(persisted[0].cause, "overbudget");
  assert.equal(result.stopRequestedAt, persisted[0].requestedAt);
});

test("cancel uses marker requestedAt, not polling discovery time", async () => {
  const requestedAt = "2026-06-01T00:00:00.123Z";
  const persisted = [];
  const result = await runPiTask(task(), config("wait"), null, {
    readCancel: () => ({ requestedAt, source: "test" }),
    onStopRequested: (cause, at) => persisted.push({ cause, at }),
  });
  assert.equal(result.status, "canceled");
  assert.equal(result.stopRequestedAt, requestedAt);
  assert.deepEqual(persisted[0], { cause: "canceled", at: requestedAt });
});

test("max turns maps to timeout with an explicit detail", async () => {
  const result = await runPiTask(task({ maxTurns: 1 }), config("max-turns"), null, { onStopRequested() {} });
  assert.equal(result.status, "timeout");
  assert.equal(result.statusDetail, "max-turns");
  assert.equal(result.stopCause, "max-turns");
});

test("same-millisecond stop ordering is canceled > overbudget > timeout > max-turns", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const winner = selectStopCandidate(
    { cause: "max-turns", requestedAt: at }, { cause: "timeout", requestedAt: at },
    { cause: "overbudget", requestedAt: at }, { cause: "canceled", requestedAt: at },
  );
  assert.equal(winner.cause, "canceled");
});

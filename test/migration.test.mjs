import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pi-jobs-migrate-"));
const legacy = join(root, "legacy-nightshift");
const data = join(root, "jobs-data");
process.env.PI_JOBS_DATA_DIR = data;
process.env.PI_JOBS_LEGACY_DIR = legacy;
const store = await import(`../lib/store.mjs?migration-store=${Date.now()}`);
const { migrateLegacyData } = await import(`../lib/migrate.mjs?migration=${Date.now()}`);

function git(repo, ...args) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function makeRepo() {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "migration-test");
  git(repo, "config", "user.email", "migration@example.invalid");
  writeFileSync(join(repo, "base.txt"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-m", "base");
  return repo;
}
function snapshot(dir, prefix = "") {
  const result = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = join(prefix, entry.name); const path = join(dir, entry.name);
    if (entry.isDirectory()) for (const [key, value] of snapshot(path, rel)) result.set(key, value);
    else result.set(rel, readFileSync(path));
  }
  return result;
}

test("legacy migration is idempotent and leaves every old byte untouched", () => {
  const repo = makeRepo();
  const head = git(repo, "rev-parse", "HEAD");
  mkdirSync(join(legacy, "results", "2026-01-01"), { recursive: true });
  mkdirSync(join(legacy, "queue"), { recursive: true });
  writeFileSync(join(legacy, "config.json"), "{\n  \"budgetUsd\": 3\n}\n");
  writeFileSync(join(legacy, "results", "2026-01-01", "ns-result.json"), JSON.stringify({ id: "ns-result", status: "done", prompt: "old result", cwd: repo, branch: "nightshift/ns-result", baseCommit: head, commit: "abc1234", costUsd: 0.2 }));
  writeFileSync(join(legacy, "queue", "ns-pending.json"), JSON.stringify({ id: "ns-pending", prompt: "old pending", cwd: repo, budgetUsd: 1, timeoutMin: 2 }));
  writeFileSync(join(legacy, "queue", "ns-running.running.json"), JSON.stringify({ id: "ns-running", prompt: "old running", cwd: repo, budgetUsd: 1, timeoutMin: 2, origHead: head, origBranch: "main" }));
  const before = snapshot(legacy);

  const first = migrateLegacyData();
  const second = migrateLegacyData();
  assert.equal(first.imported, 3);
  assert.equal(second.imported, 0);
  const after = snapshot(legacy);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [path, bytes] of before) assert.deepEqual(after.get(path), bytes, path);

  const result = store.readJob("ns-result");
  assert.equal(result.source, "legacy-nightshift");
  assert.equal(result.state, "done");
  const pending = store.readJob("ns-pending");
  assert.equal(pending.state, "queued");
  assert.equal(pending.baseCommit, head);
  assert.equal(pending.migrationBaseApproximate, true);
  const running = store.readJob("ns-running");
  assert.equal(running.state, "failed");
  assert.equal(running.statusDetail, "legacy-interrupted");
  assert.equal(running.delivery.branch, "nightshift/ns-running");
});

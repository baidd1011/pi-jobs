import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "pi-jobs-integration-"));
const data = join(root, "data");
const legacy = join(root, "missing-legacy");
process.env.PI_JOBS_DATA_DIR = data;
process.env.PI_JOBS_LEGACY_DIR = legacy;
const store = await import(`../lib/store.mjs?integration-store=${Date.now()}`);
const { inspectRepo } = await import(`../lib/gitops.mjs?integration-git=${Date.now()}`);

function git(repo, ...args) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function makeRepo() {
  const repo = join(root, "repo"); mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "integration-test"); git(repo, "config", "user.email", "integration@example.invalid");
  writeFileSync(join(repo, "base.txt"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-m", "base");
  return repo;
}

test("real worker entrypoint drains two jobs through the fake JSONL process with no duplicate or orphan", { skip: process.platform !== "win32" }, () => {
  const repo = makeRepo();
  const base = inspectRepo(repo);
  const first = store.createJob({ ...base, prompt: "first integration job", budgetUsd: 1, timeoutMin: 1, maxTurns: 10 });
  const second = store.createJob({ ...base, prompt: "second integration job", budgetUsd: 1, timeoutMin: 1, maxTurns: 10 });
  const invocations = join(root, "invocations.log");
  store.atomicWriteJson(join(data, "config.json"), {
    budgetUsd: 1, timeoutMin: 1, maxTurns: 10, provider: null, model: null,
    costSource: "stats", piPath: join(projectRoot, "fake-pi.cmd"), worktreeRoot: join(root, "worktrees"),
  });
  const result = spawnSync(process.execPath, [join(projectRoot, "runner", "run.mjs")], {
    env: {
      ...process.env, PI_JOBS_DATA_DIR: data, PI_JOBS_LEGACY_DIR: legacy,
      PI_JOBS_IDLE_POLL_MS: "10", PI_JOBS_EMPTY_SCANS: "2",
      FAKE_PI_CREATE: "integration-output.txt", FAKE_PI_INVOCATIONS: invocations,
    },
    encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  for (const id of [first.id, second.id]) {
    const job = store.readJob(id);
    assert.equal(job.state, "done");
    assert.equal(job.delivery.status, "branch-ready");
    assert.equal(job.costUsd, 0.003);
    assert.equal(git(repo, "show", `${job.delivery.branch}:integration-output.txt`), "created by fake pi");
    assert.equal(existsSync(store.heartbeatPath(id)), false);
  }
  assert.equal(readFileSync(invocations, "utf8").trim().split(/\r?\n/).length, 2);
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(existsSync(store.RUNNER_LOCK_PATH), false);
});

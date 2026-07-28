import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [packageRootArg, testRootArg, schedulerFlag] = process.argv.slice(2);
assert.ok(packageRootArg && testRootArg, "usage: acceptance-runtime.mjs <package-root> <test-root> [--scheduler]");

const packageRoot = resolve(packageRootArg);
const testRoot = resolve(testRootArg);
const dataRoot = process.env.PI_JOBS_DATA_DIR;
assert.ok(dataRoot, "PI_JOBS_DATA_DIR must be set before loading package modules");

const freshImport = (relative) => import(`${pathToFileURL(join(packageRoot, relative)).href}?acceptance=${Date.now()}-${Math.random()}`);
const store = await freshImport("lib/store.mjs");
const gitops = await freshImport("lib/gitops.mjs");

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const repo = join(testRoot, "repo");
mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
git(repo, "config", "user.name", "pi-jobs-acceptance");
git(repo, "config", "user.email", "acceptance@example.invalid");
writeFileSync(join(repo, "base.txt"), "base\n");
git(repo, "add", ".");
git(repo, "commit", "-m", "acceptance base");

const base = gitops.inspectRepo(repo);
const job = store.createJob({
  ...base,
  prompt: "acceptance delivery",
  budgetUsd: 1,
  timeoutMin: 1,
  maxTurns: 10,
});

const fakePi = join(packageRoot, "fake-pi.cmd");
assert.ok(existsSync(fakePi), `fake Pi shim missing: ${fakePi}`);
store.atomicWriteJson(join(dataRoot, "config.json"), {
  budgetUsd: 1,
  timeoutMin: 1,
  maxTurns: 10,
  provider: null,
  model: null,
  costSource: "stats",
  piPath: fakePi,
  worktreeRoot: join(testRoot, "worktrees"),
});

const worker = spawnSync(process.execPath, [join(packageRoot, "runner", "run.mjs")], {
  env: {
    ...process.env,
    PI_JOBS_IDLE_POLL_MS: "10",
    PI_JOBS_EMPTY_SCANS: "2",
    FAKE_PI_CREATE: "acceptance-output.txt",
  },
  encoding: "utf8",
  timeout: 30_000,
});
assert.equal(worker.status, 0, `worker failed\nstdout:\n${worker.stdout}\nstderr:\n${worker.stderr}`);

const completed = store.readJob(job.id);
assert.equal(completed.state, "done");
assert.equal(completed.delivery.status, "branch-ready");
assert.equal(git(repo, "show", `${completed.delivery.branch}:acceptance-output.txt`), "created by fake pi");
assert.equal(git(repo, "status", "--porcelain"), "");
assert.equal(existsSync(store.RUNNER_LOCK_PATH), false);

let schedulerChecked = false;
if (schedulerFlag === "--scheduler") {
  const scheduler = await freshImport("lib/scheduler.mjs");
  try {
    scheduler.setupScheduledTask();
    const report = scheduler.doctor();
    assert.equal(report.checks.find((check) => check.name === "Scheduled task")?.ok, true);
    assert.equal(report.checks.find((check) => check.name === "Scheduled runner path")?.ok, true);
    schedulerChecked = true;
  } finally {
    scheduler.uninstallScheduledTask();
  }
}

process.stdout.write(JSON.stringify({
  ok: true,
  jobId: job.id,
  delivery: completed.delivery.status,
  branch: completed.delivery.branch,
  schedulerChecked,
}) + "\n");

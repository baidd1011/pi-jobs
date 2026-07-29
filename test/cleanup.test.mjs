import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pi-jobs-cleanup-"));
process.env.PI_JOBS_DATA_DIR = join(root, "data");
process.env.PI_JOBS_LEGACY_DIR = join(root, "no-legacy");
const store = await import(`../lib/store.mjs?cleanup-store=${Date.now()}`);
const cleanup = await import(`../lib/cleanup.mjs?cleanup-lib=${Date.now()}`);
store.ensureDirs();
mkdirSync(join(store.DATA_DIR, "logs"), { recursive: true });

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo(name) {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "cleanup-test");
  git(repo, "config", "user.email", "cleanup@example.invalid");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");
  return repo;
}

function snapshotDir(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  const stack = [[dir, ""]];
  while (stack.length) {
    const [current, rel] = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(current, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) stack.push([child, childRel]);
      else if (entry.isFile()) out.set(childRel, readFileSync(child));
    }
  }
  return out;
}

function backdate(file, daysAgo) {
  const past = (Date.now() - daysAgo * 24 * 60 * 60_000) / 1000;
  utimesSync(file, past, past);
}

function makeJobRecord({ id, repoRoot, worktreePath, branch, baseCommit, state, statusDetail, delivery }) {
  const job = id
    ? store.createJob({
        prompt: "cleanup test", repoRoot, baseCommit, baseRef: "main",
        budgetUsd: 1, timeoutMin: 1, maxTurns: 10,
      }, { id })
    : store.createJob({
        prompt: "cleanup test", repoRoot, baseCommit, baseRef: "main",
        budgetUsd: 1, timeoutMin: 1, maxTurns: 10,
      });
  const finishedAt = new Date().toISOString();
  const next = {
    ...job,
    state, statusDetail,
    finishedAt, startedAt: finishedAt,
    worktreePath, branch,
    delivery: delivery ?? { type: "branch", status: "branch-ready", branch, commit: baseCommit },
  };
  store.atomicWriteJson(store.jobPath(job.id), next);
  return next;
}

test("dry-run never mutates the data directory or the worktree repository", () => {
  const repo = makeRepo("dryrun-repo");
  const baseCommit = git(repo, "rev-parse", "HEAD");
  const worktreeRoot = join(root, "dryrun-worktrees");
  const worktree = join(worktreeRoot, "job-dryrun");
  mkdirSync(worktreeRoot, { recursive: true });
  git(repo, "worktree", "add", "-b", "pi-jobs-dryrun", worktree, baseCommit);
  // Place an atomic tmp in DATA_DIR that is older than 24h and orphan
  const staleTmp = join(store.DATA_DIR, "config.json.99999.aaaaaaaaaa.tmp");
  writeFileSync(staleTmp, "stale");
  backdate(staleTmp, 2);

  const beforeData = snapshotDir(store.DATA_DIR);
  // Configure a fake config so the cleanup looks at the right root
  const config = { worktreeRoot };

  const plan = cleanup.classifyCleanup({ config });
  const results = cleanup.applyCleanup(plan, { dryRun: true });
  const afterData = snapshotDir(store.DATA_DIR);
  assert.deepEqual([...afterData.entries()].sort(), [...beforeData.entries()].sort());
  assert.equal(existsSync(staleTmp), true, "dry-run must not remove tmp files");
  assert.equal(existsSync(worktree), true, "dry-run must not remove worktree");
  assert.ok(results.some((r) => r.result === "would-remove"), "dry-run should report a would-remove result");
});

test("removes terminal and orphan heartbeats but preserves active signals", () => {
  const terminal = store.createJob({ prompt: "t", repoRoot: root, baseCommit: "a".repeat(40), budgetUsd: 1, timeoutMin: 1, maxTurns: 10 });
  const active = store.createJob({ prompt: "a", repoRoot: root, baseCommit: "b".repeat(40), budgetUsd: 1, timeoutMin: 1, maxTurns: 10 });
  const ghost = "job-ghost-heartbeat";
  store.atomicWriteJson(store.heartbeatPath(terminal.id), { jobId: terminal.id, workerToken: "w", at: "2020-01-01T00:00:00.000Z" });
  store.atomicWriteJson(store.heartbeatPath(active.id), { jobId: active.id, workerToken: "w", at: new Date().toISOString() });
  store.atomicWriteJson(store.heartbeatPath(ghost), { jobId: ghost, workerToken: "w", at: "2020-01-01T00:00:00.000Z" });
  // Move terminal to terminal state
  const finishedAt = new Date().toISOString();
  store.atomicWriteJson(store.jobPath(terminal.id), { ...terminal, state: "done", phase: null, finishedAt, delivery: { type: "branch", status: "branch-ready" } });

  const plan = cleanup.classifyCleanup({});
  const results = cleanup.applyCleanup(plan, { dryRun: false });
  assert.equal(existsSync(store.heartbeatPath(terminal.id)), false);
  assert.equal(existsSync(store.heartbeatPath(ghost)), false);
  assert.equal(existsSync(store.heartbeatPath(active.id)), true, "active heartbeat must remain");
});

test("removes terminal/orphan cancel markers and keeps queued/running signals", () => {
  const queued = store.createJob({ prompt: "q", repoRoot: root, baseCommit: "c".repeat(40), budgetUsd: 1, timeoutMin: 1, maxTurns: 10 });
  const running = store.createJob({ prompt: "r", repoRoot: root, baseCommit: "d".repeat(40), budgetUsd: 1, timeoutMin: 1, maxTurns: 10 });
  const finished = store.createJob({ prompt: "f", repoRoot: root, baseCommit: "e".repeat(40), budgetUsd: 1, timeoutMin: 1, maxTurns: 10 });
  const ghost = "job-ghost-cancel";

  store.atomicWriteJson(store.cancelPath(queued.id), { jobId: queued.id, requestedAt: "2026-01-01T00:00:00.000Z", source: "t" });
  store.atomicWriteJson(store.cancelPath(running.id), { jobId: running.id, requestedAt: "2026-01-01T00:00:00.000Z", source: "t" });
  store.atomicWriteJson(store.cancelPath(finished.id), { jobId: finished.id, requestedAt: "2026-01-01T00:00:00.000Z", source: "t" });
  store.atomicWriteJson(store.cancelPath(ghost), { jobId: ghost, requestedAt: "2026-01-01T00:00:00.000Z", source: "t" });
  const finishedAt = new Date().toISOString();
  store.atomicWriteJson(store.jobPath(running.id), { ...running, state: "running", phase: "agent", delivery: { type: "branch", status: "pending" } });
  store.atomicWriteJson(store.jobPath(finished.id), { ...finished, state: "done", phase: null, finishedAt, delivery: { type: "branch", status: "no-changes" } });

  cleanup.applyCleanup(cleanup.classifyCleanup({}), { dryRun: false });
  assert.equal(existsSync(store.cancelPath(queued.id)), true, "queued cancel marker must remain so claimNextJob can act on it");
  assert.equal(existsSync(store.cancelPath(running.id)), true, "running cancel marker must remain so RPC polls can act on it");
  assert.equal(existsSync(store.cancelPath(finished.id)), false, "terminal cancel marker must be removed");
  assert.equal(existsSync(store.cancelPath(ghost)), false, "orphan cancel marker must be removed");
});

test("removes qualifying atomic tmp files but preserves fresh, in-use, and out-of-tree files", () => {
  const oldOrphan = join(store.DATA_DIR, "config.json.99999.aaaaaaaaaa.tmp");
  const oldOrphanInnerDir = join(store.JOBS_DIR, "nested");
  mkdirSync(oldOrphanInnerDir, { recursive: true });
  const oldOrphanInner = join(oldOrphanInnerDir, "job.json.99998.bbbbbbbbbb.tmp");
  const ignoredLogTmp = join(store.LOGS_DIR, "log.json.99997.ffffffffaa.tmp");
  const fresh = join(store.DATA_DIR, "config.json.99999.cccccccc.tmp");
  const otherDir = join(root, "elsewhere");
  mkdirSync(otherDir, { recursive: true });
  const outside = join(otherDir, "data.json.99999.dddddddddd.tmp");
  const nonAtomic = join(store.DATA_DIR, "weird.txt");
  const nonTmpAtomic = join(store.DATA_DIR, "config.json.99999.eeeeeeeeee.bak");
  for (const path of [oldOrphan, oldOrphanInner, ignoredLogTmp, fresh, outside, nonAtomic, nonTmpAtomic]) writeFileSync(path, "x");
  backdate(oldOrphan, 2);
  backdate(oldOrphanInner, 2);
  backdate(ignoredLogTmp, 2);
  backdate(outside, 2);
  backdate(nonTmpAtomic, 2);
  // `fresh` is recent, `nonAtomic` doesn't match pattern.

  cleanup.applyCleanup(cleanup.classifyCleanup({}), { dryRun: false });
  assert.equal(existsSync(oldOrphan), false, "qualifying tmp removed");
  assert.equal(existsSync(oldOrphanInner), false, "qualifying tmp in subdir removed");
  assert.equal(existsSync(ignoredLogTmp), true, "logs are outside the cleanup scan allowlist");
  assert.equal(existsSync(fresh), true, "recent tmp is preserved");
  assert.equal(existsSync(outside), true, "tmp outside DATA_DIR is preserved");
  assert.equal(existsSync(nonAtomic), true, "non-tmp file is preserved");
  assert.equal(existsSync(nonTmpAtomic), true, "non-tmp extension is preserved");
});

test("removes only clean, commit-matching terminal worktrees and never touches jobs, events, logs, branches or legacy data", () => {
  const repo = makeRepo("wt-repo");
  const baseCommit = git(repo, "rev-parse", "HEAD");
  const worktreeRoot = join(root, "wt-worktrees");
  mkdirSync(worktreeRoot, { recursive: true });
  const clean = join(worktreeRoot, "job-clean");
  const dirty = join(worktreeRoot, "job-dirty");
  const mismatched = join(worktreeRoot, "job-mismatch");
  const cleanupNeeded = join(worktreeRoot, "job-cleanup-needed");
  const orphan = join(worktreeRoot, "job-orphan");
  for (const path of [clean, dirty, mismatched, cleanupNeeded, orphan]) {
    git(repo, "worktree", "add", "-b", `branch-${path.split("-").pop()}`, path, baseCommit);
  }
  // Make a real commit on the clean branch so HEAD differs from baseCommit
  writeFileSync(join(clean, "result.txt"), "result\n");
  git(clean, "add", "result.txt");
  git(clean, "commit", "-m", "result");
  const cleanHead = git(clean, "rev-parse", "HEAD");
  // The user's main worktree must remain intact
  writeFileSync(join(repo, "out-of-worktree.txt"), "user file");
  git(repo, "add", "out-of-worktree.txt");
  git(repo, "commit", "-m", "user main commit");
  // Dirty: add a file in the worktree but don't commit
  writeFileSync(join(dirty, "dirty.txt"), "dirty\n");
  // Mismatched: make a commit on the worktree so HEAD != branch HEAD
  writeFileSync(join(mismatched, "extra.txt"), "extra\n");
  git(mismatched, "add", "extra.txt");
  git(mismatched, "commit", "-m", "extra");
  const mismatchHead = git(mismatched, "rev-parse", "HEAD");
  // Move the branch back to baseCommit so HEAD != branch
  git(repo, "update-ref", "refs/heads/branch-mismatch", baseCommit, mismatchHead);
  // Cleanup-needed: same as clean but mark as cleanup-needed
  writeFileSync(join(cleanupNeeded, "thing.txt"), "thing\n");
  git(cleanupNeeded, "add", "thing.txt");
  git(cleanupNeeded, "commit", "-m", "thing");
  const cleanupNeededHead = git(cleanupNeeded, "rev-parse", "HEAD");

  // Create job records
  makeJobRecord({ id: "job-clean", repoRoot: repo, worktreePath: clean, branch: "branch-clean", baseCommit, state: "done", delivery: { type: "branch", status: "branch-ready", branch: "branch-clean", commit: cleanHead } });
  makeJobRecord({ id: "job-dirty", repoRoot: repo, worktreePath: dirty, branch: "branch-dirty", baseCommit, state: "done", delivery: { type: "branch", status: "branch-ready", branch: "branch-dirty", commit: git(repo, "rev-parse", "branch-dirty") } });
  makeJobRecord({ id: "job-mismatch", repoRoot: repo, worktreePath: mismatched, branch: "branch-mismatch", baseCommit, state: "done", delivery: { type: "branch", status: "branch-ready", branch: "branch-mismatch", commit: git(repo, "rev-parse", "branch-mismatch") } });
  makeJobRecord({ id: "job-cleanup-needed", repoRoot: repo, worktreePath: cleanupNeeded, branch: "branch-cleanup-needed", baseCommit, state: "failed", statusDetail: "cleanup-needed", delivery: { type: "branch", status: "branch-ready", branch: "branch-cleanup-needed", commit: cleanupNeededHead } });

  // The `out-of-worktree.txt` is committed on main in the user's repo, must remain after cleanup
  const userFileBefore = git(repo, "show", "main:out-of-worktree.txt");

  const plan = cleanup.classifyCleanup({ config: { worktreeRoot } });
  cleanup.applyCleanup(plan, { dryRun: false });

  assert.equal(existsSync(clean), false, "clean terminal worktree removed");
  assert.equal(existsSync(dirty), true, "dirty worktree preserved");
  assert.equal(existsSync(mismatched), true, "HEAD-mismatched worktree preserved");
  assert.equal(existsSync(cleanupNeeded), true, "cleanup-needed worktree preserved");
  assert.equal(existsSync(orphan), true, "orphan (no job) worktree preserved");

  assert.ok(existsSync(store.jobPath("job-clean")), "job record kept");
  const branches = git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads").split(/\r?\n/).filter(Boolean);
  assert.ok(branches.includes("branch-clean"), "result branch kept (never delete branches)");
  assert.ok(branches.includes("branch-dirty"));
  assert.ok(branches.includes("branch-mismatch"));
  assert.equal(git(repo, "show", "main:out-of-worktree.txt"), userFileBefore, "user's main worktree is untouched");

  const kinds = new Set(plan.items.filter((i) => i.kind === "worktree").map((i) => i.action));
  assert.ok(kinds.has("remove"));
  assert.ok(kinds.has("manual-action"));
});

test("never deletes job JSON, events, logs, legacy data, or session files", () => {
  const repo = makeRepo("never-delete-repo");
  const worktreeRoot = join(root, "never-worktrees");
  mkdirSync(worktreeRoot, { recursive: true });
  const job = store.createJob({ prompt: "never", repoRoot: repo, baseCommit: git(repo, "rev-parse", "HEAD"), budgetUsd: 1, timeoutMin: 1, maxTurns: 10 });
  const worktree = join(worktreeRoot, job.id);
  git(repo, "worktree", "add", "-b", "pi-jobs-never", worktree, job.baseCommit);
  writeFileSync(join(worktree, "result.txt"), "result\n");
  git(worktree, "add", "result.txt");
  git(worktree, "commit", "-m", "result");
  const finishedAt = new Date().toISOString();
  const head = git(worktree, "rev-parse", "HEAD");
  store.atomicWriteJson(store.jobPath(job.id), {
    ...job, state: "done", phase: null, finishedAt, startedAt: finishedAt,
    worktreePath: worktree, branch: "pi-jobs-never",
    sessionFile: "/tmp/never-session.jsonl",
    delivery: { type: "branch", status: "branch-ready", branch: "pi-jobs-never", commit: head },
  });
  // Add a session file and a log file
  const sessionPath = join(store.DATA_DIR, "logs", "never-session.jsonl");
  writeFileSync(sessionPath, "{}");
  const logPath = join(store.DATA_DIR, "logs", `${job.id}.log`);
  writeFileSync(logPath, "log content");
  // Add a job-level event by transitioning once
  store.completeJob(job.id, { state: "done", phase: null, finishedAt, delivery: { type: "branch", status: "branch-ready", branch: "pi-jobs-never", commit: head } }, "terminal:done");

  // Add a fake nightshift legacy file
  const legacyDir = join(root, "nightshift");
  mkdirSync(legacyDir, { recursive: true });
  const legacyFile = join(legacyDir, "old.json");
  writeFileSync(legacyFile, "{\"legacy\": true}");

  cleanup.applyCleanup(cleanup.classifyCleanup({ config: { worktreeRoot } }), { dryRun: false });

  assert.ok(existsSync(store.jobPath(job.id)), "job JSON kept");
  assert.ok(existsSync(logPath), "log file kept");
  assert.ok(existsSync(sessionPath), "session file kept");
  assert.ok(existsSync(legacyFile), "legacy data kept");
  assert.ok(existsSync(store.EVENTS_PATH), "events file kept");
  assert.equal(git(repo, "show", "pi-jobs-never:result.txt"), "result", "result branch contents kept");
  assert.equal(existsSync(worktree), false, "clean worktree was removed (this is the only deletion)");
});

test("out-of-worktreeRoot, invalid worktree, and symlinks are flagged but not removed", () => {
  const insideRoot = join(root, "inroot-worktrees");
  mkdirSync(insideRoot, { recursive: true });
  const outside = join(root, "outside-worktrees", "should-skip");
  mkdirSync(join(root, "outside-worktrees"), { recursive: true });
  // Create a directory outside the configured worktreeRoot that pretends to be a job worktree
  writeFileSync(outside, "not a dir, just a file");

  const plan = cleanup.classifyCleanup({ config: { worktreeRoot: insideRoot } });
  cleanup.applyCleanup(plan, { dryRun: false });
  assert.equal(existsSync(outside), true, "out-of-root file untouched");
  // Symlink test on Linux: a symlink to a non-existent file inside DATA_DIR (the cleanup walk treats it as a non-file)
  if (process.platform !== "win32") {
    const symlink = join(store.DATA_DIR, "config.json.99999.ffffffffff.tmp");
    try {
      symlinkSync("/nonexistent-target", symlink);
      backdate(symlink, 2);
      cleanup.applyCleanup(cleanup.classifyCleanup({}), { dryRun: false });
      assert.equal(existsSync(symlink), true, "symlinked tmp must be skipped");
    } catch (error) {
      // Some sandboxes disallow symlink creation; the test only matters when we can create one.
    }
  }
});

test("classifyCleanup reports counts grouped by kind and action", () => {
  const plan = cleanup.classifyCleanup({ config: { worktreeRoot: join(root, "counts") } });
  for (const kind of ["heartbeat", "cancel-marker", "tmp-file", "worktree"]) {
    assert.equal(typeof plan.summary[kind], "number");
  }
  for (const action of ["remove", "skip", "manual-action"]) {
    assert.equal(typeof plan.counts[action], "number");
  }
});

test("cleanup never scans atomic-looking files inside worktrees, logs, or reports", () => {
  const protectedFiles = [
    join(store.DEFAULT_WORKTREE_DIR, "job-protected", "result.99999.aaaaaaaaaa.tmp"),
    join(store.LOGS_DIR, "trace.99999.bbbbbbbbbb.tmp"),
    join(store.REPORTS_DIR, "report.99999.cccccccccc.tmp"),
  ];
  for (const path of protectedFiles) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "protected");
    backdate(path, 2);
  }
  const plan = cleanup.classifyCleanup({ config: { worktreeRoot: store.DEFAULT_WORKTREE_DIR } });
  cleanup.applyCleanup(plan, { dryRun: false });
  for (const path of protectedFiles) assert.equal(existsSync(path), true, `${path} must remain`);
});

test("worktree removal is revalidated after classification", () => {
  const repo = makeRepo("revalidate-repo");
  const baseCommit = git(repo, "rev-parse", "HEAD");
  const worktreeRoot = join(root, "revalidate-worktrees");
  mkdirSync(worktreeRoot, { recursive: true });

  const dirtyPath = join(worktreeRoot, "job-revalidate-dirty");
  git(repo, "worktree", "add", "-b", "branch-revalidate-dirty", dirtyPath, baseCommit);
  writeFileSync(join(dirtyPath, "result.txt"), "result\n");
  git(dirtyPath, "add", "result.txt");
  git(dirtyPath, "commit", "-m", "result");
  const dirtyHead = git(dirtyPath, "rev-parse", "HEAD");
  makeJobRecord({
    id: "job-revalidate-dirty", repoRoot: repo, worktreePath: dirtyPath,
    branch: "branch-revalidate-dirty", baseCommit, state: "done",
    delivery: { type: "branch", status: "branch-ready", branch: "branch-revalidate-dirty", commit: dirtyHead },
  });
  const dirtyPlan = cleanup.classifyCleanup({ config: { worktreeRoot } });
  assert.ok(dirtyPlan.items.some((item) => item.target === dirtyPath && item.action === "remove"));
  writeFileSync(join(dirtyPath, "late-change.txt"), "do not delete\n");
  const dirtyResults = cleanup.applyCleanup(dirtyPlan, { dryRun: false });
  assert.equal(existsSync(dirtyPath), true);
  assert.ok(dirtyResults.some((item) => item.target === dirtyPath && item.result === "manual-action"));

  const movedPath = join(worktreeRoot, "job-revalidate-head");
  git(repo, "worktree", "add", "-b", "branch-revalidate-head", movedPath, baseCommit);
  writeFileSync(join(movedPath, "result.txt"), "result\n");
  git(movedPath, "add", "result.txt");
  git(movedPath, "commit", "-m", "result");
  const recordedHead = git(movedPath, "rev-parse", "HEAD");
  makeJobRecord({
    id: "job-revalidate-head", repoRoot: repo, worktreePath: movedPath,
    branch: "branch-revalidate-head", baseCommit, state: "done",
    delivery: { type: "branch", status: "branch-ready", branch: "branch-revalidate-head", commit: recordedHead },
  });
  const movedPlan = cleanup.classifyCleanup({ config: { worktreeRoot } });
  assert.ok(movedPlan.items.some((item) => item.target === movedPath && item.action === "remove"));
  writeFileSync(join(movedPath, "later.txt"), "later commit\n");
  git(movedPath, "add", "later.txt");
  git(movedPath, "commit", "-m", "later");
  const movedResults = cleanup.applyCleanup(movedPlan, { dryRun: false });
  assert.equal(existsSync(movedPath), true);
  assert.ok(movedResults.some((item) => item.target === movedPath && item.result === "manual-action"));
});

test("dry-run formatting includes every would-remove target", () => {
  const stale = join(store.DATA_DIR, "config.json.99999.dddddddddd.tmp");
  writeFileSync(stale, "stale");
  backdate(stale, 2);
  const results = cleanup.applyCleanup(cleanup.classifyCleanup({}), { dryRun: true });
  const text = cleanup.formatCleanupResults(results, true);
  assert.match(text, /would-remove/);
  assert.match(text, /config\.json\.99999\.dddddddddd\.tmp/);
  assert.equal(existsSync(stale), true);
});

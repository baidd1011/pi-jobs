import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pi-jobs-report-"));
process.env.PI_JOBS_DATA_DIR = join(root, "data");
process.env.PI_JOBS_LEGACY_DIR = join(root, "no-legacy");
const store = await import(`../lib/store.mjs?report-store=${Date.now()}`);
const report = await import(`../lib/report.mjs?report-lib=${Date.now()}`);
const { sendWindowsToast } = await import(`../lib/notify.mjs?report-notify=${Date.now()}`);

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo(name) {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "report-test");
  git(repo, "config", "user.email", "report@example.invalid");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");
  return repo;
}

function makeJob(overrides = {}) {
  const repo = overrides.repo ?? makeRepo("repo-" + Math.random().toString(36).slice(2, 8));
  const baseCommit = overrides.baseCommit ?? git(repo, "rev-parse", "HEAD");
  const job = store.createJob({
    prompt: overrides.prompt ?? "audit test",
    repoRoot: overrides.repoRoot ?? repo,
    baseRef: overrides.baseRef ?? "main",
    baseCommit,
    budgetUsd: overrides.budgetUsd ?? 1,
    timeoutMin: overrides.timeoutMin ?? 1,
    maxTurns: overrides.maxTurns ?? 10,
    provider: overrides.provider ?? "test-provider",
    model: overrides.model ?? "test-model",
    dirtyAtSubmit: overrides.dirtyAtSubmit ?? false,
    policy: overrides.policy,
    queuePriority: overrides.queuePriority,
    deliveryType: overrides.deliveryType,
  });
  const now = new Date().toISOString();
  const finishedAt = overrides.finishedAt ?? now;
  const revision = (job.revision ?? 1) + 1;
  const next = {
    ...job,
    schemaVersion: overrides.schemaVersion ?? 3,
    state: overrides.state ?? "done",
    phase: null,
    statusDetail: overrides.statusDetail ?? null,
    costUsd: overrides.costUsd ?? 0,
    tokens: overrides.tokens ?? null,
    sessionFile: overrides.sessionFile ?? null,
    durationSec: overrides.durationSec ?? 0,
    filesChanged: overrides.filesChanged ?? [],
    summary: overrides.summary ?? null,
    error: overrides.error ?? null,
    stopCause: overrides.stopCause ?? null,
    stopRequestedAt: overrides.stopRequestedAt ?? null,
    startedAt: overrides.startedAt ?? now,
    finishedAt,
    updatedAt: finishedAt,
    delivery: overrides.delivery ?? { type: "branch", status: "branch-ready", branch: "pi-jobs-x", commit: "abc1234" },
    runtime: overrides.runtime ?? { provider: "test-provider", model: "test-model", piVersion: "1.0.0", piPath: "/usr/bin/pi", capturedAt: finishedAt },
    revision,
  };
  store.atomicWriteJson(store.jobPath(job.id), next);
  return { job: next, repo };
}

test("formatCost, formatDuration, formatTimestamp use the audit formatters", () => {
  assert.equal(report.formatCost(0.1), "$0.1000");
  assert.equal(report.formatCost(Number.NaN), "unknown / not recorded");
  assert.equal(report.formatDuration(3725), "1h2m5s");
  assert.equal(report.formatDuration(0), "0s");
  assert.equal(report.formatDuration(-1), "unknown / not recorded");
  assert.equal(report.formatTimestamp("2026-07-29T01:02:03.004Z"), "2026-07-29 01:02:03Z");
  assert.equal(report.formatTimestamp("not-a-date"), "unknown / not recorded");
});

test("buildDigest groups by state, falls back to updatedAt, and never double-counts cleanup-needed", () => {
  const now = new Date("2026-07-29T12:00:00.000Z");
  const oneHourAgo = new Date(now.getTime() - 60 * 60_000).toISOString();
  const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60_000).toISOString();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();

  const recentDone = makeJob({ state: "done", finishedAt: oneHourAgo, costUsd: 0.1, durationSec: 60 });
  const recentTimeout = makeJob({ state: "timeout", finishedAt: oneHourAgo, statusDetail: "max-turns", costUsd: 0.05, durationSec: 30, stopCause: "max-turns" });
  const recentCanceled = makeJob({ state: "canceled", finishedAt: oneHourAgo, costUsd: 0, durationSec: 5, stopCause: "canceled" });
  const cleanupInWindow = makeJob({ state: "failed", finishedAt: oneHourAgo, statusDetail: "cleanup-needed", costUsd: 0.02, durationSec: 12 });
  const cleanupOutOfWindow = makeJob({ state: "failed", finishedAt: twoDaysAgo, statusDetail: "cleanup-needed", costUsd: 0.03, durationSec: 99 });
  const oldDone = makeJob({ state: "done", finishedAt: twoDaysAgo, costUsd: 9.99, durationSec: 9999 });
  const fallback = makeJob({ state: "done", finishedAt: undefined, costUsd: 0.07, durationSec: 22 });
  // manually erase finishedAt to force updatedAt fallback
  const fbPath = store.jobPath(fallback.job.id);
  const fbJob = JSON.parse(readFileSync(fbPath, "utf8"));
  fbJob.finishedAt = null;
  fbJob.updatedAt = oneDayAgo;
  store.atomicWriteJson(fbPath, fbJob);

  const digest = report.buildDigest({ hours: 24, jobs: store.listJobs({ all: true }), now });
  assert.equal(digest.counts.done, 2, "done count includes fallback");
  assert.equal(digest.counts.failed, 1, "failed group only counts the max-turns timeout");
  assert.equal(digest.counts.canceled, 1);
  assert.equal(digest.counts.cleanupNeeded, 2);
  assert.equal(digest.totals.count, 4, "cleanup-needed must not be in totals");
  assert.equal(Math.abs(digest.totals.cost - (0.1 + 0.05 + 0 + 0.07)) < 1e-9, true, "cost total excludes cleanup-needed");
  assert.equal(digest.totals.durationSec, 60 + 30 + 5 + 22);
  const fallbackEntry = digest.groups.done.find((entry) => entry.id === fallback.job.id);
  assert.equal(fallbackEntry.usedUpdatedAtFallback, true);
  const oldEntry = digest.groups.done.find((entry) => entry.id === oldDone.job.id);
  assert.equal(oldEntry, undefined, "old done is outside 24h window");
  assert.equal(digest.cleanupNeeded.length, 2);
  assert.ok(digest.cleanupNeeded.find((entry) => entry.id === cleanupInWindow.job.id));
  assert.ok(digest.cleanupNeeded.find((entry) => entry.id === cleanupOutOfWindow.job.id));
});

test("digest review commands render for branch-ready jobs and not for no-changes", () => {
  const repo = makeRepo("review-repo");
  const baseCommit = git(repo, "rev-parse", "HEAD");
  const { job: doneJob } = makeJob({ state: "done", delivery: { status: "branch-ready", branch: "pi-jobs-review", commit: "abc1234" }, baseCommit, repoRoot: repo });
  const { job: noChangeJob } = makeJob({ state: "done", delivery: { status: "no-changes", branch: null, commit: null }, baseCommit, repoRoot: repo });
  const digest = report.buildDigest({ hours: 24, jobs: [doneJob, noChangeJob], now: new Date() });
  const doneEntry = digest.groups.done.find((entry) => entry.id === doneJob.id);
  assert.match(doneEntry.reviewCommand, new RegExp(`git -C "${repo.replace(/\\/g, "\\\\")}" diff ${baseCommit.slice(0, 12)}`));
  const noChangeEntry = digest.groups.done.find((entry) => entry.id === noChangeJob.id);
  assert.equal(noChangeEntry.reviewCommand, null);
});

test("digest markdown writer produces independent files for repeated runs", () => {
  const { job } = makeJob({ state: "done", finishedAt: new Date().toISOString() });
  const digest = report.buildDigest({ hours: 24, jobs: [job] });
  const a = report.writeDigestReport(digest, { now: new Date("2026-07-29T12:00:00.000Z") });
  const b = report.writeDigestReport(digest, { now: new Date("2026-07-29T12:00:01.000Z") });
  assert.notEqual(a, b);
  assert.ok(existsSync(a));
  assert.ok(existsSync(b));
  const aContent = readFileSync(a, "utf8");
  const bContent = readFileSync(b, "utf8");
  assert.match(aContent, /# pi-jobs digest \(last 24h\)/);
  assert.match(bContent, /# pi-jobs digest \(last 24h\)/);
});

test("audit report dedupes and sorts events, fills missing revisions, and reports unknown for legacy jobs", () => {
  const { job } = makeJob({ state: "done", finishedAt: "2026-07-29T12:00:00.000Z" });
  // Plant duplicate events with the same revision and a future one
  const eventsPath = store.EVENTS_PATH;
  const events = readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const jobEvents = events.filter((e) => e.jobId === job.id);
  // Write a duplicate of the first event to test dedup
  jobEvents.push({ ...jobEvents[0] });
  // Write a revision that doesn't exist on the job to test that we don't pick it up
  const outOfRange = { jobId: job.id, revision: 999, from: { state: "done" }, to: { state: "done" }, reason: "noise", at: "2026-07-29T13:00:00.000Z" };
  const all = [...events, jobEvents[jobEvents.length - 1], outOfRange];
  writeFileSync(eventsPath, all.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const audit = report.buildAudit(job.id);
  assert.equal(audit.available, true);
  const revisions = audit.timeline.map((line) => Number(line.match(/r(\d+)/)[1])).sort((a, b) => a - b);
  assert.deepEqual(revisions, [...new Set(revisions)], "no duplicate revisions");
  assert.ok(!revisions.includes(999), "out-of-range event is ignored");
  assert.equal(audit.snapshot, false, "terminal job is not a snapshot");
  assert.equal(audit.job.runtime.provider, "test-provider");
  assert.equal(audit.job.runtime.piVersion, "1.0.0");
  assert.match(audit.timeline[0], /r1/);
});

test("audit report marks running jobs as snapshot and tolerates a missing branch", () => {
  const { job } = makeJob({ state: "running", phase: "agent", delivery: { status: "pending", branch: null, commit: null }, finishedAt: null });
  // overwrite the file we just wrote via makeJob because it sets finishedAt
  const path = store.jobPath(job.id);
  const current = JSON.parse(readFileSync(path, "utf8"));
  current.state = "running"; current.phase = "agent"; current.finishedAt = null; current.delivery = { status: "pending", branch: null, commit: null };
  store.atomicWriteJson(path, current);
  const audit = report.buildAudit(job.id);
  assert.equal(audit.available, true);
  assert.equal(audit.snapshot, true);
  assert.equal(audit.git.available, false, "no result branch means git is unavailable");
  assert.match(audit.git.reason, /no result branch/);
  const markdown = report.renderAuditMarkdown(audit);
  assert.match(markdown, /snapshot/i);
  assert.match(markdown, /unavailable/);
});

test("audit for legacy v1 job renders unknown fields without faking them", () => {
  const { job } = makeJob({ schemaVersion: 1, runtime: null, tokens: null, costUsd: null, durationSec: 0, delivery: { status: "not-started", branch: null, commit: null } });
  const path = store.jobPath(job.id);
  const current = JSON.parse(readFileSync(path, "utf8"));
  current.schemaVersion = 1;
  current.runtime = null;
  current.costUsd = null;
  current.tokens = null;
  current.durationSec = 0;
  current.delivery = { status: "not-started", branch: null, commit: null };
  store.atomicWriteJson(path, current);
  const audit = report.buildAudit(job.id);
  assert.equal(audit.job.runtime.provider, "unknown / not recorded");
  assert.equal(audit.job.runtime.piVersion, "unknown / not recorded");
  assert.equal(report.formatCost(audit.job.costUsd), "unknown / not recorded");
});

test("audit report includes a git stat and name-status summary when the repo and branch are usable", () => {
  const repo = makeRepo("git-summary-repo");
  const baseCommit = git(repo, "rev-parse", "HEAD");
  // Make a worktree-style commit on a branch
  git(repo, "checkout", "-b", "pi-jobs-git-summary");
  writeFileSync(join(repo, "new.txt"), "new\n");
  git(repo, "add", "new.txt");
  git(repo, "commit", "-m", "new file");
  const { job } = makeJob({ state: "done", repoRoot: repo, baseCommit, delivery: { status: "branch-ready", branch: "pi-jobs-git-summary", commit: git(repo, "rev-parse", "--short", "HEAD") } });
  const audit = report.buildAudit(job.id);
  assert.equal(audit.git.available, true);
  assert.match(audit.git.stat, /new.txt/);
  assert.ok(audit.git.files.some((line) => line.includes("new.txt")));
  const markdown = report.renderAuditMarkdown(audit);
  assert.match(markdown, /git diff --stat/i);
  assert.match(markdown, /`git -C /);
});

test("audit report writes a stable, non-conflicting path under reports/audits", () => {
  const { job } = makeJob({ state: "done" });
  const audit = report.buildAudit(job.id);
  const path = report.writeAuditReport(audit);
  assert.equal(dirname(path), store.AUDITS_DIR);
  assert.match(basename(path), new RegExp(`^${job.id}-r\\d+\\.md$`));
  const md = readFileSync(path, "utf8");
  assert.match(md, /# pi-jobs audit/);
  // Re-running with the same job+revision is idempotent and overwrites the same file
  const path2 = report.writeAuditReport(audit);
  assert.equal(path, path2);
});

test("digest and audit markdown render unknown for old schema without faking", () => {
  const { job } = makeJob({ schemaVersion: 1, runtime: null });
  const audit = report.buildAudit(job.id);
  const md = report.renderAuditMarkdown(audit);
  assert.match(md, /unknown \/ not recorded/);
  assert.doesNotMatch(md, /piVersion/);
});

test("sendWindowsToast degrades on non-Windows and never throws", () => {
  const result = sendWindowsToast({ title: "hi", body: "world" });
  if (process.platform === "win32") {
    assert.equal(typeof result.ok, "boolean");
  } else {
    assert.equal(result.ok, false);
    assert.match(result.error, /non-windows/);
  }
});

test("Windows toast passes arguments out-of-band and always removes its temporary script", () => {
  const toastDir = mkdtempSync(join(tmpdir(), "pi-jobs-toast-test-"));
  let invocation;
  let script;
  const result = sendWindowsToast(
    { title: "Title <&>", body: "Body 'quoted'", appId: "test.app" },
    {
      platform: "win32", tempDir: toastDir, nonce: "fixed",
      execFile: (command, args) => {
        invocation = { command, args };
        script = readFileSync(args[args.indexOf("-File") + 1], "utf8");
        return "";
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(invocation.command, "powershell.exe");
  assert.deepEqual(invocation.args.slice(-3), ["Title <&>", "Body 'quoted'", "test.app"]);
  assert.match(script, /CreateTextNode/);
  assert.doesNotMatch(script, /Title <&>/, "toast content must not be interpolated into PowerShell source");
  assert.equal(existsSync(join(toastDir, `pi-jobs-toast-${process.pid}-fixed.ps1`)), false);

  const failed = sendWindowsToast(
    { title: "title", body: "body" },
    { platform: "win32", tempDir: toastDir, nonce: "failure", execFile: () => { throw new Error("boom"); } },
  );
  assert.equal(failed.ok, false);
  assert.equal(existsSync(join(toastDir, `pi-jobs-toast-${process.pid}-failure.ps1`)), false);
});

test("timeout detail, relative session paths, and digest task text preserve recorded facts", () => {
  const wall = makeJob({ state: "timeout", statusDetail: null, sessionFile: "relative-session.jsonl", prompt: "wall timeout task", summary: "partial output" }).job;
  const wallAudit = report.buildAudit(wall.id);
  assert.equal(wallAudit.job.statusDetail, null);
  assert.equal(wallAudit.paths.sessionFile, "relative-session.jsonl");
  assert.equal(wallAudit.paths.sessionFileRelative, true);
  assert.match(report.renderAuditMarkdown(wallAudit), /relative path as recorded/);

  const turns = makeJob({ state: "timeout", statusDetail: "max-turns" }).job;
  assert.equal(report.buildAudit(turns.id).job.statusDetail, "max-turns");

  const digest = report.buildDigest({ jobs: [wall], now: new Date() });
  const rendered = report.renderDigestMarkdown(digest);
  assert.match(rendered, /wall timeout task/);
  assert.match(rendered, /partial output/);
  assert.doesNotMatch(rendered, /timeout \(max-turns\)/);
});

test("digest report names remain unique within the same millisecond", () => {
  const now = new Date("2026-07-29T12:00:00.000Z");
  const digest = report.buildDigest({ jobs: [], now });
  const first = report.writeDigestReport(digest, { now });
  const second = report.writeDigestReport(digest, { now });
  assert.notEqual(first, second);
  assert.ok(existsSync(first));
  assert.ok(existsSync(second));
});

test("buildAudit returns a structured not-available result for unknown jobs", () => {
  const audit = report.buildAudit("does-not-exist");
  assert.equal(audit.available, false);
  assert.match(audit.reason, /no such job/);
});

test("digest with no jobs produces an empty result and renders without throwing", () => {
  const digest = report.buildDigest({ hours: 24, jobs: [], now: new Date("2026-07-29T12:00:00.000Z") });
  assert.equal(digest.totals.count, 0);
  assert.equal(digest.counts.cleanupNeeded, 0);
  const text = report.renderDigestText(digest);
  assert.match(text, /pi-jobs digest/);
  const md = report.renderDigestMarkdown(digest);
  assert.match(md, /# pi-jobs digest/);
  const path = report.writeDigestReport(digest, { now: new Date("2026-07-29T12:00:00.000Z") });
  assert.ok(existsSync(path));
});

test("schema v4 audit renders requested/effective policy and Draft PR delivery", () => {
  const policy = { tools: ["read", "grep", "find"], noNetwork: true, maxTurns: 20 };
  const { job } = makeJob({
    schemaVersion: 4,
    policy,
    queuePriority: 7,
    deliveryType: "pr",
    delivery: {
      type: "pr", status: "pr-ready", branch: "pi-jobs-policy-audit", commit: "abc1234",
      prUrl: "https://github.com/example/project/pull/42", prNumber: 42, prState: "OPEN", prDraft: true,
    },
    runtime: {
      provider: "test-provider", model: "test-model", piVersion: "1.2.3", piPath: "pi",
      capturedAt: new Date().toISOString(), policy,
    },
  });
  const markdown = report.renderAuditMarkdown(report.buildAudit(job.id));
  assert.match(markdown, /Requested policy.*read,grep,find.*no-network `true`.*max-turns `20`/);
  assert.match(markdown, /Effective policy.*read,grep,find.*no-network `true`.*max-turns `20`/);
  assert.match(markdown, /Draft PR https:\/\/github\.com\/example\/project\/pull\/42/);
});

test("digest reports authoritative global pause state", () => {
  store.setQueuePaused(true, "report-test", "2026-07-30T00:00:00.000Z");
  try {
    const digest = report.buildDigest({ jobs: [], now: new Date("2026-07-30T01:00:00.000Z") });
    assert.equal(digest.queue.paused, true);
    assert.match(report.renderDigestMarkdown(digest), /Queue is \*\*PAUSED\*\*/);
  } finally {
    store.setQueuePaused(false, "report-test", "2026-07-30T01:01:00.000Z");
  }
});

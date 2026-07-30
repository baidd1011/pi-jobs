import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const root = mkdtempSync(join(tmpdir(), "pi-jobs-hardening-"));
process.env.PI_JOBS_DATA_DIR = join(root, "data");
process.env.PI_JOBS_LEGACY_DIR = join(root, "missing-legacy");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "{}\n");

const store = await import(`../lib/store.mjs?hardening=${Date.now()}`);
const scheduler = await import(`../lib/scheduler.mjs?hardening=${Date.now()}`);
const report = await import(`../lib/report.mjs?hardening=${Date.now()}`);
const { redactSensitive } = await import(`../lib/redact.mjs?hardening=${Date.now()}`);

function queued(prompt = "valid task") {
  return store.createJob({
    prompt, repoRoot: root, baseCommit: "a".repeat(40), budgetUsd: 1, timeoutMin: 2, maxTurns: 10,
    policy: { tools: ["read", "edit", "write"], noNetwork: true, maxTurns: 10 },
  });
}

test("malformed or invalid config fails closed, remains byte-identical, and doctor stays read-only", () => {
  const valid = store.loadConfig();
  assert.equal(valid.maxTurns, 200);
  const pending = queued("must remain queued");

  const truncated = '{"budgetUsd": 2, "piPath":';
  writeFileSync(store.CONFIG_PATH, truncated);
  assert.throws(() => store.loadConfig(), /config parse/);
  assert.equal(readFileSync(store.CONFIG_PATH, "utf8"), truncated);
  const inspection = store.inspectConfig();
  assert.equal(inspection.ok, false);
  assert.equal(inspection.errorType, "parse");
  const doctor = scheduler.doctor();
  const configCheck = doctor.checks.find((check) => check.name === "Configuration");
  assert.equal(configCheck.ok, false);
  assert.match(configCheck.detail, /doctor did not modify it/);
  assert.equal(readFileSync(store.CONFIG_PATH, "utf8"), truncated);

  const run = spawnSync(process.execPath, [join(packageRoot, "runner", "run.mjs")], {
    cwd: packageRoot, encoding: "utf8", env: { ...process.env }, timeout: 20_000,
  });
  assert.notEqual(run.status, 0);
  assert.equal(store.readJob(pending.id).state, "queued", "worker must exit before claiming");
  assert.equal(readFileSync(store.CONFIG_PATH, "utf8"), truncated);
  const runnerLog = readdirSync(store.LOGS_DIR).find((name) => name.startsWith("runner-"));
  assert.ok(runnerLog);
  assert.match(readFileSync(join(store.LOGS_DIR, runnerLog), "utf8"), /configuration error; no job was claimed/);

  const invalid = '{"maxTurns": 0}\n';
  writeFileSync(store.CONFIG_PATH, invalid);
  assert.throws(() => store.loadConfig(), /maxTurns must be a positive integer/);
  assert.equal(readFileSync(store.CONFIG_PATH, "utf8"), invalid);

  rmSync(store.CONFIG_PATH);
  mkdirSync(store.CONFIG_PATH);
  const unreadable = store.inspectConfig();
  assert.equal(unreadable.ok, false);
  assert.notEqual(unreadable.errorType, "parse");
  rmSync(store.CONFIG_PATH, { recursive: true });
  store.saveConfig(valid);
  store.requestCancel(pending.id, "test-cleanup");
});

test("job health scan preserves bad files and valid jobs remain claimable", () => {
  const valid = queued("healthy task");
  const badJson = join(store.JOBS_DIR, "bad-json.json");
  const mismatch = join(store.JOBS_DIR, "wrong-name.json");
  const missing = join(store.JOBS_DIR, "job-missing-prompt.json");
  writeFileSync(badJson, "{broken");
  writeFileSync(mismatch, JSON.stringify({ id: "job-other", state: "queued", prompt: "x", revision: 1 }));
  writeFileSync(missing, JSON.stringify({ id: "job-missing-prompt", state: "queued", revision: 1 }));
  const before = new Map([badJson, mismatch, missing].map((path) => [path, readFileSync(path)]));

  const scan = store.scanJobRecords();
  assert.ok(scan.jobs.some((job) => job.id === valid.id));
  assert.equal(scan.issues.length, 3);
  assert.deepEqual(scan.issues.map((issue) => issue.path).sort(), [...before.keys()].sort());
  assert.equal(store.readJob("job-missing-prompt"), null);
  const claimed = store.claimNextJob("health-worker");
  assert.equal(claimed.id, valid.id);
  for (const [path, bytes] of before) assert.deepEqual(readFileSync(path), bytes);
  store.completeJob(valid.id, { state: "canceled", phase: null, delivery: { status: "not-started" } });
});

test("sensitive external errors are redacted in authoritative state, logs, and audit without touching normal text", () => {
  const token = `ghp_${"A".repeat(36)}`;
  const fineToken = `github_pat_${"B".repeat(30)}`;
  const credentialUrl = "https://alice:super-secret@github.com/example/project.git";
  const raw = `Authorization: Bearer ${token}; ${fineToken}; ${credentialUrl}`;
  const cleaned = redactSensitive(raw);
  assert.doesNotMatch(cleaned, /super-secret|ghp_|github_pat_|Bearer\s+[A-Z]/);
  assert.match(cleaned, /\[REDACTED\]/);

  const job = queued("ordinary prompt remains intact");
  store.appendJobLog(job.id, `fake gh failed: ${raw}`);
  store.completeJob(job.id, {
    state: "failed", phase: null, statusDetail: "delivery-failed", error: raw,
    delivery: { type: "pr", status: "failed", branch: `pi-jobs-${job.id}`, error: raw },
  });
  const saved = JSON.stringify(store.readJob(job.id));
  const log = store.readJobLog(job.id);
  const audit = report.renderAuditMarkdown(report.buildAudit(job.id));
  for (const output of [saved, log, audit]) {
    assert.doesNotMatch(output, /super-secret|ghp_|github_pat_/);
    assert.match(output, /\[REDACTED\]/);
  }
  assert.match(audit, /ordinary prompt remains intact/);
  assert.match(audit, /Local result branch/);
  assert.match(audit, /push.*manually/i);
});

test("queue audit gaps are reported without fabricating events", () => {
  store.setQueuePaused(true, "hardening", "2026-07-30T08:00:00.000Z");
  store.setQueuePaused(false, "hardening", "2026-07-30T08:01:00.000Z");
  const state = store.readQueueState();
  const events = store.readQueueEvents().filter((event) => event.revision !== state.revision);
  writeFileSync(store.QUEUE_EVENTS_PATH, events.map(JSON.stringify).join("\n") + "\n");
  const before = readFileSync(store.QUEUE_EVENTS_PATH);
  assert.deepEqual(store.inspectQueueAudit().missingRevisions, [state.revision]);
  const doctor = scheduler.doctor();
  const check = doctor.checks.find((item) => item.name === "Queue audit");
  assert.equal(check.ok, false);
  assert.match(check.detail, /was not modified/);
  assert.deepEqual(readFileSync(store.QUEUE_EVENTS_PATH), before);
});

test("terminal next-action hints are deterministic", () => {
  const cleanup = { id: "cleanup-1", statusDetail: "cleanup-needed", worktreePath: "C:\\tmp\\job" };
  assert.match(report.nextAction(cleanup), /status --short.*diff.*cleanup --dry-run/);
  assert.match(report.nextAction({ id: "worker-1", statusDetail: "worker-error" }), /\/job log worker-1.*\/job audit worker-1/);
  assert.equal(report.nextAction({ id: "done-1", statusDetail: null }), null);
});

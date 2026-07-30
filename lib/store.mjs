import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { redactSensitive, safeError, sanitizeErrorFields } from "./redact.mjs";

export const DATA_DIR = process.env.PI_JOBS_DATA_DIR || join(homedir(), ".pi", "jobs");
export const JOBS_DIR = join(DATA_DIR, "jobs");
export const LOGS_DIR = join(DATA_DIR, "logs");
export const LOCKS_DIR = join(DATA_DIR, "locks");
export const CONTROL_DIR = join(DATA_DIR, "control");
export const HEARTBEATS_DIR = join(DATA_DIR, "heartbeats");
export const DEFAULT_WORKTREE_DIR = join(DATA_DIR, "worktrees");
export const REPORTS_DIR = join(DATA_DIR, "reports");
export const DIGESTS_DIR = join(REPORTS_DIR, "digests");
export const AUDITS_DIR = join(REPORTS_DIR, "audits");
export const EVENTS_PATH = join(DATA_DIR, "events.jsonl");
export const QUEUE_STATE_PATH = join(DATA_DIR, "queue-state.json");
export const QUEUE_EVENTS_PATH = join(DATA_DIR, "queue-events.jsonl");
export const RUNNER_LOCK_PATH = join(DATA_DIR, "runner.lock");
export const CONFIG_PATH = join(DATA_DIR, "config.json");

export const TERMINAL_STATES = new Set(["done", "failed", "overbudget", "timeout", "canceled"]);
const JOB_STATES = new Set(["queued", "running", ...TERMINAL_STATES]);
export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 5 * 60_000;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const DEFAULT_CONFIG = {
  budgetUsd: 2,
  timeoutMin: 30,
  maxTurns: 200,
  provider: null,
  model: null,
  costSource: "stats",
  piPath: "pi",
  worktreeRoot: DEFAULT_WORKTREE_DIR,
  tools: ["read", "bash", "edit", "write"],
  prRepositories: [],
};

export function ensureDirs() {
  for (const dir of [DATA_DIR, JOBS_DIR, LOGS_DIR, LOCKS_DIR, CONTROL_DIR, HEARTBEATS_DIR, DEFAULT_WORKTREE_DIR, REPORTS_DIR, DIGESTS_DIR, AUDITS_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, "wx");
    writeFileSync(fd, content);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } finally {
    if (fd != null) try { closeSync(fd); } catch {}
    if (existsSync(tmp)) try { unlinkSync(tmp); } catch {}
  }
}

export function atomicWriteJson(path, value) {
  atomicWrite(path, JSON.stringify(value, null, 2) + "\n");
}

function configFailure(code, detail) {
  const error = new Error(`config ${code} at ${CONFIG_PATH}: ${detail}`);
  error.name = "ConfigError";
  error.code = code;
  error.path = CONFIG_PATH;
  return error;
}

function invalidConfig(detail) { throw configFailure("invalid", detail); }

function validateConfig(raw = {}, { strict = true } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (strict) invalidConfig("root must be a JSON object");
    raw = {};
  }
  const allowedTools = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
  const present = (key) => Object.prototype.hasOwnProperty.call(raw, key);
  const number = (key, fallback, integer = false, max = Number.POSITIVE_INFINITY) => {
    if (!present(key)) return fallback;
    const value = raw[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max || (integer && !Number.isInteger(value))) {
      if (strict) invalidConfig(`${key} must be a positive ${integer ? "integer" : "number"}${Number.isFinite(max) ? ` no greater than ${max}` : ""}`);
      return fallback;
    }
    return value;
  };
  const nullableString = (key, fallback = null) => {
    if (!present(key)) return fallback;
    if (raw[key] == null || typeof raw[key] === "string") return raw[key];
    if (strict) invalidConfig(`${key} must be a string or null`);
    return fallback;
  };
  let tools = [...DEFAULT_CONFIG.tools];
  if (present("tools")) {
    if (!Array.isArray(raw.tools) || !raw.tools.length || raw.tools.some((tool) => typeof tool !== "string" || !allowedTools.has(tool))) {
      if (strict) invalidConfig("tools must be a non-empty array of supported tool names");
    } else tools = [...new Set(raw.tools)];
  }
  let prRepositories = [];
  if (present("prRepositories")) {
    if (!Array.isArray(raw.prRepositories)) {
      if (strict) invalidConfig("prRepositories must be an array");
    } else {
      const valid = raw.prRepositories.every((entry) => (
        entry && typeof entry.repoRoot === "string" && typeof entry.remoteName === "string"
          && typeof entry.remoteUrl === "string" && typeof entry.host === "string"
          && typeof entry.repository === "string" && typeof entry.baseBranch === "string"
          && typeof entry.ghPath === "string"
      ));
      if (!valid && strict) invalidConfig("prRepositories contains an invalid entry");
      prRepositories = raw.prRepositories.filter((entry) => (
        entry && typeof entry.repoRoot === "string" && typeof entry.remoteName === "string"
          && typeof entry.remoteUrl === "string" && typeof entry.host === "string"
          && typeof entry.repository === "string" && typeof entry.baseBranch === "string"
          && typeof entry.ghPath === "string"
      ));
    }
  }
  prRepositories = prRepositories.map((entry) => ({
    repoRoot: entry.repoRoot, remoteName: entry.remoteName, remoteUrl: entry.remoteUrl,
    host: entry.host, repository: entry.repository, baseBranch: entry.baseBranch,
    ghPath: entry.ghPath, configuredAt: entry.configuredAt ?? null,
  }));
  const costSource = present("costSource") ? raw.costSource : DEFAULT_CONFIG.costSource;
  if (!["stats", "events"].includes(costSource) && strict) invalidConfig("costSource must be stats or events");
  const nonEmptyString = (key, fallback) => {
    if (!present(key)) return fallback;
    if (typeof raw[key] === "string" && raw[key]) return raw[key];
    if (strict) invalidConfig(`${key} must be a non-empty string`);
    return fallback;
  };
  return {
    budgetUsd: number("budgetUsd", DEFAULT_CONFIG.budgetUsd),
    timeoutMin: number("timeoutMin", DEFAULT_CONFIG.timeoutMin),
    maxTurns: number("maxTurns", DEFAULT_CONFIG.maxTurns, true, 1000),
    provider: nullableString("provider"),
    model: nullableString("model"),
    costSource: ["stats", "events"].includes(costSource) ? costSource : DEFAULT_CONFIG.costSource,
    piPath: nonEmptyString("piPath", DEFAULT_CONFIG.piPath),
    worktreeRoot: nonEmptyString("worktreeRoot", DEFAULT_CONFIG.worktreeRoot),
    tools,
    prRepositories,
  };
}

export function inspectConfig() {
  if (!existsSync(CONFIG_PATH)) return { ok: true, exists: false, path: CONFIG_PATH, config: validateConfig({}) };
  try {
    const config = validateConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
    return { ok: true, exists: true, path: CONFIG_PATH, config };
  } catch (error) {
    const code = error?.name === "SyntaxError" ? "parse" : error?.code || "read";
    return { ok: false, exists: true, path: CONFIG_PATH, config: validateConfig({}), errorType: code, error: safeError(error) };
  }
}

export function loadConfig() {
  ensureDirs();
  if (!existsSync(CONFIG_PATH)) {
    const legacyPath = process.env.PI_JOBS_LEGACY_DIR
      ? join(process.env.PI_JOBS_LEGACY_DIR, "config.json")
      : join(homedir(), ".pi", "nightshift", "config.json");
    let config = { ...DEFAULT_CONFIG };
    try { if (existsSync(legacyPath)) config = validateConfig(JSON.parse(readFileSync(legacyPath, "utf8")), { strict: false }); } catch {}
    atomicWriteJson(CONFIG_PATH, config);
    return config;
  }
  let raw;
  try { raw = readFileSync(CONFIG_PATH, "utf8"); }
  catch (error) { throw configFailure(error?.code || "read", safeError(error)); }
  try { return validateConfig(JSON.parse(raw)); }
  catch (error) {
    if (error?.name === "ConfigError") throw error;
    throw configFailure("parse", safeError(error));
  }
}

export function saveConfig(raw) {
  ensureDirs();
  const config = validateConfig(raw);
  atomicWriteJson(CONFIG_PATH, config);
  return config;
}

export function isValidJobId(id) { return typeof id === "string" && JOB_ID_PATTERN.test(id); }
export function generateJobId(now = new Date()) { return `job-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(6).toString("hex")}`; }
function checkedId(id) { if (!isValidJobId(id)) throw new Error(`invalid job id: ${id}`); return id; }
export function jobPath(id) { return join(JOBS_DIR, `${checkedId(id)}.json`); }
export function heartbeatPath(id) { return join(HEARTBEATS_DIR, `${checkedId(id)}.json`); }
export function cancelPath(id) { return join(CONTROL_DIR, `${checkedId(id)}.cancel.json`); }
export function jobLogPath(id) { return join(LOGS_DIR, `${checkedId(id)}.log`); }

export function readJob(id) {
  try {
    const path = jobPath(id);
    const job = JSON.parse(readFileSync(path, "utf8"));
    return validateJobRecord(job, basename(path)) ? null : job;
  }
  catch { return null; }
}

function validateJobRecord(job, file) {
  if (!job || typeof job !== "object" || Array.isArray(job)) return "root must be a JSON object";
  if (!isValidJobId(job.id)) return "missing or invalid id";
  if (file !== `${job.id}.json`) return `filename does not match id ${job.id}`;
  if (!JOB_STATES.has(job.state)) return "missing or invalid state";
  if (typeof job.prompt !== "string") return "missing prompt";
  if (job.revision != null && (!Number.isSafeInteger(job.revision) || job.revision < 1)) return "invalid revision";
  if (job.schemaVersion != null && (!Number.isSafeInteger(job.schemaVersion) || job.schemaVersion < 1)) return "invalid schemaVersion";
  return null;
}

export function scanJobRecords({ all = true } = {}) {
  ensureDirs();
  const jobs = [];
  const issues = [];
  for (const file of readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json"))) {
    const path = join(JOBS_DIR, file);
    try {
      const job = JSON.parse(readFileSync(path, "utf8"));
      const problem = validateJobRecord(job, file);
      if (problem) issues.push({ path, file, code: "invalid-job", detail: problem });
      else if (all || !TERMINAL_STATES.has(job.state)) jobs.push(job);
    } catch (error) {
      issues.push({ path, file, code: error?.name === "SyntaxError" ? "parse-error" : error?.code || "read-error", detail: safeError(error) });
    }
  }
  jobs.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  issues.sort((a, b) => a.path.localeCompare(b.path));
  return { jobs, issues };
}

export function listJobs(options = {}) {
  return scanJobRecords(options).jobs;
}

export function createJob(fields, { id = null, source = "pi-jobs" } = {}) {
  ensureDirs();
  const now = new Date().toISOString();
  const jobId = id || generateJobId(new Date(now));
  checkedId(jobId);
  const job = {
    schemaVersion: 4,
    id: jobId,
    revision: 1,
    source,
    state: fields.state ?? "queued",
    phase: fields.phase ?? null,
    prompt: fields.prompt,
    repoRoot: fields.repoRoot,
    baseRef: fields.baseRef ?? null,
    baseCommit: fields.baseCommit ?? null,
    dirtyAtSubmit: Boolean(fields.dirtyAtSubmit),
    migrationBaseApproximate: Boolean(fields.migrationBaseApproximate),
    budgetUsd: fields.budgetUsd,
    timeoutMin: fields.timeoutMin,
    maxTurns: fields.policy?.maxTurns ?? fields.maxTurns,
    policy: fields.policy ?? {
      tools: [...(fields.tools || DEFAULT_CONFIG.tools)],
      noNetwork: Boolean(fields.noNetwork),
      maxTurns: fields.maxTurns,
    },
    queuePriority: Number.isSafeInteger(fields.queuePriority) ? fields.queuePriority : 0,
    provider: fields.provider ?? null,
    model: fields.model ?? null,
    branch: fields.branch ?? null,
    worktreePath: fields.worktreePath ?? null,
    retryOf: fields.retryOf ?? null,
    createdAt: fields.createdAt ?? now,
    updatedAt: now,
    startedAt: fields.startedAt ?? null,
    finishedAt: fields.finishedAt ?? null,
    cancelRequestedAt: fields.cancelRequestedAt ?? null,
    stopCause: fields.stopCause ?? null,
    stopRequestedAt: fields.stopRequestedAt ?? null,
    statusDetail: fields.statusDetail ?? null,
    costUsd: fields.costUsd ?? 0,
    tokens: fields.tokens ?? null,
    sessionFile: fields.sessionFile ?? null,
    durationSec: fields.durationSec ?? 0,
    filesChanged: fields.filesChanged ?? [],
    summary: fields.summary ?? null,
    error: fields.error == null ? null : redactSensitive(fields.error),
    delivery: sanitizeErrorFields({ delivery: fields.delivery ?? { type: fields.deliveryType ?? "branch", status: "not-started", branch: null, commit: null } }).delivery,
    runtime: fields.runtime ?? null,
  };
  const reservation = acquireShortLock(join(LOCKS_DIR, `create-${jobId}.lock`));
  try {
    const path = jobPath(jobId);
    if (existsSync(path)) throw new Error(`job id collision: ${jobId}`);
    atomicWriteJson(path, job);
  } finally { releaseShortLock(reservation); }
  appendEvent({ jobId, revision: 1, from: "?", to: viewState(job), reason: "created", at: now });
  return job;
}

function defaultQueueState() {
  return { schemaVersion: 1, revision: 0, paused: false, pausedAt: null, pausedBy: null, resumedAt: null };
}

export function readQueueState() {
  try {
    const state = JSON.parse(readFileSync(QUEUE_STATE_PATH, "utf8"));
    return { ...defaultQueueState(), ...state };
  } catch { return defaultQueueState(); }
}

function appendQueueEvent(event) {
  try { appendFileSync(QUEUE_EVENTS_PATH, JSON.stringify(event) + "\n"); return true; }
  catch { return false; }
}

export function readQueueEvents() {
  if (!existsSync(QUEUE_EVENTS_PATH)) return [];
  const byRevision = new Map();
  for (const line of readFileSync(QUEUE_EVENTS_PATH, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (Number.isSafeInteger(event?.revision) && !byRevision.has(event.revision)) byRevision.set(event.revision, event);
    } catch {}
  }
  return [...byRevision.values()].sort((a, b) => a.revision - b.revision);
}

export function inspectQueueAudit() {
  const state = readQueueState();
  const events = readQueueEvents();
  const revisions = new Set(events.map((event) => event.revision));
  const missingRevisions = [];
  for (let revision = 1; revision <= state.revision; revision++) {
    if (!revisions.has(revision)) missingRevisions.push(revision);
  }
  return { stateRevision: state.revision, eventCount: events.length, missingRevisions };
}

export function setQueuePaused(paused, by = "command", at = new Date().toISOString()) {
  return withDataLock("queue", () => {
    const current = readQueueState();
    if (current.paused === paused) return { ...current, changed: false };
    const next = {
      ...current, schemaVersion: 1, revision: current.revision + 1, paused,
      pausedAt: paused ? at : current.pausedAt,
      pausedBy: paused ? by : current.pausedBy,
      resumedAt: paused ? current.resumedAt : at,
      updatedAt: at,
    };
    atomicWriteJson(QUEUE_STATE_PATH, next);
    appendQueueEvent({ revision: next.revision, from: { paused: current.paused }, to: { paused }, by, at });
    return { ...next, changed: true };
  });
}

function viewState(job) { return { state: job.state, phase: job.phase ?? null }; }

function appendEvent(event) {
  try { appendFileSync(EVENTS_PATH, JSON.stringify(event) + "\n"); return true; }
  catch { return false; }
}

function parseEvents() {
  const events = [];
  if (!existsSync(EVENTS_PATH)) return events;
  for (const line of readFileSync(EVENTS_PATH, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
  return events;
}

export function reconcileEvents() {
  ensureDirs();
  return withDataLock("events-reconcile", reconcileEventsLocked);
}

export function readJobEvents(id) {
  const events = parseEvents().filter((event) => event?.jobId === id);
  const byKey = new Map();
  for (const event of events) if (!byKey.has(event.revision)) byKey.set(event.revision, event);
  return [...byKey.values()].sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0));
}

function reconcileEventsLocked() {
  const events = parseEvents();
  const byJob = new Map();
  for (const event of events) {
    if (!byJob.has(event.jobId)) byJob.set(event.jobId, new Map());
    if (!byJob.get(event.jobId).has(event.revision)) byJob.get(event.jobId).set(event.revision, event);
  }
  let repaired = 0;
  for (const job of listJobs()) {
    const indexed = byJob.get(job.id) ?? new Map();
    for (let revision = 1; revision <= job.revision; revision++) {
      if (indexed.has(revision)) continue;
      let previous = null;
      let next = null;
      for (const [candidateRevision, event] of indexed) {
        if (candidateRevision < revision && (!previous || candidateRevision > previous.revision)) previous = event;
        if (candidateRevision > revision && (!next || candidateRevision < next.revision)) next = event;
      }
      const event = {
        jobId: job.id, revision,
        from: previous?.to ?? "?",
        to: next?.from && next.from !== "?" ? next.from : viewState(job),
        reason: "event-reconciled",
        at: job.updatedAt ?? new Date().toISOString(),
      };
      if (appendEvent(event)) {
        indexed.set(revision, event);
        repaired++;
      }
    }
  }
  return repaired;
}

function acquireShortLock(path, staleMs = 30_000) {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const token = randomBytes(8).toString("hex");
      const fd = openSync(path, "wx");
      writeFileSync(fd, `${process.pid}\n${Date.now()}\n${token}\n`);
      closeSync(fd);
      return { path, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) { unlinkSync(path); continue; }
      } catch {}
      throw new Error(`lock busy: ${path}`);
    }
  }
  throw new Error(`could not acquire lock: ${path}`);
}

function releaseShortLock(lock) {
  try {
    const parts = readFileSync(lock.path, "utf8").split("\n");
    if (parts[2] === lock.token) unlinkSync(lock.path);
  } catch {}
}

export function withJobLock(id, fn) {
  const lock = acquireShortLock(join(LOCKS_DIR, `${checkedId(id)}.lock`));
  try { return fn(); }
  finally { releaseShortLock(lock); }
}

export function withDataLock(name, fn) {
  const lock = acquireShortLock(join(LOCKS_DIR, `${checkedId(name)}.lock`));
  try { return fn(); }
  finally { releaseShortLock(lock); }
}

function lockedTransition(id, patch, reason, at = new Date().toISOString()) {
  const current = readJob(id);
  if (!current) throw new Error(`job not found: ${id}`);
  const nextPatch = sanitizeErrorFields(typeof patch === "function" ? patch(current) : patch);
  if (nextPatch == null) return current;
  const next = { ...current, ...nextPatch, revision: (current.revision ?? 0) + 1, updatedAt: at };
  if (nextPatch.delivery) next.delivery = { ...current.delivery, ...nextPatch.delivery };
  atomicWriteJson(jobPath(id), next);
  appendEvent({ jobId: id, revision: next.revision, from: viewState(current), to: viewState(next), reason, at });
  return next;
}

export function transitionJob(id, patch, reason, at) {
  return withJobLock(id, () => lockedTransition(id, patch, reason, at));
}

export function updateJobMetadata(id, patch) {
  return withJobLock(id, () => {
    const current = readJob(id);
    if (!current) throw new Error(`job not found: ${id}`);
    const nextPatch = sanitizeErrorFields(typeof patch === "function" ? patch(current) : patch);
    if (nextPatch == null) return current;
    const next = { ...current, ...nextPatch, updatedAt: new Date().toISOString() };
    atomicWriteJson(jobPath(id), next);
    return next;
  });
}

export function claimNextJob(workerToken) {
  try { return withDataLock("queue", () => {
    if (readQueueState().paused) return null;
    const queued = listJobs().filter((job) => job.state === "queued").sort((a, b) => (
      (Number(b.queuePriority) || 0) - (Number(a.queuePriority) || 0)
      || String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""))
      || a.id.localeCompare(b.id)
    ));
    for (const candidate of queued) {
      try {
        const claimed = withJobLock(candidate.id, () => {
          const current = readJob(candidate.id);
          if (!current || current.state !== "queued") return null;
          const marker = readCancelMarker(candidate.id);
          if (marker) {
            const requestedAt = marker.requestedAt || new Date().toISOString();
            const canceled = lockedTransition(candidate.id, {
              state: "canceled", phase: null, cancelRequestedAt: requestedAt,
              stopCause: "canceled", stopRequestedAt: requestedAt, finishedAt: requestedAt,
              delivery: { status: "not-started" }, statusDetail: "canceled-before-start",
            }, "stop:canceled", requestedAt);
            clearCancelMarker(candidate.id);
            return canceled;
          }
          return lockedTransition(candidate.id, {
            state: "running", phase: "preparing", workerToken,
            startedAt: current.startedAt ?? new Date().toISOString(),
          }, "claimed");
        });
        if (claimed) return claimed;
      } catch {}
    }
    return null;
  }); } catch (error) {
    if (/lock busy/.test(`${error}`)) return null;
    throw error;
  }
}

export function prioritizeJob(id, at = new Date().toISOString()) {
  checkedId(id);
  return withDataLock("queue", () => {
    const maxPriority = listJobs().reduce((max, job) => Math.max(max, Number(job.queuePriority) || 0), 0);
    return withJobLock(id, () => {
      const current = readJob(id);
      if (!current) throw new Error(`job not found: ${id}`);
      if (current.state !== "queued") throw new Error(`only queued jobs can be prioritized: ${id}`);
      return lockedTransition(id, { queuePriority: maxPriority + 1, prioritizedAt: at }, "queue:prioritized", at);
    });
  });
}

const STOP_PRIORITY = { canceled: 4, overbudget: 3, timeout: 2, "max-turns": 1 };

export function chooseStopCause(current, candidate) {
  if (!current?.cause) return candidate;
  if (!candidate?.cause) return current;
  const currentMs = new Date(current.requestedAt).getTime();
  const candidateMs = new Date(candidate.requestedAt).getTime();
  if (Number.isFinite(candidateMs) && (!Number.isFinite(currentMs) || candidateMs < currentMs)) return candidate;
  if (candidateMs === currentMs && (STOP_PRIORITY[candidate.cause] ?? 0) > (STOP_PRIORITY[current.cause] ?? 0)) return candidate;
  return current;
}

export function recordStopRequest(id, cause, requestedAt = new Date().toISOString()) {
  return withJobLock(id, () => {
    const current = readJob(id);
    if (!current || TERMINAL_STATES.has(current.state)) return current;
    const winner = chooseStopCause(
      current.stopCause ? { cause: current.stopCause, requestedAt: current.stopRequestedAt } : null,
      { cause, requestedAt },
    );
    if (winner.cause === current.stopCause && winner.requestedAt === current.stopRequestedAt) return current;
    return lockedTransition(id, {
      stopCause: winner.cause,
      stopRequestedAt: winner.requestedAt,
      statusDetail: winner.cause === "max-turns" ? "max-turns" : null,
    }, `stop:${winner.cause}`, winner.requestedAt);
  });
}

function terminalForCause(cause) {
  if (cause === "max-turns") return { state: "timeout", statusDetail: "max-turns" };
  if (["canceled", "overbudget", "timeout"].includes(cause)) return { state: cause };
  return null;
}

export function completeJob(id, patch, reason = null) {
  const result = withJobLock(id, () => {
    let current = readJob(id);
    if (!current) throw new Error(`job not found: ${id}`);
    if (TERMINAL_STATES.has(current.state)) return current;
    const marker = readCancelMarker(id);
    const winner = chooseStopCause(
      current.stopCause ? { cause: current.stopCause, requestedAt: current.stopRequestedAt } : null,
      marker?.requestedAt ? { cause: "canceled", requestedAt: marker.requestedAt } : null,
    );
    if (winner && (winner.cause !== current.stopCause || winner.requestedAt !== current.stopRequestedAt)) {
      current = lockedTransition(id, {
        stopCause: winner.cause, stopRequestedAt: winner.requestedAt,
        cancelRequestedAt: winner.cause === "canceled" ? winner.requestedAt : current.cancelRequestedAt,
        statusDetail: winner.cause === "max-turns" ? "max-turns" : null,
      }, `stop:${winner.cause}`, winner.requestedAt);
    }
    const cleanupFailed = patch.statusDetail === "cleanup-needed" || patch.delivery?.status === "failed";
    const forced = cleanupFailed ? null : terminalForCause(current.stopCause);
    const finalPatch = { ...patch, ...(forced ?? {}) };
    return lockedTransition(id, finalPatch, reason || `terminal:${finalPatch.state}`);
  });
  if (TERMINAL_STATES.has(result.state)) clearCancelMarker(id);
  return result;
}

export function writeHeartbeat(id, workerToken, at = new Date().toISOString()) {
  atomicWriteJson(heartbeatPath(id), { jobId: id, workerToken, at });
}

export function readHeartbeat(id) {
  try { return JSON.parse(readFileSync(heartbeatPath(id), "utf8")); }
  catch { return null; }
}

export function clearHeartbeat(id) { try { unlinkSync(heartbeatPath(id)); } catch {} }

export function isHeartbeatStale(id, now = Date.now()) {
  const beat = readHeartbeat(id);
  const at = beat ? new Date(beat.at).getTime() : NaN;
  return !Number.isFinite(at) || now - at > STALE_MS;
}

export function readCancelMarker(id) {
  try { return JSON.parse(readFileSync(cancelPath(id), "utf8")); }
  catch { return null; }
}

export function clearCancelMarker(id) { try { unlinkSync(cancelPath(id)); } catch {} }

export function requestCancel(id, source = "command", requestedAt = new Date().toISOString()) {
  const marker = { jobId: id, requestedAt, source };
  atomicWriteJson(cancelPath(id), marker);
  let result;
  try {
    result = withJobLock(id, () => {
      const current = readJob(id);
      if (!current) throw new Error(`job not found: ${id}`);
      if (TERMINAL_STATES.has(current.state)) return current;
      if (current.state === "queued" && !current.worktreePath) {
        return lockedTransition(id, {
          state: "canceled", phase: null, cancelRequestedAt: requestedAt,
          stopCause: "canceled", stopRequestedAt: requestedAt, finishedAt: requestedAt,
          delivery: { status: "not-started" }, statusDetail: "canceled-before-start",
        }, "stop:canceled", requestedAt);
      }
      return lockedTransition(id, { cancelRequestedAt: requestedAt }, "cancel-requested", requestedAt);
    });
  } catch (error) {
    if (!readJob(id)) clearCancelMarker(id);
    throw error;
  }
  if (TERMINAL_STATES.has(result.state)) clearCancelMarker(id);
  return result;
}

function pidStartTimeMs(pid) {
  try {
    const script = `$p=Get-Process -Id ${Number(pid)} -ErrorAction Stop; ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds()`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    }).trim();
    const value = Number(out);
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}

export function inspectRunnerLock() {
  if (!existsSync(RUNNER_LOCK_PATH)) return { state: "absent", detail: "absent" };
  try {
    const [pidRaw, , token, startRaw] = readFileSync(RUNNER_LOCK_PATH, "utf8").split("\n");
    const pid = Number(pidRaw);
    const recordedStart = startRaw?.trim() ? Number(startRaw) : NaN;
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    if (!alive || !token) return { state: "stale", detail: `stale pid ${pid || "?"}` };
    if (Number.isFinite(recordedStart)) {
      const actualStart = pidStartTimeMs(pid);
      if (actualStart != null && Math.abs(actualStart - recordedStart) > 2000) {
        return { state: "stale", detail: `stale reused pid ${pid}` };
      }
    }
    return { state: "active", detail: `active pid ${pid}` };
  } catch { return { state: "stale", detail: "unreadable" }; }
}

export function acquireRunnerLock() {
  ensureDirs();
  if (existsSync(RUNNER_LOCK_PATH)) {
    try {
      const [pidRaw, , token, startRaw] = readFileSync(RUNNER_LOCK_PATH, "utf8").split("\n");
      const pid = Number(pidRaw);
      const recordedStart = startRaw?.trim() ? Number(startRaw) : NaN;
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      let sameInstance = alive;
      if (alive && Number.isFinite(recordedStart)) {
        const actualStart = pidStartTimeMs(pid);
        if (actualStart != null && Math.abs(actualStart - recordedStart) > 2000) sameInstance = false;
      }
      if (alive && sameInstance && token) return { held: true };
    } catch {}
    try { unlinkSync(RUNNER_LOCK_PATH); } catch {}
  }
  try {
    const token = randomBytes(8).toString("hex");
    const fd = openSync(RUNNER_LOCK_PATH, "wx");
    writeFileSync(fd, `${process.pid}\n${Date.now()}\n${token}\n${pidStartTimeMs(process.pid) ?? ""}\n`);
    closeSync(fd);
    return { held: false, path: RUNNER_LOCK_PATH, token };
  } catch { return { held: true }; }
}

export function releaseRunnerLock(lock) {
  if (!lock || lock.held || !lock.token) return;
  try {
    const parts = readFileSync(lock.path, "utf8").split("\n");
    if (parts[2] === lock.token) unlinkSync(lock.path);
  } catch {}
}

export function appendJobLog(id, message) {
  ensureDirs();
  const line = `[${new Date().toISOString()}] ${redactSensitive(message)}`;
  try { appendFileSync(jobLogPath(id), line + "\n"); return line; }
  catch { return null; }
}

export function readJobLog(id, maxChars = 12_000) {
  try { return readFileSync(jobLogPath(id), "utf8").slice(-maxChars); }
  catch { return ""; }
}

import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
export const RUNNER_LOCK_PATH = join(DATA_DIR, "runner.lock");

export const TERMINAL_STATES = new Set(["done", "failed", "overbudget", "timeout", "canceled"]);
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

function positiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function validateConfig(raw = {}) {
  return {
    budgetUsd: positiveNumber(raw.budgetUsd, DEFAULT_CONFIG.budgetUsd),
    timeoutMin: positiveNumber(raw.timeoutMin, DEFAULT_CONFIG.timeoutMin),
    maxTurns: positiveNumber(raw.maxTurns, DEFAULT_CONFIG.maxTurns),
    provider: raw.provider == null || typeof raw.provider === "string" ? raw.provider : null,
    model: raw.model == null || typeof raw.model === "string" ? raw.model : null,
    costSource: ["stats", "events"].includes(raw.costSource) ? raw.costSource : DEFAULT_CONFIG.costSource,
    piPath: typeof raw.piPath === "string" && raw.piPath ? raw.piPath : DEFAULT_CONFIG.piPath,
    worktreeRoot: typeof raw.worktreeRoot === "string" && raw.worktreeRoot ? raw.worktreeRoot : DEFAULT_CONFIG.worktreeRoot,
  };
}

export function loadConfig() {
  ensureDirs();
  const path = join(DATA_DIR, "config.json");
  if (!existsSync(path)) {
    const legacyPath = process.env.PI_JOBS_LEGACY_DIR
      ? join(process.env.PI_JOBS_LEGACY_DIR, "config.json")
      : join(homedir(), ".pi", "nightshift", "config.json");
    let config = { ...DEFAULT_CONFIG };
    try { if (existsSync(legacyPath)) config = validateConfig(JSON.parse(readFileSync(legacyPath, "utf8"))); } catch {}
    atomicWriteJson(path, config);
    return config;
  }
  try { return validateConfig(JSON.parse(readFileSync(path, "utf8"))); }
  catch { return { ...DEFAULT_CONFIG }; }
}

export function isValidJobId(id) { return typeof id === "string" && JOB_ID_PATTERN.test(id); }
function checkedId(id) { if (!isValidJobId(id)) throw new Error(`invalid job id: ${id}`); return id; }
export function jobPath(id) { return join(JOBS_DIR, `${checkedId(id)}.json`); }
export function heartbeatPath(id) { return join(HEARTBEATS_DIR, `${checkedId(id)}.json`); }
export function cancelPath(id) { return join(CONTROL_DIR, `${checkedId(id)}.cancel.json`); }
export function jobLogPath(id) { return join(LOGS_DIR, `${checkedId(id)}.log`); }

export function readJob(id) {
  try { return JSON.parse(readFileSync(jobPath(id), "utf8")); }
  catch { return null; }
}

export function listJobs({ all = true } = {}) {
  ensureDirs();
  const jobs = [];
  for (const file of readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const job = JSON.parse(readFileSync(join(JOBS_DIR, file), "utf8"));
      if (all || !TERMINAL_STATES.has(job.state)) jobs.push(job);
    } catch {}
  }
  return jobs.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

export function createJob(fields, { id = null, source = "pi-jobs" } = {}) {
  ensureDirs();
  const now = new Date().toISOString();
  const jobId = id || `job-${now.slice(0, 10).replace(/-/g, "")}-${randomBytes(6).toString("hex")}`;
  checkedId(jobId);
  const job = {
    schemaVersion: 3,
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
    maxTurns: fields.maxTurns,
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
    error: fields.error ?? null,
    delivery: fields.delivery ?? { type: "branch", status: "not-started", branch: null, commit: null },
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
  const nextPatch = typeof patch === "function" ? patch(current) : patch;
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
    const nextPatch = typeof patch === "function" ? patch(current) : patch;
    if (nextPatch == null) return current;
    const next = { ...current, ...nextPatch, updatedAt: new Date().toISOString() };
    atomicWriteJson(jobPath(id), next);
    return next;
  });
}

export function claimNextJob(workerToken) {
  for (const candidate of listJobs().filter((j) => j.state === "queued")) {
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
  const line = `[${new Date().toISOString()}] ${message}`;
  try { appendFileSync(jobLogPath(id), line + "\n"); return line; }
  catch { return null; }
}

export function readJobLog(id, maxChars = 12_000) {
  try { return readFileSync(jobLogPath(id), "utf8").slice(-maxChars); }
  catch { return ""; }
}

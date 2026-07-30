#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  DATA_DIR, HEARTBEAT_MS, TERMINAL_STATES, acquireRunnerLock, appendJobLog, completeJob,
  claimNextJob, clearCancelMarker, clearHeartbeat, ensureDirs, isHeartbeatStale,
  listJobs, loadConfig, readJob, reconcileEvents, reconcileQueueEvents, recordStopRequest,
  readCancelMarker, releaseRunnerLock, transitionJob, updateJobMetadata, writeHeartbeat,
} from "../lib/store.mjs";
import { branchExists, createJobWorktree, finalizeJobWorktree, jobBranch, jobWorktreePath } from "../lib/gitops.mjs";
import { migrateLegacyData } from "../lib/migrate.mjs";
import { resolveExecutionPolicy, runPiTask } from "../lib/rpc.mjs";
import { captureRuntime } from "../lib/runtime.mjs";
import { deliverPullRequest } from "../lib/pr-delivery.mjs";

const date = () => new Date().toISOString().slice(0, 10);

function runnerLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try { appendFileSync(join(DATA_DIR, "logs", `runner-${date()}.log`), line + "\n"); } catch {}
}

function jobLog(id, message) {
  runnerLog(`job ${id}: ${message}`);
  appendJobLog(id, message);
}

function terminalFromStop(stopCause) {
  if (stopCause === "max-turns") return { state: "timeout", statusDetail: "max-turns" };
  if (["canceled", "overbudget", "timeout"].includes(stopCause)) return { state: stopCause, statusDetail: null };
  return { state: "failed", statusDetail: "worker-crashed" };
}

function commitMessage(job) {
  const prompt = (job.prompt || "background task").replace(/\s+/g, " ").slice(0, 60);
  return `pi-jobs ${job.id}: ${prompt}`;
}

function completeFinalized(job, intended, extra, finalized) {
  const current = readJob(job.id) || job;
  const finishedAt = new Date().toISOString();
  if (!finalized.ok) {
    const terminal = completeJob(job.id, {
      ...extra, state: "failed", phase: null, finishedAt,
      statusDetail: "cleanup-needed", error: [extra.error, finalized.error].filter(Boolean).join("; "),
      filesChanged: finalized.filesChanged ?? current.filesChanged ?? [],
      delivery: { status: "failed", branch: finalized.branch ?? current.branch, commit: null },
    });
    clearHeartbeat(job.id); clearCancelMarker(job.id); return terminal;
  }
  const terminal = completeJob(job.id, {
    ...extra, ...intended, phase: null, finishedAt,
    filesChanged: finalized.filesChanged, branch: finalized.branch,
    delivery: {
      status: finalized.status, branch: finalized.branch, commit: finalized.commit,
      ...(finalized.fallbackReason ? { fallbackReason: finalized.fallbackReason } : {}),
    },
  });
  clearHeartbeat(job.id);
  clearCancelMarker(job.id);
  return terminal;
}

function deliverFinalizedPr(job, intended, extra, finalized, deliveryRunner = deliverPullRequest) {
  if (!finalized.ok) return completeFinalized(job, intended, extra, finalized);
  if (finalized.status === "no-changes") return completeFinalized(job, intended, extra, finalized);
  if (intended.state !== "done") {
    return completeFinalized(job, intended, extra, {
      ...finalized, status: "branch-ready",
    });
  }
  let current = transitionJob(job.id, {
    phase: "delivering", filesChanged: finalized.filesChanged, branch: finalized.branch,
    delivery: { status: "push-pending", branch: finalized.branch, commit: finalized.commit, fallbackReason: null, error: null },
  }, "phase:delivering");
  writeHeartbeat(job.id, current.workerToken || `delivery-${process.pid}`);
  try {
    const delivered = deliveryRunner(current, {
      shouldContinue: () => !readCancelMarker(job.id) && !readJob(job.id)?.stopCause,
      onPushed: (pushed) => {
        current = transitionJob(job.id, { delivery: { status: "pushed", ...pushed } }, "delivery:pushed");
        writeHeartbeat(job.id, current.workerToken || `delivery-${process.pid}`);
      },
    });
    const terminal = completeJob(job.id, {
      ...extra, ...intended, phase: null, finishedAt: new Date().toISOString(),
      filesChanged: finalized.filesChanged, branch: finalized.branch,
      delivery: { status: "pr-ready", branch: finalized.branch, commit: finalized.commit, ...delivered, error: null },
    }, "terminal:done");
    clearHeartbeat(job.id); clearCancelMarker(job.id); return terminal;
  } catch (error) {
    if (error?.code === "DELIVERY_CANCELED") {
      const terminal = completeJob(job.id, {
        state: "canceled", phase: null, finishedAt: new Date().toISOString(), statusDetail: null,
        filesChanged: finalized.filesChanged, branch: finalized.branch,
        delivery: { status: "branch-ready", branch: finalized.branch, commit: finalized.commit, fallbackReason: "task-not-successful", error: null },
      }, "terminal:canceled");
      clearHeartbeat(job.id); clearCancelMarker(job.id); return terminal;
    }
    const terminal = completeJob(job.id, {
      ...extra, state: "failed", phase: null, finishedAt: new Date().toISOString(),
      statusDetail: "delivery-failed", error: `${error}`,
      filesChanged: finalized.filesChanged, branch: finalized.branch,
      delivery: { status: "failed", branch: finalized.branch, commit: finalized.commit, error: `${error}` },
    }, "terminal:failed");
    clearHeartbeat(job.id); clearCancelMarker(job.id); return terminal;
  }
}

function finalizeAndRecord(job, intended, extra = {}, deliveryRunner = deliverPullRequest) {
  const current = readJob(job.id) || job;
  const finalized = finalizeJobWorktree(current, commitMessage(current));
  if (current.delivery?.type === "pr") {
    if (finalized.ok && finalized.status === "branch-ready" && intended.state !== "done") {
      finalized.fallbackReason = "task-not-successful";
      return completeFinalized(current, intended, extra, finalized);
    }
    return deliverFinalizedPr(current, intended, extra, finalized, deliveryRunner);
  }
  return completeFinalized(current, intended, extra, finalized);
}

function recoverPrDelivery(candidate, deliveryRunner = deliverPullRequest) {
  try {
    writeHeartbeat(candidate.id, `delivery-recovery-${process.pid}`);
    let current = candidate;
    const delivered = deliveryRunner(current, {
      shouldContinue: () => !readCancelMarker(candidate.id) && !readJob(candidate.id)?.stopCause,
      onPushed: (pushed) => { current = transitionJob(candidate.id, { delivery: { status: "pushed", ...pushed } }, "delivery:pushed-recovered"); },
    });
    const terminal = completeJob(candidate.id, {
      state: "done", phase: null, finishedAt: new Date().toISOString(), statusDetail: null,
      delivery: { status: "pr-ready", ...delivered, error: null },
    }, "terminal:done");
    clearHeartbeat(candidate.id); clearCancelMarker(candidate.id); return terminal;
  } catch (error) {
    if (error?.code === "DELIVERY_CANCELED") {
      const terminal = completeJob(candidate.id, {
        state: "canceled", phase: null, finishedAt: new Date().toISOString(), statusDetail: null,
        delivery: { status: "branch-ready", fallbackReason: "task-not-successful", error: null },
      }, "terminal:canceled");
      clearHeartbeat(candidate.id); clearCancelMarker(candidate.id); return terminal;
    }
    const terminal = completeJob(candidate.id, {
      state: "failed", phase: null, finishedAt: new Date().toISOString(), statusDetail: "delivery-failed", error: `${error}`,
      delivery: { status: "failed", error: `${error}` },
    }, "terminal:failed");
    clearHeartbeat(candidate.id); clearCancelMarker(candidate.id); return terminal;
  }
}

export function recoverStaleJobs(config, options = {}) {
  const recovered = [];
  for (const candidate of listJobs().filter((job) => job.state === "running")) {
    if (!isHeartbeatStale(candidate.id)) continue;
    try {
      if (candidate.phase === "delivering" && candidate.delivery?.type === "pr") {
        const terminal = recoverPrDelivery(candidate, options.deliveryRunner || deliverPullRequest);
        jobLog(candidate.id, `recovered PR delivery as ${terminal.state}`);
        recovered.push(terminal); continue;
      }
      const worktreePath = candidate.worktreePath || jobWorktreePath(candidate.id, config);
      const branch = candidate.branch || jobBranch(candidate.id);
      const current = transitionJob(candidate.id, {
        phase: "finalizing", worktreePath, branch,
      }, "recovery:stale-worker");
      writeHeartbeat(candidate.id, `recovery-${process.pid}`);
      const intended = terminalFromStop(current.stopCause);
      const terminal = finalizeAndRecord(current, intended, {
        statusDetail: intended.statusDetail,
        error: intended.state === "failed" ? "worker heartbeat became stale; model was not called again" : current.error,
      }, options.deliveryRunner || deliverPullRequest);
      jobLog(candidate.id, `recovered stale job as ${terminal.state}${terminal.statusDetail ? ` (${terminal.statusDetail})` : ""}`);
      recovered.push(terminal);
    } catch (error) {
      try {
        const terminal = completeJob(candidate.id, {
          state: "failed", phase: null, finishedAt: new Date().toISOString(),
          statusDetail: "cleanup-needed", error: `recovery failed: ${error}`,
          delivery: { status: "failed" },
        }, "terminal:failed");
        clearHeartbeat(candidate.id);
        clearCancelMarker(candidate.id);
        recovered.push(terminal);
      } catch {}
    }
  }
  return recovered;
}

export async function runOne(job, config, rpcRunner = runPiTask, deliveryRunner = deliverPullRequest) {
  const startedMs = Date.now();
  const workerToken = job.workerToken || `worker-${process.pid}-${randomBytes(5).toString("hex")}`;
  const heartbeatEvery = config.heartbeatMs ?? HEARTBEAT_MS;
  let heartbeatTimer;
  try {
    if (job.dirtyAtSubmit) jobLog(job.id, "warning: submit workspace was dirty; uncommitted changes are not included");
    const branch = jobBranch(job.id);
    const worktreePath = jobWorktreePath(job.id, config);
    let current = updateJobMetadata(job.id, { branch, worktreePath });
    writeHeartbeat(job.id, workerToken);
    heartbeatTimer = setInterval(() => { try { writeHeartbeat(job.id, workerToken); } catch {} }, heartbeatEvery);

    createJobWorktree(current, config);
    const policy = resolveExecutionPolicy(current, config);
    const runtime = captureRuntime(current, config, { policy });
    current = transitionJob(job.id, {
      phase: "agent", runtime, delivery: { status: "pending", branch, commit: null },
    }, "phase:agent");
    writeHeartbeat(job.id, workerToken);
    jobLog(job.id, `agent started in ${worktreePath}`);

    const result = await rpcRunner(current, config, (message) => jobLog(job.id, message), {
      onStopRequested: (cause, requestedAt) => recordStopRequest(job.id, cause, requestedAt),
      onUsage: (usage) => updateJobMetadata(job.id, {
        costUsd: usage.cost, tokens: usage.tokens ?? null, sessionFile: usage.sessionFile ?? null,
      }),
    });

    current = transitionJob(job.id, {
      phase: "finalizing", costUsd: result.cost ?? 0, tokens: result.tokens ?? null,
      sessionFile: result.sessionFile ?? null, summary: result.summary || null,
      error: result.error || null,
      stopCause: result.stopCause ?? readJob(job.id)?.stopCause ?? null,
      stopRequestedAt: result.stopRequestedAt ?? readJob(job.id)?.stopRequestedAt ?? null,
    }, "phase:finalizing");
    writeHeartbeat(job.id, workerToken);

    const intended = {
      state: ["done", "failed", "overbudget", "timeout", "canceled"].includes(result.status) ? result.status : "failed",
      statusDetail: result.statusDetail ?? null,
    };
    const terminal = finalizeAndRecord(current, intended, {
      costUsd: result.cost ?? 0, tokens: result.tokens ?? null,
      sessionFile: result.sessionFile ?? null, summary: result.summary || null,
      error: result.error || null, statusDetail: intended.statusDetail,
      durationSec: Math.round((Date.now() - startedMs) / 1000),
    }, deliveryRunner);
    jobLog(job.id, `${terminal.state}; delivery=${terminal.delivery.status}; cost=$${Number(terminal.costUsd || 0).toFixed(4)}${terminal.delivery?.prUrl ? `; pr=${terminal.delivery.prUrl}` : ""}`);
    return terminal;
  } catch (error) {
    jobLog(job.id, `worker exception: ${error}`);
    const current = readJob(job.id) || job;
    if (TERMINAL_STATES.has(current.state)) return current;
    try {
      if (current.phase === "preparing") {
        const hasArtifacts = Boolean(current.worktreePath && existsSync(current.worktreePath))
          || Boolean(current.branch && branchExists(current.repoRoot, current.branch));
        const terminal = completeJob(job.id, {
          state: "failed", phase: null, finishedAt: new Date().toISOString(),
          statusDetail: hasArtifacts ? "cleanup-needed" : "worker-error", error: `${error}`,
          durationSec: Math.round((Date.now() - startedMs) / 1000),
          delivery: { status: hasArtifacts ? "failed" : "not-started", branch: current.branch, commit: null },
        });
        clearHeartbeat(job.id);
        clearCancelMarker(job.id);
        return terminal;
      }
      if (current.phase !== "finalizing") transitionJob(job.id, { phase: "finalizing" }, "phase:finalizing-after-error");
      return finalizeAndRecord(readJob(job.id), { state: "failed", statusDetail: "worker-error" }, {
        error: `${error}`, durationSec: Math.round((Date.now() - startedMs) / 1000),
      }, deliveryRunner);
    } catch (finalError) {
      const terminal = completeJob(job.id, {
        state: "failed", phase: null, finishedAt: new Date().toISOString(),
        statusDetail: "cleanup-needed", error: `${error}; finalize: ${finalError}`,
        delivery: { status: "failed" },
      }, "terminal:failed");
      clearHeartbeat(job.id);
      clearCancelMarker(job.id);
      return terminal;
    }
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export async function drainQueue(config, options = {}) {
  const workerToken = options.workerToken || `worker-${process.pid}-${randomBytes(6).toString("hex")}`;
  const emptyScans = options.emptyScans ?? config.emptyScans ?? 5;
  const idlePollMs = options.idlePollMs ?? config.idlePollMs ?? 1_000;
  const rpcRunner = options.rpcRunner || runPiTask;
  const deliveryRunner = options.deliveryRunner || deliverPullRequest;
  let empty = 0;
  let processed = 0;
  while (empty < emptyScans) {
    const job = claimNextJob(workerToken);
    if (job && job.state === "running") {
      empty = 0;
      await runOne(job, config, rpcRunner, deliveryRunner);
      processed++;
      continue;
    }
    if (job && TERMINAL_STATES.has(job.state)) {
      empty = 0;
      continue;
    }
    empty++;
    if (empty < emptyScans) await new Promise((resolveDelay) => setTimeout(resolveDelay, idlePollMs));
  }
  return processed;
}

export async function main() {
  ensureDirs();
  const config = loadConfig();
  const lock = acquireRunnerLock();
  if (lock.held) { runnerLog("another worker owns the runner lock; exiting"); return; }
  try {
    const migration = migrateLegacyData();
    if (migration.imported) runnerLog(`imported ${migration.imported} legacy nightshift record(s)`);
    const repaired = reconcileEvents();
    if (repaired) runnerLog(`repaired ${repaired} missing audit event(s)`);
    const queueRepaired = reconcileQueueEvents();
    if (queueRepaired) runnerLog(`repaired ${queueRepaired} missing queue audit event(s)`);
    const recovered = recoverStaleJobs(config);
    if (recovered.length) runnerLog(`recovered ${recovered.length} stale job(s) without calling the model`);
    const processed = await drainQueue(config, {
      idlePollMs: Number(process.env.PI_JOBS_IDLE_POLL_MS) || undefined,
      emptyScans: Number(process.env.PI_JOBS_EMPTY_SCANS) || undefined,
    });
    runnerLog(`worker drained queue; processed=${processed}`);
  } finally {
    releaseRunnerLock(lock);
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) main().catch((error) => { console.error(error); process.exitCode = 1; });

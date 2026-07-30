import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { atomicWriteJson, createJob, DATA_DIR, isValidJobId, jobPath, loadConfig, readJob, withDataLock } from "./store.mjs";
import { inspectRepo } from "./gitops.mjs";

const legacyRoot = () => process.env.PI_JOBS_LEGACY_DIR || join(homedir(), ".pi", "nightshift");
const markerPath = () => join(DATA_DIR, "migration.json");

function json(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

function walkJson(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkJson(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(path);
  }
  return out;
}

function importedDelivery(result) {
  const branch = result.branch ?? null;
  const commit = result.commit ?? null;
  return {
    type: "branch",
    status: branch && commit ? "branch-ready" : branch ? "no-changes" : "failed",
    branch,
    commit,
  };
}

function normalizeTerminal(status) {
  return ["done", "failed", "overbudget", "timeout", "canceled"].includes(status) ? status : "failed";
}

function importResult(result) {
  if (!isValidJobId(result?.id) || existsSync(jobPath(result.id)) || readJob(result.id)) return false;
  const state = normalizeTerminal(result.status);
  createJob({
    ...result,
    state, phase: null,
    repoRoot: result.repoRoot ?? result.cwd ?? null,
    baseCommit: result.baseCommit ?? null,
    branch: result.branch ?? null,
    finishedAt: result.finishedAt ?? result.startedAt ?? new Date().toISOString(),
    delivery: importedDelivery(result),
    statusDetail: result.statusDetail ?? null,
  }, { id: result.id, source: "legacy-nightshift" });
  return true;
}

function importPending(task, running, defaults) {
  if (!isValidJobId(task?.id) || existsSync(jobPath(task.id)) || readJob(task.id)) return false;
  const cwd = task.cwd ?? task.repoRoot;
  let repo = null;
  try { repo = inspectRepo(cwd); } catch {}
  const hasContext = Boolean(task.origHead);
  const state = running || !repo ? "failed" : "queued";
  const detail = running ? (hasContext ? "legacy-interrupted" : "migration-recovery-required") : !repo ? "migration-recovery-required" : null;
  createJob({
    prompt: task.prompt ?? "(legacy task prompt unavailable)",
    repoRoot: repo?.repoRoot ?? cwd ?? null,
    baseRef: task.origBranch ?? repo?.baseRef ?? null,
    baseCommit: task.origHead ?? repo?.baseCommit ?? null,
    migrationBaseApproximate: !running && !task.origHead,
    budgetUsd: typeof task.budgetUsd === "number" && task.budgetUsd > 0 ? task.budgetUsd : defaults.budgetUsd,
    timeoutMin: typeof task.timeoutMin === "number" && task.timeoutMin > 0 ? task.timeoutMin : defaults.timeoutMin,
    maxTurns: typeof task.maxTurns === "number" && task.maxTurns > 0 ? task.maxTurns : defaults.maxTurns,
    provider: task.provider,
    model: task.model,
    createdAt: task.createdAt,
    state, phase: null,
    branch: running && hasContext ? `nightshift/${task.id}` : null,
    statusDetail: detail,
    finishedAt: state === "failed" ? new Date().toISOString() : null,
    delivery: {
      type: "branch",
      status: running && hasContext ? "branch-ready" : state === "failed" ? "failed" : "not-started",
      branch: running && hasContext ? `nightshift/${task.id}` : null,
      commit: null,
    },
  }, { id: task.id, source: "legacy-nightshift" });
  return true;
}

export function migrateLegacyData() {
  try { return withDataLock("data-migration", migrateLocked); }
  catch (error) {
    if (`${error}`.includes("lock busy")) return { imported: 0, importedIds: [], legacyFound: existsSync(legacyRoot()), busy: true };
    throw error;
  }
}

function migrateLocked() {
  const root = legacyRoot();
  const importedIds = new Set(json(markerPath())?.importedIds ?? []);
  if (!existsSync(root)) return { imported: 0, importedIds: [...importedIds], legacyFound: false };
  const defaults = loadConfig();
  let imported = 0;

  for (const path of walkJson(join(root, "results"))) {
    const result = json(path);
    if (result?.id && !importedIds.has(result.id) && importResult(result)) { importedIds.add(result.id); imported++; }
  }
  const queue = join(root, "queue");
  if (existsSync(queue)) {
    for (const name of readdirSync(queue)) {
      if (!name.endsWith(".json")) continue;
      const task = json(join(queue, name));
      if (!task || typeof task !== "object") continue;
      const id = task?.id ?? basename(name).replace(/(?:\.running)?\.json$/, "");
      if (!id || importedIds.has(id)) continue;
      if (importPending({ ...task, id }, name.endsWith(".running.json"), defaults)) { importedIds.add(id); imported++; }
    }
  }
  atomicWriteJson(markerPath(), { version: 1, importedIds: [...importedIds].sort(), lastRunAt: new Date().toISOString() });
  return { imported, importedIds: [...importedIds], legacyFound: true };
}

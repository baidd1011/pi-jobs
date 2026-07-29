import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  CONTROL_DIR, DATA_DIR, HEARTBEATS_DIR, TERMINAL_STATES, cancelPath, heartbeatPath, isValidJobId, listJobs, readJob,
} from "./store.mjs";

const DAY_MS = 24 * 60 * 60_000;
const ATOMIC_TMP_PATTERN = /\.(\d+)\.[a-f0-9]{10}\.tmp$/;
const NIGHT_SHIFT_NAMES = [".pi", "nightshift"];

function isWindows() { return process.platform === "win32"; }

function normalize(value) {
  if (!value) return null;
  try { return resolve(String(value)); } catch { return null; }
}

function caseFold(value) {
  return isWindows() ? String(value).toLowerCase() : String(value);
}

function samePath(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && caseFold(a) === caseFold(b));
}

function isInside(child, parent) {
  if (!child || !parent) return false;
  const a = caseFold(child);
  const b = caseFold(parent);
  if (a === b) return true;
  return a.startsWith(b.endsWith(sep) ? b : b + sep);
}

function isInNightshiftDir(value) {
  if (!value) return false;
  const lower = caseFold(value);
  return NIGHT_SHIFT_NAMES.some((name) => lower.includes(`${sep}${name}${sep}nightshift`))
    || lower.endsWith(`${sep}nightshift`);
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function isReparsePoint(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return true;
    if (!isWindows()) return false;
    const out = execFileSync("fsutil.exe", ["reparsepoint", "query", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 5_000 });
    return /Reparse Tag Value:\s*0x[0-9A-Fa-f]+/i.test(out);
  } catch { return false; }
}

function safeGit(cwd, ...args) {
  try { return { ok: true, stdout: execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 10_000 }).trim() }; }
  catch (error) { return { ok: false, error: error?.stderr?.toString?.().trim() || `${error}` }; }
}

function readJobForWorktree(worktreePath) {
  const direct = listJobs({ all: true }).find((job) => job.worktreePath && samePath(job.worktreePath, worktreePath));
  if (direct) return direct;
  const id = basename(worktreePath);
  if (isValidJobId(id)) {
    const job = readJob(id);
    if (job && job.worktreePath && samePath(job.worktreePath, worktreePath)) return job;
  }
  return null;
}

function basename(path) {
  const value = String(path);
  const trimmed = value.endsWith(sep) ? value.slice(0, -1) : value;
  const idx = trimmed.lastIndexOf(sep);
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function classifyHeartbeats() {
  const items = [];
  if (!existsSync(HEARTBEATS_DIR)) return items;
  for (const name of readdirSync(HEARTBEATS_DIR)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!isValidJobId(id)) {
      items.push({ kind: "heartbeat", target: id, action: "skip", reason: "not a valid job id" });
      continue;
    }
    const job = readJob(id);
    if (!job) {
      items.push({ kind: "heartbeat", target: id, action: "remove", reason: "job no longer exists" });
    } else if (TERMINAL_STATES.has(job.state)) {
      items.push({ kind: "heartbeat", target: id, action: "remove", reason: `job is terminal (${job.state})` });
    } else {
      items.push({ kind: "heartbeat", target: id, action: "skip", reason: `job is ${job.state}; heartbeat signals an active worker` });
    }
  }
  return items;
}

function classifyCancelMarkers() {
  const items = [];
  if (!existsSync(CONTROL_DIR)) return items;
  for (const name of readdirSync(CONTROL_DIR)) {
    if (!name.endsWith(".cancel.json")) continue;
    const id = name.slice(0, -".cancel.json".length);
    if (!isValidJobId(id)) {
      items.push({ kind: "cancel-marker", target: id, action: "skip", reason: "not a valid job id" });
      continue;
    }
    const job = readJob(id);
    if (!job) {
      items.push({ kind: "cancel-marker", target: id, action: "remove", reason: "job no longer exists" });
    } else if (TERMINAL_STATES.has(job.state)) {
      items.push({ kind: "cancel-marker", target: id, action: "remove", reason: `job is terminal (${job.state})` });
    } else {
      items.push({ kind: "cancel-marker", target: id, action: "skip", reason: `job is ${job.state}; cancel marker is the only signal the RPC can read` });
    }
  }
  return items;
}

function classifyTempFile(file) {
  let stat;
  try { stat = lstatSync(file); }
  catch { return { kind: "tmp-file", target: file, action: "skip", reason: "file no longer exists" }; }
  if (!stat.isFile() || stat.isSymbolicLink() || isReparsePoint(file)) {
    return { kind: "tmp-file", target: file, action: "skip", reason: "symlink, reparse point, or non-file" };
  }
  const match = file.match(ATOMIC_TMP_PATTERN);
  if (!match) return { kind: "tmp-file", target: file, action: "skip", reason: "not an atomic tmp file" };
  const pid = Number(match[1]);
  const ageMs = Date.now() - stat.mtimeMs;
  const fingerprint = { mtimeMs: stat.mtimeMs, size: stat.size };
  if (ageMs < DAY_MS) {
    return { kind: "tmp-file", target: file, action: "skip", reason: `less than 24h old (${Math.round(ageMs / 1000)}s)`, fingerprint };
  }
  if (isPidAlive(pid)) {
    return { kind: "tmp-file", target: file, action: "skip", reason: `pid ${pid} still alive`, fingerprint };
  }
  return {
    kind: "tmp-file", target: file, action: "remove",
    reason: `orphan atomic tmp, pid ${pid} not running, ${Math.round(ageMs / 3600_000)}h old`, fingerprint,
  };
}

function classifyTempFiles(rootDir = DATA_DIR) {
  const items = [];
  if (!existsSync(rootDir)) return items;
  const roots = [
    { path: rootDir, recursive: false },
    ...["jobs", "control", "heartbeats", "locks"].map((name) => ({ path: join(rootDir, name), recursive: true })),
  ];
  for (const candidate of roots) {
    for (const file of walkAtomicTmpFiles(candidate.path, candidate.recursive)) items.push(classifyTempFile(file));
  }
  return items;
}

function* walkAtomicTmpFiles(root, recursive = true) {
  if (!existsSync(root) || isReparsePoint(root)) return;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive && !isReparsePoint(path)) stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (ATOMIC_TMP_PATTERN.test(entry.name)) yield path;
    }
  }
}

function classifyWorktrees(config) {
  const items = [];
  const worktreeRoot = normalize(config?.worktreeRoot);
  if (!worktreeRoot) {
    items.push({ kind: "worktree", target: null, action: "skip", reason: "worktreeRoot not configured" });
    return items;
  }
  if (!existsSync(worktreeRoot)) return items;
  for (const entry of readdirSync(worktreeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(worktreeRoot, entry.name);
    items.push(...classifyOneWorktree(path, worktreeRoot));
  }
  return items;
}

function classifyOneWorktree(path, worktreeRoot) {
  if (isReparsePoint(path)) {
    return [{ kind: "worktree", target: path, action: "skip", reason: "symlink or reparse point" }];
  }
  if (!isInside(path, worktreeRoot)) {
    return [{ kind: "worktree", target: path, action: "manual-action", reason: "path escapes worktreeRoot" }];
  }
  const toplevel = safeGit(path, "rev-parse", "--show-toplevel");
  if (!toplevel.ok) {
    return [{ kind: "worktree", target: path, action: "manual-action", reason: `not a usable git worktree: ${toplevel.error}` }];
  }
  const resolved = resolve(toplevel.stdout);
  if (caseFold(resolved) !== caseFold(path)) {
    return [{ kind: "worktree", target: path, action: "manual-action", reason: `git toplevel (${resolved}) does not match path` }];
  }
  const job = readJobForWorktree(path);
  if (!job) {
    return [{ kind: "worktree", target: path, action: "manual-action", reason: "no associated job record" }];
  }
  if (!TERMINAL_STATES.has(job.state)) {
    return [{ kind: "worktree", target: path, action: "skip", reason: `job is ${job.state}; still in use` }];
  }
  if (job.statusDetail === "cleanup-needed") {
    return [{
      kind: "worktree", target: path, action: "manual-action",
      reason: "job reports cleanup-needed; inspect status and diff before any forced removal",
      command: `git -C "${job.repoRoot}" worktree remove --force "${path}"`,
    }];
  }
  const status = safeGit(path, "status", "--porcelain");
  if (!status.ok) {
    return [{ kind: "worktree", target: path, action: "manual-action", reason: `git status failed: ${status.error}` }];
  }
  if (status.stdout !== "") {
    return [{ kind: "worktree", target: path, action: "manual-action", reason: "worktree has uncommitted changes" }];
  }
  const expected = expectedCommitFor(job);
  if (!expected) {
    return [{ kind: "worktree", target: path, action: "manual-action", reason: "no expected commit to compare against" }];
  }
  const head = safeGit(path, "rev-parse", "HEAD");
  if (!head.ok) {
    return [{ kind: "worktree", target: path, action: "manual-action", reason: `git rev-parse HEAD failed: ${head.error}` }];
  }
  if (head.stdout !== expected) {
    return [{ kind: "worktree", target: path, action: "manual-action", reason: `HEAD (${head.stdout.slice(0, 12)}) does not match expected (${expected.slice(0, 12)})` }];
  }
  const registered = isRegisteredWorktree(path, worktreeRoot, job.repoRoot);
  if (!registered.ok) {
    return [{ kind: "worktree", target: path, action: "manual-action", reason: registered.reason }];
  }
  return [{ kind: "worktree", target: path, action: "remove", reason: `terminal ${job.state}; clean; HEAD matches ${expected.slice(0, 12)}` }];
}

function expectedCommitFor(job) {
  if (job.delivery?.status === "no-changes") return job.baseCommit || null;
  if (job.delivery?.commit && job.repoRoot) {
    const recorded = safeGit(job.repoRoot, "rev-parse", `${job.delivery.commit}^{commit}`);
    if (recorded.ok) return recorded.stdout;
  }
  if (job.delivery?.branch && job.repoRoot) {
    const head = safeGit(job.repoRoot, "rev-parse", job.delivery.branch);
    if (head.ok) return head.stdout;
  }
  return null;
}

function isRegisteredWorktree(path, worktreeRoot, repoRoot) {
  if (!repoRoot) return { ok: false, reason: "no repoRoot recorded for the job" };
  const out = safeGit(repoRoot, "worktree", "list", "--porcelain");
  if (!out.ok) return { ok: false, reason: `git worktree list failed: ${out.error}` };
  for (const block of out.stdout.split(/\r?\n\r?\n/)) {
    const registered = block.split(/\r?\n/).find((line) => line.startsWith("worktree "))?.slice(9);
    if (registered && samePath(registered, path)) return { ok: true };
  }
  return { ok: false, reason: "worktree is not registered with its repo" };
}

function revalidateItem(item, context = {}) {
  if (item.kind === "heartbeat") return classifyHeartbeats().find((candidate) => candidate.target === item.target);
  if (item.kind === "cancel-marker") return classifyCancelMarkers().find((candidate) => candidate.target === item.target);
  if (item.kind === "tmp-file") {
    const managedDirs = ["jobs", "control", "heartbeats", "locks"].map((name) => join(context.rootDir, name));
    const allowed = samePath(dirname(item.target), context.rootDir)
      || managedDirs.some((root) => isInside(item.target, root) && !samePath(item.target, root));
    if (!allowed) return null;
    const fresh = classifyTempFile(item.target);
    if (fresh.action !== "remove") return fresh;
    if (item.fingerprint && (fresh.fingerprint?.mtimeMs !== item.fingerprint.mtimeMs || fresh.fingerprint?.size !== item.fingerprint.size)) {
      return { ...fresh, action: "skip", reason: "file changed after cleanup classification" };
    }
    return fresh;
  }
  if (item.kind === "worktree") return classifyOneWorktree(item.target, context.worktreeRoot)[0];
  return null;
}

function removeItem(item, context) {
  const fresh = revalidateItem(item, context);
  if (!fresh || fresh.action !== "remove") {
    return {
      ok: false, reclassified: true,
      result: fresh?.action === "manual-action" ? "manual-action" : "skipped",
      error: fresh?.reason || "target no longer qualifies for removal",
    };
  }
  if (item.kind === "heartbeat") {
    const path = heartbeatPath(item.target);
    if (!existsSync(path)) return { ok: true, note: "already absent" };
    unlinkSync(path);
    return { ok: true };
  }
  if (item.kind === "cancel-marker") {
    const path = cancelPath(item.target);
    if (!existsSync(path)) return { ok: true, note: "already absent" };
    unlinkSync(path);
    return { ok: true };
  }
  if (item.kind === "tmp-file") {
    if (!existsSync(item.target)) return { ok: true, note: "already absent" };
    unlinkSync(item.target);
    return { ok: true };
  }
  if (item.kind === "worktree") {
    const repoRoot = readJobForWorktree(item.target)?.repoRoot;
    if (!repoRoot) return { ok: false, error: "no repoRoot for the worktree" };
    const removed = safeGit(repoRoot, "worktree", "remove", item.target);
    if (!removed.ok) return { ok: false, error: `git worktree remove failed: ${removed.error}` };
    safeGit(repoRoot, "worktree", "prune");
    return { ok: true };
  }
  return { ok: false, error: `unknown kind: ${item.kind}` };
}

export function classifyCleanup({ config, rootDir = DATA_DIR, worktreeRoot = config?.worktreeRoot } = {}) {
  const items = [
    ...classifyHeartbeats(),
    ...classifyCancelMarkers(),
    ...classifyTempFiles(rootDir),
    ...classifyWorktrees({ ...(config || {}), worktreeRoot }),
  ];
  const summary = { heartbeat: 0, "cancel-marker": 0, "tmp-file": 0, worktree: 0 };
  const counts = { remove: 0, skip: 0, "manual-action": 0 };
  for (const item of items) {
    summary[item.kind] = (summary[item.kind] || 0) + 1;
    counts[item.action] = (counts[item.action] || 0) + 1;
  }
  return { items, summary, counts, context: { rootDir, worktreeRoot } };
}

export function applyCleanup(plan, { dryRun = false } = {}) {
  const results = [];
  for (const item of plan.items) {
    if (item.action === "skip" || item.action === "manual-action") {
      results.push({ ...item, result: item.action === "skip" ? "skipped" : "manual-action" });
      continue;
    }
    if (dryRun) {
      results.push({ ...item, result: "would-remove" });
      continue;
    }
    try {
      const outcome = removeItem(item, plan.context || { rootDir: DATA_DIR, worktreeRoot: null });
      results.push({
        ...item,
        result: outcome.ok ? "removed" : outcome.reclassified ? outcome.result : "failed",
        error: outcome.error || null,
      });
    } catch (error) {
      results.push({ ...item, result: "failed", error: `${error}` });
    }
  }
  return results;
}

export function cleanup({ dryRun = false, config } = {}) {
  const plan = classifyCleanup({ config });
  const results = applyCleanup(plan, { dryRun });
  return { plan, results, dryRun };
}

export function formatCleanupResults(results, dryRun = false) {
  const lines = [];
  const buckets = { removed: [], "would-remove": [], skipped: [], "manual-action": [], failed: [] };
  for (const result of results) buckets[result.result]?.push(result);
  for (const [bucket, items] of Object.entries(buckets)) {
    if (!items.length) continue;
    lines.push(`**${bucket} (${items.length})**`);
    for (const item of items) {
      const target = typeof item.target === "string" ? item.target : (item.target ?? "(unknown)");
      const extras = [item.reason, item.command ? `try: \`${item.command}\`` : null, item.error ? `error: ${item.error}` : null].filter(Boolean).join(" — ");
      lines.push(`- [${item.kind}] \`${target}\` — ${extras}`);
    }
    lines.push("");
  }
  if (dryRun) lines.push("_Dry-run; data and repository were not modified._");
  return lines.join("\n").trim() || "no cleanup actions";
}

export { isInNightshiftDir, isInside, ATOMIC_TMP_PATTERN };

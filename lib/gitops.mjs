import { existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_WORKTREE_DIR } from "./store.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  }).trim();
}

function tryGit(cwd, ...args) {
  try { return { ok: true, stdout: git(cwd, ...args) }; }
  catch (error) { return { ok: false, error: error?.stderr?.toString?.().trim() || `${error}` }; }
}

export function inspectRepo(cwd) {
  if (!cwd || !existsSync(cwd)) throw new Error(`repository path does not exist: ${cwd}`);
  const root = git(cwd, "rev-parse", "--show-toplevel");
  const baseCommit = git(root, "rev-parse", "HEAD");
  const branch = tryGit(root, "symbolic-ref", "--quiet", "--short", "HEAD");
  return {
    repoRoot: resolve(root),
    baseRef: branch.ok && branch.stdout ? branch.stdout : null,
    baseCommit,
    dirtyAtSubmit: git(root, "status", "--porcelain") !== "",
  };
}

// NOTE: branch names must NOT contain a slash. `git worktree add -b <branch>`
// fails with "invalid reference: <branch>" for slash-containing names on Git
// for Windows (2.54.x). We use a hyphen to keep the pi-jobs namespace grouping
// without a slash.
export function jobBranch(id) { return `pi-jobs-${id}`; }

export function jobWorktreePath(id, config = {}) {
  return resolve(config.worktreeRoot || DEFAULT_WORKTREE_DIR, id);
}

export function branchExists(repoRoot, branch) {
  return tryGit(repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).ok;
}

export function createJobWorktree(job, config = {}) {
  const branch = job.branch || jobBranch(job.id);
  const worktreePath = job.worktreePath || jobWorktreePath(job.id, config);
  mkdirSync(dirname(worktreePath), { recursive: true });

  if (existsSync(worktreePath)) {
    throw new Error(`worktree path already exists; recovery must inspect it without rerunning the model: ${worktreePath}`);
  }

  if (branchExists(job.repoRoot, branch)) {
    throw new Error(`result branch already exists; refusing to attach a fresh model run: ${branch}`);
  }
  git(job.repoRoot, "worktree", "add", "-b", branch, worktreePath, job.baseCommit);
  const actual = git(worktreePath, "rev-parse", "HEAD");
  if (!branchExists(job.repoRoot, branch) || actual !== job.baseCommit) throw new Error("worktree creation did not preserve the frozen base commit");
  return { branch, worktreePath, reused: false };
}

function changedFiles(repoPath, baseCommit, target = "HEAD") {
  const out = tryGit(repoPath, "diff", "--name-status", `${baseCommit}..${target}`);
  return out.ok ? out.stdout.split(/\r?\n/).filter(Boolean) : [];
}

export function finalizeJobWorktree(job, message) {
  const branch = job.branch || jobBranch(job.id);
  const worktreePath = job.worktreePath;
  let head = null;
  let filesChanged = [];

  if (worktreePath && existsSync(worktreePath)) {
    const valid = tryGit(worktreePath, "rev-parse", "--show-toplevel");
    if (!valid.ok) {
      return { ok: false, cleanupNeeded: true, error: `worktree is not usable: ${valid.error}`, branch, worktreePath };
    }
    try {
      git(worktreePath, "add", "-A");
      if (git(worktreePath, "status", "--porcelain") !== "") git(worktreePath, "commit", "-m", message);
      head = git(worktreePath, "rev-parse", "HEAD");
      const branchHead = git(job.repoRoot, "rev-parse", branch);
      if (branchHead !== head) git(job.repoRoot, "update-ref", `refs/heads/${branch}`, head, branchHead);
      filesChanged = changedFiles(worktreePath, job.baseCommit);
    } catch (error) {
      return { ok: false, cleanupNeeded: true, error: `git finalize failed: ${error?.stderr?.toString?.().trim() || error}`, branch, worktreePath };
    }

    const removed = tryGit(job.repoRoot, "worktree", "remove", "--force", worktreePath);
    if (!removed.ok) {
      return { ok: false, cleanupNeeded: true, error: `worktree remove failed: ${removed.error}`, branch, worktreePath, filesChanged };
    }
    tryGit(job.repoRoot, "worktree", "prune");
  } else if (branchExists(job.repoRoot, branch)) {
    head = git(job.repoRoot, "rev-parse", branch);
    filesChanged = changedFiles(job.repoRoot, job.baseCommit, branch);
  } else {
    return { ok: true, status: "no-changes", branch: null, commit: null, filesChanged: [] };
  }

  if (head === job.baseCommit) {
    const deleted = tryGit(job.repoRoot, "branch", "-D", branch);
    if (!deleted.ok) {
      return { ok: false, cleanupNeeded: true, error: `empty branch cleanup failed: ${deleted.error}`, branch, worktreePath, filesChanged };
    }
    return { ok: true, status: "no-changes", branch: null, commit: null, filesChanged: [] };
  }

  const commit = tryGit(job.repoRoot, "rev-parse", "--short", branch);
  return { ok: true, status: "branch-ready", branch, commit: commit.ok ? commit.stdout : head?.slice(0, 7), filesChanged };
}

export function listRegisteredWorktrees(repoRoot) {
  const result = tryGit(repoRoot, "worktree", "list", "--porcelain");
  if (!result.ok) return [];
  return result.stdout.split(/\r?\n\r?\n/).map((block) => {
    const lines = block.split(/\r?\n/);
    return {
      path: lines.find((line) => line.startsWith("worktree "))?.slice(9) ?? null,
      branch: lines.find((line) => line.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null,
    };
  }).filter((entry) => entry.path);
}

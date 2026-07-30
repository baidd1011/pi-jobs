import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jobBranch } from "./gitops.mjs";
import { saveConfig } from "./store.mjs";
import { safeError } from "./redact.mjs";

function defaultExecute(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    timeout: options.timeout ?? 30_000,
  }).trim();
}

function run(execute, command, args, options = {}) {
  try { return { ok: true, stdout: execute(command, args, options).trim() }; }
  catch (error) {
    return { ok: false, error: safeError(error) };
  }
}

function must(result, label) {
  if (!result.ok) throw new Error(`${label}: ${result.error}`);
  return result.stdout;
}

function samePath(left, right) {
  const a = resolve(String(left));
  const b = resolve(String(right));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function parseGitHubRemote(remoteUrl) {
  const value = String(remoteUrl || "").trim();
  let host;
  let path;
  let transport;
  const scp = value.match(/^git@([^:]+):(.+)$/i);
  if (scp) {
    [, host, path] = scp; transport = "ssh";
  } else {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error("remote must be a GitHub HTTPS or SSH URL"); }
    if (!["https:", "ssh:"].includes(parsed.protocol)) throw new Error("remote must use HTTPS or SSH");
    if (parsed.password || (parsed.protocol === "https:" && parsed.username) || (parsed.protocol === "ssh:" && parsed.username && parsed.username !== "git")) {
      throw new Error("credential-bearing remote URLs are not allowed");
    }
    if (parsed.search || parsed.hash) throw new Error("remote URL query strings and fragments are not allowed");
    host = parsed.hostname; path = parsed.pathname.replace(/^\//, ""); transport = parsed.protocol === "https:" ? "https" : "ssh";
  }
  const repository = path.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  if (!host || !/^[^/]+\/[^/]+$/.test(repository)) throw new Error("remote must identify one GitHub owner/repository");
  return { host: host.toLowerCase(), repository, transport, sanitizedUrl: value };
}

function repoArg(target) {
  return target.host === "github.com" ? target.repository : `${target.host}/${target.repository}`;
}

function findGh(execute) {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const out = must(run(execute, command, ["gh"]), "gh executable not found");
  return out.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function ghIdentity(target, execute) {
  must(run(execute, target.ghPath, ["auth", "status", "--active", "--hostname", target.host]), "gh authentication failed");
  return must(run(execute, target.ghPath, ["api", "user", "--hostname", target.host, "--jq", ".login"]), "could not resolve gh account");
}

function repositoryInfo(target, execute) {
  const raw = must(run(execute, target.ghPath, ["api", `repos/${target.repository}`, "--hostname", target.host]), "GitHub repository permission check failed");
  let info;
  try { info = JSON.parse(raw); } catch { throw new Error("GitHub repository permission response was invalid"); }
  if (info?.permissions?.push !== true) throw new Error(`GitHub account does not have push permission for ${target.repository}`);
  return info;
}

function remoteHead(repoRoot, remoteName, branch, execute) {
  const out = must(run(execute, "git", ["-C", repoRoot, "ls-remote", "--heads", remoteName, `refs/heads/${branch}`], {
    env: { GIT_TERMINAL_PROMPT: "0" },
  }), `could not read ${remoteName}/${branch}`);
  return out.split(/\s+/)[0] || null;
}

function remoteUrl(repoRoot, remoteName, execute) {
  return must(run(execute, "git", ["-C", repoRoot, "remote", "get-url", remoteName]), `remote not found: ${remoteName}`);
}

function listPrs(target, branch, execute) {
  const raw = must(run(execute, target.ghPath, [
    "pr", "list", "--repo", repoArg(target), "--head", branch, "--state", "all",
    "--json", "number,url,state,isDraft,headRefName,baseRefName",
  ]), "could not query existing pull requests");
  try { return JSON.parse(raw); } catch { throw new Error("GitHub pull request response was invalid"); }
}

export function inspectPrSetup(repoRoot, { remoteName, baseBranch = null }, options = {}) {
  const execute = options.execute || defaultExecute;
  const url = remoteUrl(repoRoot, remoteName, execute);
  const parsed = parseGitHubRemote(url);
  const target = { repoRoot: resolve(repoRoot), remoteName, remoteUrl: parsed.sanitizedUrl, ...parsed, ghPath: options.ghPath || findGh(execute) };
  const account = ghIdentity(target, execute);
  const info = repositoryInfo(target, execute);
  target.baseBranch = baseBranch || info.default_branch;
  if (!target.baseBranch) throw new Error("GitHub repository has no default branch; specify --base");
  if (!remoteHead(repoRoot, remoteName, target.baseBranch, execute)) throw new Error(`remote base branch does not exist: ${target.baseBranch}`);
  return { ...target, account, configuredAt: new Date().toISOString() };
}

export function configurePrRepository(config, setup, options = {}) {
  const execute = options.execute || defaultExecute;
  if (setup.transport === "https") {
    must(run(execute, setup.ghPath, ["auth", "setup-git", "--hostname", setup.host]), "could not configure gh as Git credential helper");
  }
  if (!remoteHead(setup.repoRoot, setup.remoteName, setup.baseBranch, execute)) throw new Error("remote credential verification failed");
  const entry = {
    repoRoot: setup.repoRoot, remoteName: setup.remoteName, remoteUrl: setup.remoteUrl,
    host: setup.host, repository: setup.repository, baseBranch: setup.baseBranch,
    ghPath: setup.ghPath, configuredAt: setup.configuredAt,
  };
  const entries = (config.prRepositories || []).filter((candidate) => !samePath(candidate.repoRoot, entry.repoRoot));
  return saveConfig({ ...config, prRepositories: [...entries, entry] });
}

export function findPrConfiguration(config, repoRoot) {
  return (config.prRepositories || []).find((entry) => samePath(entry.repoRoot, repoRoot)) || null;
}

export function checkPrConfiguration(config, repoRoot, options = {}) {
  const execute = options.execute || defaultExecute;
  const stored = findPrConfiguration(config, repoRoot);
  if (!stored) return { ok: true, configured: false, detail: "not configured (branch delivery remains available)" };
  try {
    const url = remoteUrl(repoRoot, stored.remoteName, execute);
    const parsed = parseGitHubRemote(url);
    if (url !== stored.remoteUrl || parsed.host !== stored.host || parsed.repository !== stored.repository) throw new Error("remote changed; run /job setup-pr again");
    const account = ghIdentity(stored, execute);
    repositoryInfo(stored, execute);
    if (!remoteHead(repoRoot, stored.remoteName, stored.baseBranch, execute)) throw new Error(`base branch missing: ${stored.baseBranch}`);
    return { ok: true, configured: true, detail: `${account} -> ${stored.repository} via ${stored.remoteName}/${stored.baseBranch}` };
  } catch (error) { return { ok: false, configured: true, detail: safeError(error) }; }
}

export function preflightPrJob(repo, config, jobId, options = {}) {
  const execute = options.execute || defaultExecute;
  const stored = findPrConfiguration(config, repo.repoRoot);
  if (!stored) throw new Error("PR delivery is not configured for this repository; run /job setup-pr");
  const currentUrl = remoteUrl(repo.repoRoot, stored.remoteName, execute);
  const parsed = parseGitHubRemote(currentUrl);
  if (parsed.sanitizedUrl !== stored.remoteUrl || parsed.host !== stored.host || parsed.repository !== stored.repository) {
    throw new Error("configured PR remote has changed; run /job setup-pr again");
  }
  const account = ghIdentity(stored, execute);
  repositoryInfo(stored, execute);
  const baseHead = remoteHead(repo.repoRoot, stored.remoteName, stored.baseBranch, execute);
  if (baseHead !== repo.baseCommit) throw new Error(`local HEAD must equal ${stored.remoteName}/${stored.baseBranch} before PR submission`);
  const branch = jobBranch(jobId);
  if (remoteHead(repo.repoRoot, stored.remoteName, branch, execute)) throw new Error(`remote result branch already exists: ${branch}`);
  if (listPrs(stored, branch, execute).length) throw new Error(`a pull request already exists for ${branch}`);
  return {
    type: "pr", status: "not-started", branch: null, commit: null,
    target: {
      remoteName: stored.remoteName, remoteUrl: stored.remoteUrl, host: stored.host,
      repository: stored.repository, baseBranch: stored.baseBranch, ghPath: stored.ghPath,
    },
    authorization: { confirmedBy: account, confirmedAt: null },
  };
}

function prTitle(job) {
  const prompt = String(job.prompt || "background task").replace(/\s+/g, " ").trim();
  return `pi-jobs: ${prompt || job.id}`.slice(0, 80);
}

function prBody(job) {
  const policy = job.runtime?.policy || job.policy || {};
  const files = Array.isArray(job.filesChanged) && job.filesChanged.length ? job.filesChanged.map((file) => `- \`${file}\``).join("\n") : "- _(not recorded)_";
  return [
    `Background result for \`${job.id}\`.`, "",
    `- Base: \`${job.baseCommit}\``,
    `- Summary: ${job.summary || "_(no summary)_"}`,
    `- Cost: $${Number(job.costUsd || 0).toFixed(4)}`,
    `- Tools: ${(policy.tools || []).join(", ") || "unknown"}`,
    `- Local tools only: ${policy.noNetwork === true ? "yes" : policy.noNetwork === false ? "no" : "unknown"}`,
    `- Max turns: ${policy.maxTurns ?? "unknown"}`, "",
    "Changed files:", files, "",
    `Audit locally with \`/job audit ${job.id}\`.`,
  ].join("\n");
}

function verifyDeliveryTarget(job, execute) {
  const target = job.delivery?.target;
  const authorization = job.delivery?.authorization;
  if (!target || !authorization?.confirmedBy || !authorization?.confirmedAt) throw new Error("PR delivery authorization is missing");
  const url = remoteUrl(job.repoRoot, target.remoteName, execute);
  const parsed = parseGitHubRemote(url);
  if (url !== target.remoteUrl || parsed.host !== target.host || parsed.repository !== target.repository) throw new Error("PR remote changed after confirmation");
  const account = ghIdentity(target, execute);
  if (account !== authorization.confirmedBy) throw new Error(`gh account changed after confirmation (${authorization.confirmedBy} -> ${account})`);
  repositoryInfo(target, execute);
  if (!remoteHead(job.repoRoot, target.remoteName, target.baseBranch, execute)) throw new Error(`remote base branch disappeared: ${target.baseBranch}`);
  return target;
}

export function deliverPullRequest(job, options = {}) {
  const execute = options.execute || defaultExecute;
  const ensureContinue = () => {
    if (options.shouldContinue && !options.shouldContinue()) {
      const error = new Error("PR delivery canceled before external publication");
      error.code = "DELIVERY_CANCELED";
      throw error;
    }
  };
  const target = verifyDeliveryTarget(job, execute);
  const branch = job.delivery.branch || job.branch || jobBranch(job.id);
  const localSha = must(run(execute, "git", ["-C", job.repoRoot, "rev-parse", `refs/heads/${branch}`]), "local result branch is missing");
  let remoteSha = remoteHead(job.repoRoot, target.remoteName, branch, execute);
  if (remoteSha && remoteSha !== localSha) throw new Error(`remote branch ${branch} points to a different commit; refusing to force push`);
  if (!remoteSha) {
    ensureContinue();
    must(run(execute, "git", ["-C", job.repoRoot, "push", target.remoteName, `refs/heads/${branch}:refs/heads/${branch}`], {
      env: { GIT_TERMINAL_PROMPT: "0" }, timeout: 120_000,
    }), "result branch push failed");
    remoteSha = localSha;
  }
  options.onPushed?.({ remoteBranch: branch, remoteCommit: remoteSha, pushedAt: new Date().toISOString() });

  let pull = listPrs(target, branch, execute)[0] || null;
  if (!pull) {
    ensureContinue();
    const temp = mkdtempSync(join(tmpdir(), "pi-jobs-pr-"));
    const bodyPath = join(temp, "body.md");
    try {
      writeFileSync(bodyPath, prBody(job));
      const url = must(run(execute, target.ghPath, [
        "pr", "create", "--draft", "--repo", repoArg(target), "--base", target.baseBranch,
        "--head", branch, "--title", prTitle(job), "--body-file", bodyPath,
      ], { timeout: 120_000 }), "Draft PR creation failed").split(/\r?\n/).find((line) => /^https?:\/\//.test(line.trim()))?.trim();
      if (!url) throw new Error("Draft PR creation did not return a URL");
      const raw = must(run(execute, target.ghPath, ["pr", "view", url, "--repo", repoArg(target), "--json", "number,url,state,isDraft,headRefName,baseRefName"]), "could not verify Draft PR");
      pull = JSON.parse(raw);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  if (!pull?.url || pull.headRefName !== branch || pull.baseRefName !== target.baseBranch) throw new Error("Draft PR verification did not match the confirmed target");
  return {
    remoteBranch: branch, remoteCommit: remoteSha,
    prUrl: pull.url, prNumber: pull.number, prState: pull.state,
    prDraft: Boolean(pull.isDraft), deliveredAt: new Date().toISOString(),
  };
}

export { defaultExecute, prBody, prTitle, remoteHead };

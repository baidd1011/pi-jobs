import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DATA_DIR, HEARTBEATS_DIR, TERMINAL_STATES, atomicWriteJson,
  ensureDirs, inspectRunnerLock, isHeartbeatStale, isValidJobId, listJobs, loadConfig, readJob,
} from "./store.mjs";
import { checkPrConfiguration } from "./pr-delivery.mjs";

export const TASK_NAME = process.env.PI_JOBS_TASK_NAME || "pi-jobs-worker";
export const LEGACY_TASK_NAME = process.env.PI_JOBS_LEGACY_TASK_NAME || "pi-nightshift";
export const RUNNER_PATH = fileURLToPath(new URL("../runner/run.mjs", import.meta.url));

const psq = (value) => `'${String(value).replace(/'/g, "''")}'`;

function powershell(script) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 30_000,
  }).trim();
}

export function buildSetupScript({ nodePath = process.execPath, runnerPath = RUNNER_PATH } = {}) {
  const runnerArg = `"${runnerPath}"`;
  return [
    "$ErrorActionPreference='Stop'",
    `$action=New-ScheduledTaskAction -Execute ${psq(nodePath)} -Argument ${psq(runnerArg)}`,
    "$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(15) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)",
    "$settings=New-ScheduledTaskSettingsSet -MultipleInstances Queue -StartWhenAvailable",
    "$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited",
    `Register-ScheduledTask -TaskName ${psq(TASK_NAME)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Auditable Pi background job worker' -Force | Out-Null`,
    `if(Get-ScheduledTask -TaskName ${psq(LEGACY_TASK_NAME)} -ErrorAction SilentlyContinue){Disable-ScheduledTask -TaskName ${psq(LEGACY_TASK_NAME)} | Out-Null}`,
    `$task=Get-ScheduledTask -TaskName ${psq(TASK_NAME)}`,
    "if([string]$task.Settings.MultipleInstances -ne 'Queue'){throw 'MultipleInstancesPolicy verification failed'}",
    "$task | Select-Object TaskName,State,@{n='MultipleInstances';e={[string]$_.Settings.MultipleInstances}} | ConvertTo-Json -Compress",
  ].join("; ");
}

export function setupScheduledTask(options = {}) {
  if (process.platform !== "win32") throw new Error("pi-jobs setup is Windows-only");
  return JSON.parse(powershell(buildSetupScript(options)));
}

export function wakeWorker(source = "command") {
  ensureDirs();
  atomicWriteJson(join(DATA_DIR, "wake.json"), { requestedAt: new Date().toISOString(), source });
  if (process.platform !== "win32") return { started: false, error: "Windows Task Scheduler unavailable" };
  try {
    powershell(`Start-ScheduledTask -TaskName ${psq(TASK_NAME)} -ErrorAction Stop`);
    return { started: true };
  } catch (error) {
    return { started: false, error: error?.stderr?.toString?.().trim() || `${error}` };
  }
}

export function uninstallScheduledTask() {
  if (process.platform !== "win32") throw new Error("pi-jobs uninstall is Windows-only");
  powershell(buildUninstallScript());
  return { removed: true, dataPreserved: DATA_DIR };
}

export function buildUninstallScript() {
  return `if(Get-ScheduledTask -TaskName ${psq(TASK_NAME)} -ErrorAction SilentlyContinue){Unregister-ScheduledTask -TaskName ${psq(TASK_NAME)} -Confirm:$false}`;
}

function commandVersion(command, args = ["--version"]) {
  try {
    const stdout = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 10_000 }).trim();
    return { ok: true, detail: stdout.split(/\r?\n/)[0] };
  } catch (error) {
    if (process.platform === "win32") {
      try {
        const invocation = `& ${psq(command)} ${args.map(psq).join(" ")} | Select-Object -First 1`;
        return { ok: true, detail: powershell(invocation) };
      } catch {}
    }
    return { ok: false, detail: error?.code || `${error}` };
  }
}

function resolveCommand(command) {
  if (existsSync(command)) return resolve(command);
  if (process.platform !== "win32") return null;
  try {
    const matches = execFileSync("where.exe", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5_000 })
      .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return matches.find((path) => /\.(?:cmd|exe)$/i.test(path)) || matches[0] || null;
  } catch { return null; }
}

function piVersion(piPath) {
  const resolved = resolveCommand(piPath);
  if (!resolved) return { ok: false, detail: `not found: ${piPath}` };
  const packagePath = join(dirname(resolved), "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  try {
    const version = JSON.parse(readFileSync(packagePath, "utf8")).version;
    if (version) return { ok: true, detail: `${version} (${resolved})` };
  } catch {}
  return { ...commandVersion(resolved), path: resolved };
}

function readPiSettings() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  try { return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")); }
  catch { return {}; }
}

export function scheduledTaskInfo() {
  if (process.platform !== "win32") return { ok: false, detail: "not-windows" };
  const script = [
    `$task=Get-ScheduledTask -TaskName ${psq(TASK_NAME)} -ErrorAction Stop`,
    `$info=Get-ScheduledTaskInfo -TaskName ${psq(TASK_NAME)} -ErrorAction SilentlyContinue`,
    "[pscustomobject]@{Enabled=($task.State -ne 'Disabled');State=[string]$task.State;MultipleInstances=[string]$task.Settings.MultipleInstances;Execute=$task.Actions[0].Execute;Arguments=$task.Actions[0].Arguments;Interval=[string]$task.Triggers[0].Repetition.Interval;LastResult=$info.LastTaskResult} | ConvertTo-Json -Compress",
  ].join("; ");
  try { return { ok: true, detail: JSON.parse(powershell(script)) }; }
  catch (error) { return { ok: false, detail: error?.stderr?.toString?.().trim() || "task not registered" }; }
}

function normalizePath(value) {
  if (!value) return null;
  return resolve(String(value).trim().replace(/^"|"$/g, "")).toLowerCase();
}

export function assessScheduledRunner(task, expectedRunnerPath = RUNNER_PATH) {
  if (!task?.ok) {
    return { ok: false, actual: null, expected: expectedRunnerPath, detail: "task unavailable; run /job setup" };
  }
  const actual = String(task.detail?.Arguments || "").trim().replace(/^"|"$/g, "");
  const ok = normalizePath(actual) === normalizePath(expectedRunnerPath);
  return {
    ok,
    actual: actual || null,
    expected: expectedRunnerPath,
    detail: ok ? expectedRunnerPath : `registered: ${actual || "(missing)"}; expected: ${expectedRunnerPath}; run /job setup`,
  };
}

export function scheduledRunnerStatus() {
  return assessScheduledRunner(scheduledTaskInfo(), RUNNER_PATH);
}

function providerKeyName(provider) {
  if (!provider) return null;
  const known = { deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GEMINI_API_KEY" };
  return known[provider.toLowerCase()] || `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

function userEnvExists(name) {
  if (!name || process.platform !== "win32") return false;
  try { return powershell(`[bool][Environment]::GetEnvironmentVariable(${psq(name)},'User')`) === "True"; }
  catch { return false; }
}

export function doctor({ cwd = null } = {}) {
  ensureDirs();
  const config = loadConfig();
  const piSettings = readPiSettings();
  const provider = config.provider || piSettings.defaultProvider || null;
  const model = config.model || piSettings.defaultModel || null;
  const checks = [];
  checks.push({ name: "Windows", ok: process.platform === "win32", detail: process.platform });
  checks.push({ name: "Node runner", ...commandVersion(process.execPath), path: process.execPath });
  checks.push({ name: "Runner file", ok: existsSync(RUNNER_PATH), detail: RUNNER_PATH });
  checks.push({ name: "Git", ...commandVersion("git") });
  let worktree;
  try {
    const commands = execFileSync("git", ["help", "-a"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 10_000 });
    worktree = { ok: /\bworktree\b/.test(commands), detail: /\bworktree\b/.test(commands) ? "available" : "not listed by git help -a" };
  } catch (error) { worktree = { ok: false, detail: `${error}` }; }
  checks.push({ name: "Git worktree", ...worktree });
  checks.push({ name: "Pi executable", ...piVersion(config.piPath), path: config.piPath });
  checks.push({ name: "Provider/model", ok: Boolean(provider && model), detail: `${provider || "default"}/${model || "default"}` });
  const keyName = providerKeyName(provider);
  const hasKey = keyName ? userEnvExists(keyName) : false;
  checks.push({ name: "User API key", ok: hasKey, detail: keyName ? `${keyName}: ${hasKey ? "present" : "missing"}` : "provider not configured" });
  const task = scheduledTaskInfo();
  const taskOk = task.ok && task.detail.MultipleInstances === "Queue" && task.detail.Enabled
    && String(task.detail.Execute).toLowerCase() === process.execPath.toLowerCase()
    && String(task.detail.Interval).toUpperCase() === "PT15M";
  checks.push({ name: "Scheduled task", ok: taskOk, detail: task.detail });
  const scheduledRunner = assessScheduledRunner(task, RUNNER_PATH);
  checks.push({ name: "Scheduled runner path", ok: scheduledRunner.ok, detail: scheduledRunner.detail });

  const probe = join(DATA_DIR, `.doctor-${process.pid}.tmp`);
  try { writeFileSync(probe, "ok"); unlinkSync(probe); checks.push({ name: "Data directory", ok: true, detail: DATA_DIR }); }
  catch (error) { checks.push({ name: "Data directory", ok: false, detail: `${error}` }); }

  const runnerLock = inspectRunnerLock();
  checks.push({ name: "Runner lock", ok: runnerLock.state !== "stale", detail: runnerLock.detail });

  const staleJobs = listJobs().filter((job) => job.state === "running" && isHeartbeatStale(job.id)).map((job) => job.id);
  checks.push({ name: "Stale jobs", ok: staleJobs.length === 0, detail: staleJobs.length ? staleJobs.join(", ") : "none" });
  const activePaths = new Set(listJobs().filter((job) => job.state === "running" && job.worktreePath).map((job) => resolve(job.worktreePath).toLowerCase()));
  let worktreeDirs = [];
  try { worktreeDirs = readdirSync(config.worktreeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(config.worktreeRoot, entry.name)); } catch {}
  const leftovers = worktreeDirs.filter((path) => !activePaths.has(resolve(path).toLowerCase()));
  checks.push({ name: "Legacy worktrees", ok: leftovers.length === 0, detail: leftovers.length ? leftovers.join(", ") : "none" });
  const terminalHeartbeats = [];
  try {
    for (const file of readdirSync(HEARTBEATS_DIR).filter((name) => name.endsWith(".json"))) {
      const id = file.slice(0, -5);
      if (!isValidJobId(id)) continue;
      const job = readJob(id);
      if (!job || TERMINAL_STATES.has(job.state)) terminalHeartbeats.push(id);
    }
  } catch {}
  checks.push({
    name: "Terminal heartbeats",
    ok: terminalHeartbeats.length === 0,
    detail: terminalHeartbeats.length
      ? `${terminalHeartbeats.join(", ")} — run /job cleanup to remove`
      : "none",
  });
  const synced = /(?:onedrive|dropbox|google[ _-]?drive)/i.test(config.worktreeRoot);
  checks.push({ name: "Worktree root", ok: !synced, detail: synced ? `${config.worktreeRoot} is inside a sync directory` : config.worktreeRoot });
  if (cwd) {
    let repoRoot = null;
    try { repoRoot = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim(); } catch {}
    if (repoRoot) {
      const pr = checkPrConfiguration(config, repoRoot);
      checks.push({ name: "PR delivery", ok: pr.ok, detail: pr.detail });
    } else checks.push({ name: "PR delivery", ok: true, detail: "current directory is not a Git repository" });
  }
  return { ok: checks.every((check) => check.ok), checks, config: { provider, model, piPath: config.piPath, worktreeRoot: config.worktreeRoot } };
}

export function formatDoctor(report) {
  return report.checks.map((check) => `${check.ok ? "OK" : "WARN"} ${check.name}: ${typeof check.detail === "string" ? check.detail : JSON.stringify(check.detail)}`).join("\n");
}

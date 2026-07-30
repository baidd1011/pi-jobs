import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { safeError } from "./redact.mjs";

function resolveCommand(command) {
  if (existsSync(command)) return resolve(command);
  if (process.platform !== "win32") return null;
  try {
    const matches = execFileSync("where.exe", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5_000 })
      .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return matches.find((path) => /\.(?:cmd|exe)$/i.test(path)) || matches[0] || null;
  } catch { return null; }
}

function commandVersion(command, args = ["--version"]) {
  try {
    const stdout = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 10_000 }).trim();
    return { ok: true, detail: stdout.split(/\r?\n/)[0] };
  } catch (error) {
    if (process.platform === "win32") {
      const quoted = `'${command.replace(/'/g, "''")}'`;
      const script = `& ${quoted} ${args.map((arg) => `'${String(arg).replace(/'/g, "''")}'`).join(" ")} | Select-Object -First 1`;
      try {
        const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 10_000 }).trim();
        return { ok: true, detail: out };
      } catch {}
    }
    return { ok: false, detail: error?.code || safeError(error) };
  }
}

export function detectPiVersion(piPath) {
  const resolved = resolveCommand(piPath);
  if (!resolved) return { ok: false, detail: `not found: ${piPath}` };
  const packagePath = join(dirname(resolved), "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  try {
    const version = JSON.parse(readFileSync(packagePath, "utf8")).version;
    if (version) return { ok: true, detail: `${version} (${resolved})`, version, resolved };
  } catch {}
  const fallback = commandVersion(resolved);
  return { ...fallback, resolved };
}

function readPiDefaults(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")) {
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    return { provider: settings.defaultProvider ?? null, model: settings.defaultModel ?? null };
  } catch {
    return { provider: null, model: null };
  }
}

export function captureRuntime(task, config, { piPath, piVersion, piDefaults, policy } = {}) {
  const defaults = piDefaults ?? readPiDefaults();
  const provider = task.provider ?? config?.provider ?? defaults.provider ?? null;
  const model = task.model ?? config?.model ?? defaults.model ?? null;
  const resolvedPath = piPath ?? config?.piPath ?? null;
  let resolvedVersion = piVersion || null;
  if (!resolvedVersion && resolvedPath) {
    try {
      const found = detectPiVersion(resolvedPath);
      if (found?.version) resolvedVersion = found.version;
      else if (found?.ok && found.detail) resolvedVersion = found.detail;
    } catch {}
  }
  return {
    provider: provider || null,
    model: model || null,
    piVersion: resolvedVersion,
    piPath: resolvedPath,
    policy: policy ?? null,
    capturedAt: new Date().toISOString(),
  };
}

export { readPiDefaults };

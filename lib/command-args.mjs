export const BUILTIN_TOOLS = Object.freeze(["read", "bash", "edit", "write", "grep", "find", "ls"]);
export const DEFAULT_TOOLS = Object.freeze(["read", "bash", "edit", "write"]);

function tokens(text) {
  const input = String(text || "");
  const result = [];
  let value = "";
  let quote = null;
  let escaped = false;
  let active = false;
  for (const char of input) {
    if (escaped) { value += char; escaped = false; active = true; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; active = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else value += char;
      active = true;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; active = true; continue; }
    if (/\s/.test(char)) {
      if (active) { result.push(value); value = ""; active = false; }
      continue;
    }
    value += char; active = true;
  }
  if (escaped) value += "\\";
  if (quote) throw new Error("unterminated quote");
  if (active) result.push(value);
  return result;
}

function positive(raw, usage) {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw || "") || !(Number(raw) > 0)) throw new Error(usage);
  return Number(raw);
}

function integer(raw, usage, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(raw || "")) throw new Error(usage);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(usage);
  return value;
}

export const ADD_USAGE = "usage: /job add <prompt> [--budget N] [--timeout MIN] [--max-turns N] [--tools read,edit,bash] [--no-network] [--delivery branch|pr]";

export function parseAddArgs(text, defaults = {}) {
  const args = tokens(text);
  const seen = new Set();
  const prompt = [];
  const result = {
    budgetUsd: defaults.budgetUsd,
    timeoutMin: defaults.timeoutMin,
    maxTurns: defaults.maxTurns,
    tools: [...(defaults.tools || DEFAULT_TOOLS)],
    noNetwork: false,
    delivery: "branch",
  };
  let options = true;
  let toolsExplicit = false;
  const take = (index, name) => {
    if (seen.has(name)) throw new Error(ADD_USAGE);
    seen.add(name);
    if (index + 1 >= args.length) throw new Error(ADD_USAGE);
    return args[index + 1];
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (options && arg === "--") { options = false; continue; }
    if (!options || !arg.startsWith("--")) { prompt.push(arg); continue; }
    if (arg === "--no-network") {
      if (seen.has(arg)) throw new Error(ADD_USAGE);
      seen.add(arg); result.noNetwork = true; continue;
    }
    const raw = take(index, arg); index++;
    if (arg === "--budget") result.budgetUsd = positive(raw, ADD_USAGE);
    else if (arg === "--timeout") result.timeoutMin = positive(raw, ADD_USAGE);
    else if (arg === "--max-turns") result.maxTurns = integer(raw, ADD_USAGE, 1, 1000);
    else if (arg === "--delivery") {
      if (!["branch", "pr"].includes(raw)) throw new Error(ADD_USAGE);
      result.delivery = raw;
    } else if (arg === "--tools") {
      const requested = raw.split(",").map((tool) => tool.trim()).filter(Boolean);
      if (!requested.length || requested.some((tool) => !BUILTIN_TOOLS.includes(tool))) throw new Error(ADD_USAGE);
      result.tools = [...new Set(requested)]; toolsExplicit = true;
    } else throw new Error(ADD_USAGE);
  }
  if (!prompt.length) throw new Error(ADD_USAGE);
  if (result.noNetwork && !toolsExplicit) result.tools = result.tools.filter((tool) => tool !== "bash");
  if (!result.tools.length || (result.noNetwork && result.tools.includes("bash"))) throw new Error(ADD_USAGE);
  return { ...result, prompt: prompt.join(" ") };
}

export function parseSetupPrArgs(text) {
  const args = tokens(text);
  let remote = null;
  let base = null;
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!["--remote", "--base"].includes(arg) || seen.has(arg) || index + 1 >= args.length) {
      throw new Error("usage: /job setup-pr --remote <name> [--base <branch>]");
    }
    seen.add(arg);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error("usage: /job setup-pr --remote <name> [--base <branch>]");
    if (arg === "--remote") remote = value; else base = value;
  }
  if (!remote) throw new Error("usage: /job setup-pr --remote <name> [--base <branch>]");
  return { remote, base };
}

export function parseNoArgs(text, usage) {
  if (tokens(text).length) throw new Error(usage);
}

export function parseJobIdArg(text, usage) {
  const args = tokens(text);
  if (args.length !== 1) throw new Error(usage);
  return args[0];
}

export function parseDigestArgs(text) {
  const args = tokens(text);
  const result = { hours: 24, markdown: false, notify: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (seen.has(arg)) throw new Error("usage: /job digest [--hours N] [--markdown] [--notify]");
    seen.add(arg);
    if (arg === "--markdown") { result.markdown = true; continue; }
    if (arg === "--notify") { result.notify = true; continue; }
    if (arg === "--hours") {
      result.hours = positive(args[++index], "usage: /job digest [--hours N] [--markdown] [--notify]");
      continue;
    }
    throw new Error("usage: /job digest [--hours N] [--markdown] [--notify]");
  }
  return result;
}

export function parseCleanupArgs(text) {
  const args = tokens(text);
  if (args.length === 0) return { dryRun: false };
  if (args.length === 1 && args[0] === "--dry-run") return { dryRun: true };
  throw new Error("usage: /job cleanup [--dry-run]");
}

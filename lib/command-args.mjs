function tokens(text) {
  const trimmed = String(text || "").trim();
  return trimmed ? trimmed.split(/\s+/) : [];
}

export function parseDigestArgs(text) {
  const args = tokens(text);
  const result = { hours: 24, markdown: false, notify: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--markdown") {
      result.markdown = true;
      continue;
    }
    if (arg === "--notify") {
      result.notify = true;
      continue;
    }
    if (arg === "--hours") {
      const raw = args[++index];
      if (!raw || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw) || !(Number(raw) > 0)) {
        throw new Error("usage: /job digest [--hours N] [--markdown] [--notify]");
      }
      result.hours = Number(raw);
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

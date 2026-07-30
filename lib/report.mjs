import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  AUDITS_DIR, DIGESTS_DIR, EVENTS_PATH, JOBS_DIR, LOGS_DIR, TERMINAL_STATES,
  atomicWrite, listJobs, readJob, readQueueState, reconcileEvents,
} from "./store.mjs";

const UNKNOWN = "unknown / not recorded";
const CLEANUP_NEEDED = "cleanup-needed";

function safeIso(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? value : null;
}

function parseEventsFor(jobId, maxRevision = null) {
  const events = [];
  if (!existsSync(EVENTS_PATH)) return events;
  const lines = readFileSync(EVENTS_PATH, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event?.jobId !== jobId) continue;
      if (maxRevision != null && (event.revision ?? 0) > maxRevision) continue;
      events.push(event);
    } catch {}
  }
  const byKey = new Map();
  for (const event of events) {
    const key = `${event.revision}`;
    if (!byKey.has(key)) byKey.set(key, event);
  }
  return [...byKey.values()].sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0));
}

export function formatCost(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return UNKNOWN;
  return `$${value.toFixed(4)}`;
}

export function formatDuration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return UNKNOWN;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes || hours) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join("");
}

export function formatTimestamp(value) {
  const iso = safeIso(value);
  if (!iso) return UNKNOWN;
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

export function formatTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return UNKNOWN;
  const parts = [];
  if (typeof tokens.input === "number") parts.push(`in ${tokens.input}`);
  if (typeof tokens.output === "number") parts.push(`out ${tokens.output}`);
  if (typeof tokens.cacheRead === "number") parts.push(`cache-read ${tokens.cacheRead}`);
  if (typeof tokens.cacheWrite === "number") parts.push(`cache-write ${tokens.cacheWrite}`);
  if (typeof tokens.total === "number") parts.push(`total ${tokens.total}`);
  return parts.length ? parts.join(", ") : UNKNOWN;
}

function shellQuote(value) {
  if (value == null) return null;
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

export function reviewCommand(job) {
  if (!job?.repoRoot || !job?.baseCommit) return null;
  const base = job.baseCommit;
  const target = job.delivery?.branch || job.branch;
  if (!target) return null;
  if (job.delivery?.status === "no-changes") return null;
  return `git -C ${shellQuote(job.repoRoot)} diff ${base}..${target}`;
}

function tryGit(cwd, ...args) {
  try { return { ok: true, stdout: execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim() }; }
  catch (error) { return { ok: false, error: error?.stderr?.toString?.().trim() || `${error}` }; }
}

export function gitSummary(job) {
  if (!job?.repoRoot) return { available: false, reason: "no repository recorded" };
  if (!existsSync(job.repoRoot)) return { available: false, reason: `repository path unavailable: ${job.repoRoot}` };
  const target = job.delivery?.branch || job.branch;
  if (!target) return { available: false, reason: "no result branch" };
  const exists = tryGit(job.repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${target}`);
  if (!exists.ok) return { available: false, reason: `branch unavailable: ${target}` };
  if (!job.baseCommit) return { available: false, reason: "no base commit" };
  const stat = tryGit(job.repoRoot, "diff", "--stat", `${job.baseCommit}..${target}`);
  const nameStatus = tryGit(job.repoRoot, "diff", "--name-status", `${job.baseCommit}..${target}`);
  const shortHead = tryGit(job.repoRoot, "rev-parse", "--short", target);
  return {
    available: true,
    commit: shortHead.ok ? shortHead.stdout : UNKNOWN,
    stat: stat.ok ? stat.stdout : UNKNOWN,
    files: nameStatus.ok ? nameStatus.stdout.split(/\r?\n/).filter(Boolean) : [],
    statError: stat.ok ? null : stat.error,
    nameStatusError: nameStatus.ok ? null : nameStatus.error,
  };
}

function resolveRuntime(job) {
  const runtime = job?.runtime;
  if (!runtime || typeof runtime !== "object") {
    return {
      provider: UNKNOWN, model: UNKNOWN, piVersion: UNKNOWN, piPath: UNKNOWN, capturedAt: UNKNOWN,
      policy: { tools: UNKNOWN, noNetwork: UNKNOWN, maxTurns: UNKNOWN },
    };
  }
  const pick = (value) => (value == null || value === "" ? UNKNOWN : value);
  return {
    provider: pick(runtime.provider),
    model: pick(runtime.model),
    piVersion: pick(runtime.piVersion),
    piPath: pick(runtime.piPath),
    capturedAt: pick(runtime.capturedAt),
    policy: runtime.policy && typeof runtime.policy === "object" ? {
      tools: Array.isArray(runtime.policy.tools) ? runtime.policy.tools : UNKNOWN,
      noNetwork: typeof runtime.policy.noNetwork === "boolean" ? runtime.policy.noNetwork : UNKNOWN,
      maxTurns: Number.isSafeInteger(runtime.policy.maxTurns) ? runtime.policy.maxTurns : UNKNOWN,
    } : { tools: UNKNOWN, noNetwork: UNKNOWN, maxTurns: UNKNOWN },
  };
}

function resolveStatusDetail(job) {
  return job.statusDetail || null;
}

function isCleanupNeeded(job) {
  return TERMINAL_STATES.has(job.state) && resolveStatusDetail(job) === CLEANUP_NEEDED;
}

function timelineLine(event) {
  const at = formatTimestamp(event.at);
  const from = event.from?.state ? `${event.from.state}${event.from.phase ? `/${event.from.phase}` : ""}` : "?";
  const to = event.to?.state ? `${event.to.state}${event.to.phase ? `/${event.to.phase}` : ""}` : "?";
  const reason = event.reason || "transition";
  return `- r${event.revision} \`${at}\` **${from} → ${to}** (${reason})`;
}

export function buildAudit(jobId) {
  const job = readJob(jobId);
  if (!job) return { available: false, reason: `no such job: ${jobId}` };
  reconcileEvents();
  const events = parseEventsFor(jobId, job.revision ?? null);
  const runtime = resolveRuntime(job);
  const git = gitSummary(job);
  const statusDetail = resolveStatusDetail(job);
  const review = reviewCommand(job);
  const sessionFile = job.sessionFile || null;
  const logPath = join(LOGS_DIR, `${job.id}.log`);
  const jobPath = join(JOBS_DIR, `${job.id}.json`);
  return {
    available: true,
    job: {
      id: job.id,
      source: job.source || "pi-jobs",
      schemaVersion: job.schemaVersion ?? 1,
      state: job.state,
      phase: job.phase ?? null,
      statusDetail,
      prompt: job.prompt ?? null,
      repoRoot: job.repoRoot ?? null,
      baseRef: job.baseRef ?? null,
      baseCommit: job.baseCommit ?? null,
      dirtyAtSubmit: Boolean(job.dirtyAtSubmit),
      migrationBaseApproximate: Boolean(job.migrationBaseApproximate),
      createdAt: formatTimestamp(job.createdAt),
      startedAt: formatTimestamp(job.startedAt),
      finishedAt: formatTimestamp(job.finishedAt),
      updatedAt: formatTimestamp(job.updatedAt),
      cancelRequestedAt: formatTimestamp(job.cancelRequestedAt),
      stopRequestedAt: formatTimestamp(job.stopRequestedAt),
      stopCause: job.stopCause ?? null,
      error: job.error ?? null,
      summary: job.summary ?? null,
      budgetUsd: job.budgetUsd ?? null,
      costUsd: typeof job.costUsd === "number" ? job.costUsd : null,
      tokens: job.tokens ?? null,
      durationSec: job.durationSec ?? 0,
      filesChanged: Array.isArray(job.filesChanged) ? job.filesChanged : [],
      delivery: job.delivery ?? null,
      revision: job.revision ?? 1,
      runtime,
      policy: job.policy ?? null,
      queuePriority: Number(job.queuePriority) || 0,
    },
    snapshot: !TERMINAL_STATES.has(job.state),
    paths: {
      job: jobPath,
      log: logPath,
      sessionFile,
      sessionFileRelative: Boolean(sessionFile && !isAbsolute(sessionFile)),
    },
    timeline: events.map(timelineLine),
    git,
    reviewCommand: review,
  };
}

function groupForDigest(job) {
  if (isCleanupNeeded(job)) return "cleanup";
  switch (job.state) {
    case "done": return "done";
    case "failed":
    case "overbudget":
    case "timeout":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return "active";
  }
}

function digestEntry(job) {
  const statusDetail = resolveStatusDetail(job);
  const review = reviewCommand(job);
  return {
    id: job.id,
    state: job.state,
    statusDetail,
    cost: typeof job.costUsd === "number" ? job.costUsd : 0,
    durationSec: job.durationSec ?? 0,
    delivery: job.delivery ?? null,
    reviewCommand: review,
    finishedAt: job.finishedAt ?? job.updatedAt ?? null,
    usedUpdatedAtFallback: !job.finishedAt && Boolean(job.updatedAt),
    prompt: job.prompt ?? null,
    summary: job.summary ?? null,
    phase: job.phase ?? null,
    source: job.source || "pi-jobs",
  };
}

function sum(values) { return values.reduce((acc, value) => acc + value, 0); }

function summarizeGroup(entries) {
  return {
    count: entries.length,
    cost: sum(entries.map((entry) => entry.cost)),
    durationSec: sum(entries.map((entry) => entry.durationSec)),
  };
}

function withinWindow(job, windowStartMs) {
  if (windowStartMs == null) return true;
  const reference = job.finishedAt ?? job.updatedAt;
  if (!reference) return false;
  const ms = new Date(reference).getTime();
  return Number.isFinite(ms) && ms >= windowStartMs;
}

export function buildDigest({ hours = 24, jobs = listJobs({ all: true }), now = new Date() } = {}) {
  const windowStart = new Date(now.getTime() - hours * 3600_000);
  const inWindow = jobs.filter((job) => withinWindow(job, windowStart.getTime()));
  const windowed = inWindow.filter((job) => TERMINAL_STATES.has(job.state) && !isCleanupNeeded(job));
  const groups = { done: [], failed: [], canceled: [] };
  for (const job of windowed) groups[groupForDigest(job)].push(digestEntry(job));
  const cleanupNeeded = jobs.filter(isCleanupNeeded);
  const windowedIds = new Set(windowed.map((job) => job.id));
  const cleanupExtras = cleanupNeeded.filter((job) => !windowedIds.has(job.id));
  const active = inWindow.filter((job) => !TERMINAL_STATES.has(job.state));
  return {
    generatedAt: now.toISOString(),
    windowHours: hours,
    windowStart: windowStart.toISOString(),
    counts: {
      done: groups.done.length,
      failed: groups.failed.length,
      canceled: groups.canceled.length,
      cleanupNeeded: cleanupNeeded.length,
      active: active.length,
    },
    totals: summarizeGroup([...groups.done, ...groups.failed, ...groups.canceled]),
    groups,
    cleanupNeeded: cleanupNeeded.map(digestEntry),
    cleanupExtras: cleanupExtras.map(digestEntry),
    active: active.map(digestEntry),
    queue: readQueueState(),
  };
}

function renderReview(value) {
  return value ? `\`${value}\`` : "_(unavailable)_";
}

function renderDelivery(delivery) {
  if (!delivery) return "_(not recorded)_";
  if (delivery.status === "no-changes") return "no-changes (branch removed)";
  if (!delivery.branch) return delivery.status;
  const pr = delivery.prUrl ? ` — Draft PR ${delivery.prUrl}` : "";
  const fallback = delivery.fallbackReason ? ` — fallback: ${delivery.fallbackReason}` : "";
  return `${delivery.status} — branch \`${delivery.branch}\`${delivery.commit ? ` @ \`${delivery.commit}\`` : ""}${pr}${fallback}`;
}

function renderEntry(entry) {
  const detail = entry.statusDetail ? ` (${entry.statusDetail})` : "";
  const fallback = entry.usedUpdatedAtFallback ? " ⚠ using updatedAt" : "";
  const compact = (value, max) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };
  const lines = [
    `- \`${entry.id}\` **${entry.state}${detail}** — ${formatCost(entry.cost)} — ${formatDuration(entry.durationSec)} — ${renderDelivery(entry.delivery)}${fallback}`,
  ];
  const prompt = compact(entry.prompt, 140);
  const summary = compact(entry.summary, 180);
  if (prompt) lines.push(`  - Task: ${prompt}`);
  if (summary) lines.push(`  - Summary: ${summary}`);
  lines.push(`  - Review: ${renderReview(entry.reviewCommand)}`);
  return lines.join("\n");
}

function renderGroup(title, entries, summary) {
  if (!entries.length) return null;
  const header = `**${title} (${summary.count})**\n\n- Total cost: ${formatCost(summary.cost)}\n- Total duration: ${formatDuration(summary.durationSec)}`;
  return `${header}\n\n${entries.map(renderEntry).join("\n")}`;
}

function renderCleanupSection(digest) {
  if (!digest.cleanupNeeded.length) return null;
  const lines = digest.cleanupNeeded.map((entry) => `- \`${entry.id}\` **${entry.state}${entry.statusDetail ? ` (${entry.statusDetail})` : ""}** — branch: ${entry.delivery?.branch ? `\`${entry.delivery.branch}\`` : "_(none)_"}`);
  const note = "Cleanup-needed jobs are listed without a time window and are not counted in the totals above.";
  return `**Open cleanup-needed (${digest.cleanupNeeded.length})**\n\n${note}\n\n${lines.join("\n")}`;
}

function renderActiveSection(digest) {
  if (!digest.active.length) return null;
  const lines = digest.active.map((entry) => `- \`${entry.id}\` **${entry.state}${entry.phase ? `/${entry.phase}` : ""}**`);
  return `**Active (${digest.active.length})**\n\n${lines.join("\n")}`;
}

export function renderDigestMarkdown(digest) {
  const generated = formatTimestamp(digest.generatedAt);
  const sections = [
    `# pi-jobs digest (last ${digest.windowHours}h)`,
    `_Generated at ${generated}; window starts at ${formatTimestamp(digest.windowStart)}._`,
    digest.queue?.paused ? `> Queue is **PAUSED** since ${formatTimestamp(digest.queue.pausedAt)}.` : `Queue: active`,
    `**Totals** — ${digest.totals.count} jobs — ${formatCost(digest.totals.cost)} — ${formatDuration(digest.totals.durationSec)}`,
  ];
  const done = renderGroup("Done", digest.groups.done, summarizeGroup(digest.groups.done));
  const failed = renderGroup("Failed / overbudget / timeout", digest.groups.failed, summarizeGroup(digest.groups.failed));
  const canceled = renderGroup("Canceled", digest.groups.canceled, summarizeGroup(digest.groups.canceled));
  if (done) sections.push(done);
  if (failed) sections.push(failed);
  if (canceled) sections.push(canceled);
  const cleanup = renderCleanupSection(digest);
  if (cleanup) sections.push(cleanup);
  const active = renderActiveSection(digest);
  if (active) sections.push(active);
  return sections.join("\n\n") + "\n";
}

export function renderDigestText(digest) {
  const lines = [`**pi-jobs digest (last ${digest.windowHours}h)**`, digest.queue?.paused ? `> Queue is **PAUSED** since ${formatTimestamp(digest.queue.pausedAt)}.` : "Queue: active"];
  const done = renderGroup("Done", digest.groups.done, summarizeGroup(digest.groups.done));
  const failed = renderGroup("Failed / overbudget / timeout", digest.groups.failed, summarizeGroup(digest.groups.failed));
  const canceled = renderGroup("Canceled", digest.groups.canceled, summarizeGroup(digest.groups.canceled));
  if (done) lines.push(done);
  if (failed) lines.push(failed);
  if (canceled) lines.push(canceled);
  const cleanup = renderCleanupSection(digest);
  if (cleanup) lines.push(cleanup);
  const active = renderActiveSection(digest);
  if (active) lines.push(active);
  const totals = `**Totals** — ${digest.totals.count} jobs — ${formatCost(digest.totals.cost)} — ${formatDuration(digest.totals.durationSec)}`;
  lines.push(totals);
  return lines.join("\n\n");
}

export function renderAuditMarkdown(audit) {
  if (!audit.available) return `# pi-jobs audit\n\n_Not available: ${audit.reason}_\n`;
  const job = audit.job;
  const lines = [
    `# pi-jobs audit — \`${job.id}\``,
    audit.snapshot ? `_Non-terminal snapshot captured at ${formatTimestamp(audit.job.updatedAt)}._` : `_Terminal state captured at ${formatTimestamp(job.finishedAt)}._`,
    `**State:** ${job.state}${job.phase ? `/${job.phase}` : ""}${job.statusDetail ? ` (${job.statusDetail})` : ""}`,
    `**Source:** ${job.source}`,
    `**Schema:** v${job.schemaVersion} (revision ${job.revision})`,
  ];
  if (job.prompt) lines.push(`**Prompt:**\n\n> ${String(job.prompt).replace(/\n/g, "\n> ")}`);
  if (job.repoRoot) lines.push(`**Repository:** \`${job.repoRoot}\``);
  lines.push(`**Base:** \`${job.baseCommit ?? UNKNOWN}\`${job.baseRef ? ` (${job.baseRef})` : ""}`);
  if (job.dirtyAtSubmit) lines.push(`> ⚠ The submit workspace was dirty; uncommitted changes were not included.`);
  if (job.migrationBaseApproximate) lines.push(`> ⚠ Legacy pending job used the committed HEAD at migration time as an approximate base.`);
  lines.push(`**Created / started / finished:** ${job.createdAt} / ${job.startedAt} / ${job.finishedAt}`);
  lines.push(`**Runtime:** provider \`${job.runtime.provider}\` — model \`${job.runtime.model}\` — Pi \`${job.runtime.piVersion}\` (${job.runtime.piPath})`);
  const runtimeTools = Array.isArray(job.runtime.policy.tools) ? job.runtime.policy.tools.join(",") : job.runtime.policy.tools;
  lines.push(`**Effective policy:** tools \`${runtimeTools}\` — no-network \`${job.runtime.policy.noNetwork}\` — max-turns \`${job.runtime.policy.maxTurns}\``);
  if (job.policy) lines.push(`**Requested policy:** tools \`${(job.policy.tools || []).join(",")}\` — no-network \`${job.policy.noNetwork}\` — max-turns \`${job.policy.maxTurns}\``);
  if (job.runtime.capturedAt && job.runtime.capturedAt !== UNKNOWN) lines.push(`**Runtime captured at:** ${job.runtime.capturedAt}`);
  lines.push(`**Budget / cost / tokens:** $${job.budgetUsd ?? UNKNOWN} / ${formatCost(job.costUsd)} / ${formatTokens(job.tokens)}`);
  lines.push(`**Duration:** ${formatDuration(job.durationSec)}`);
  if (job.stopCause) lines.push(`**Stop cause:** \`${job.stopCause}\` at ${job.stopRequestedAt}`);
  if (job.error) lines.push(`**Error:** ${job.error}`);
  lines.push(`**Delivery:** ${renderDelivery(job.delivery)}`);
  if (job.summary) lines.push(`**Summary:**\n\n> ${String(job.summary).replace(/\n/g, "\n> ")}`);
  lines.push(`**Status timeline:**\n\n${audit.timeline.length ? audit.timeline.join("\n") : "_(no events)_"}`);
  if (audit.git.available) {
    lines.push(`**git diff --stat** (commit \`${audit.git.commit}\`):`);
    lines.push(`\`\`\`text\n${audit.git.stat}\n\`\`\``);
    if (audit.git.files.length) {
      const sample = audit.git.files.slice(0, 20).map((line) => `  ${line}`).join("\n");
      const more = audit.git.files.length > 20 ? `\n  _…and ${audit.git.files.length - 20} more_` : "";
      lines.push(`**File status (${audit.git.files.length}):**\n\n${sample}${more}`);
    } else {
      lines.push(`**File status:** _(none)_`);
    }
  } else {
    lines.push(`**git diff --stat:** _unavailable — ${audit.git.reason}_`);
  }
  if (audit.reviewCommand) lines.push(`**Review command:** \`${audit.reviewCommand}\``);
  const sessionNote = audit.paths.sessionFileRelative ? " (relative path as recorded)" : "";
  lines.push(`**Paths:**\n- job record: \`${audit.paths.job}\`\n- job log: \`${audit.paths.log}\`${audit.paths.sessionFile ? `\n- session: \`${audit.paths.sessionFile}\`${sessionNote}` : ""}`);
  return lines.join("\n\n") + "\n";
}

export function renderAuditText(audit) {
  if (!audit.available) return `**pi-jobs audit**\n\n_Not available: ${audit.reason}_`;
  const job = audit.job;
  const lines = [
    `**pi-jobs audit — \`${job.id}\`**`,
    audit.snapshot ? `_Non-terminal snapshot at ${job.updatedAt}._` : `_Terminal state at ${job.finishedAt}._`,
    `State: **${job.state}${job.phase ? `/${job.phase}` : ""}**${job.statusDetail ? ` (${job.statusDetail})` : ""}`,
    `Source: ${job.source} (schema v${job.schemaVersion}, revision ${job.revision})`,
  ];
  if (job.prompt) lines.push(`Prompt: ${job.prompt}`);
  if (job.repoRoot) lines.push(`Repository: \`${job.repoRoot}\``);
  lines.push(`Base: \`${job.baseCommit ?? UNKNOWN}\`${job.baseRef ? ` (${job.baseRef})` : ""}`);
  if (job.dirtyAtSubmit) lines.push(`⚠ The submit workspace was dirty; uncommitted changes were not included.`);
  if (job.migrationBaseApproximate) lines.push(`⚠ Legacy pending job used the committed HEAD at migration time as an approximate base.`);
  lines.push(`Created / started / finished: ${job.createdAt} / ${job.startedAt} / ${job.finishedAt}`);
  lines.push(`Runtime: provider \`${job.runtime.provider}\`, model \`${job.runtime.model}\`, Pi \`${job.runtime.piVersion}\` (${job.runtime.piPath})`);
  const runtimeTools = Array.isArray(job.runtime.policy.tools) ? job.runtime.policy.tools.join(",") : job.runtime.policy.tools;
  lines.push(`Effective policy: tools \`${runtimeTools}\`, no-network \`${job.runtime.policy.noNetwork}\`, max-turns \`${job.runtime.policy.maxTurns}\``);
  if (job.policy) lines.push(`Requested policy: tools \`${(job.policy.tools || []).join(",")}\`, no-network \`${job.policy.noNetwork}\`, max-turns \`${job.policy.maxTurns}\``);
  lines.push(`Budget / cost / tokens: $${job.budgetUsd ?? UNKNOWN} / ${formatCost(job.costUsd)} / ${formatTokens(job.tokens)}`);
  lines.push(`Duration: ${formatDuration(job.durationSec)}`);
  if (job.stopCause) lines.push(`Stop cause: \`${job.stopCause}\` at ${job.stopRequestedAt}`);
  if (job.error) lines.push(`Error: ${job.error}`);
  lines.push(`Delivery: ${renderDelivery(job.delivery)}`);
  if (job.summary) lines.push(`Summary: ${job.summary}`);
  lines.push(`Status timeline:\n\n${audit.timeline.length ? audit.timeline.join("\n") : "_(no events)_"}`);
  if (audit.git.available) {
    lines.push(`git diff --stat (commit \`${audit.git.commit}\`):\n\`\`\`text\n${audit.git.stat}\n\`\`\``);
    if (audit.git.files.length) {
      const sample = audit.git.files.slice(0, 20).map((line) => `  ${line}`).join("\n");
      const more = audit.git.files.length > 20 ? `\n  _…and ${audit.git.files.length - 20} more_` : "";
      lines.push(`File status (${audit.git.files.length}):\n${sample}${more}`);
    }
  } else {
    lines.push(`git diff --stat: _unavailable — ${audit.git.reason}_`);
  }
  if (audit.reviewCommand) lines.push(`Review command: \`${audit.reviewCommand}\``);
  const sessionNote = audit.paths.sessionFileRelative ? " (relative path as recorded)" : "";
  lines.push(`Paths: job \`${audit.paths.job}\`, log \`${audit.paths.log}\`${audit.paths.sessionFile ? `, session \`${audit.paths.sessionFile}\`${sessionNote}` : ""}`);
  return lines.join("\n\n");
}

export function writeReportAtomic(dir, filename, content) {
  const path = join(dir, filename);
  atomicWrite(path, content);
  return path;
}

export function writeDigestReport(digest, { now = new Date() } = {}) {
  const stamp = new Date(now.getTime()).toISOString().replace(/[:.]/g, "-");
  const filename = `digest-${stamp}-${randomBytes(4).toString("hex")}.md`;
  const path = writeReportAtomic(DIGESTS_DIR, filename, renderDigestMarkdown(digest));
  return path;
}

export function writeAuditReport(audit) {
  const job = audit.job;
  const filename = `${job.id}-r${job.revision}.md`;
  const path = writeReportAtomic(AUDITS_DIR, filename, renderAuditMarkdown(audit));
  return path;
}

export { parseEventsFor as readJobEvents };

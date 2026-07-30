import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inspectRepo } from "../lib/gitops.mjs";
import { migrateLegacyData } from "../lib/migrate.mjs";
import {
  appendJobLog, createJob, generateJobId, listJobs, loadConfig, prioritizeJob, readJob, readJobLog,
  readQueueState, requestCancel, setQueuePaused,
} from "../lib/store.mjs";
import {
  RUNNER_PATH, doctor, formatDoctor, scheduledRunnerStatus, setupScheduledTask, uninstallScheduledTask, wakeWorker,
} from "../lib/scheduler.mjs";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../lib/version.mjs";
import { buildAudit, buildDigest, renderAuditText, renderDigestText, writeAuditReport, writeDigestReport } from "../lib/report.mjs";
import { cleanup, formatCleanupResults } from "../lib/cleanup.mjs";
import { sendWindowsToast } from "../lib/notify.mjs";
import { parseAddArgs, parseCleanupArgs, parseDigestArgs, parseJobIdArg, parseNoArgs, parseSetupPrArgs } from "../lib/command-args.mjs";
import { configurePrRepository, inspectPrSetup, preflightPrJob } from "../lib/pr-delivery.mjs";

function stateLine(job: any) {
  const phase = job.phase ? `/${job.phase}` : "";
  const detail = job.statusDetail ? ` (${job.statusDetail})` : "";
  const dirty = job.dirtyAtSubmit ? " ⚠ submit workspace was dirty" : "";
  const approximate = job.migrationBaseApproximate ? " ⚠ approximate migration base" : "";
  const priority = Number(job.queuePriority) > 0 ? ` ↑${job.queuePriority}` : "";
  const pr = job.delivery?.prUrl ? ` — ${job.delivery.prUrl}` : "";
  return `- \`${job.id}\` **${job.state}${phase}**${detail}${priority} — $${Number(job.costUsd || 0).toFixed(4)} — ${job.prompt}${dirty}${approximate}${pr}`;
}

function send(pi: ExtensionAPI, content: string) {
  pi.sendMessage({ customType: "pi-jobs", content, display: true }, { triggerTurn: false });
}

export default function (pi: ExtensionAPI) {
  const confirmPr = async (ctx: any, repo: any, delivery: any, jobId: string) => {
    const branch = `pi-jobs-${jobId}`;
    const dirty = repo.dirtyAtSubmit ? "\n\nWARNING: uncommitted changes are not included." : "";
    return ctx.ui.confirm("Queue Draft PR delivery?", [
      `GitHub account: ${delivery.authorization.confirmedBy}`,
      `Repository: ${delivery.target.repository}`,
      `Remote/base: ${delivery.target.remoteName}/${delivery.target.baseBranch}`,
      `Result branch: ${branch}`,
      dirty,
    ].filter(Boolean).join("\n"));
  };

  const handle = async (rawArgs: string, ctx: any) => {
    try { migrateLegacyData(); } catch (error) { ctx.ui.notify(`pi-jobs migration warning: ${error}`, "warning"); }
    const trimmed = (rawArgs || "").trim();
    const split = trimmed.indexOf(" ");
    const sub = (split < 0 ? trimmed : trimmed.slice(0, split)).toLowerCase();
    let rest = split < 0 ? "" : trimmed.slice(split + 1).trim();

    try {
      switch (sub) {
        case "add": {
          const config = loadConfig();
          const parsed = parseAddArgs(rest, config);
          const repo = inspectRepo(ctx.cwd);
          const id = generateJobId();
          let delivery: any = { type: "branch", status: "not-started", branch: null, commit: null };
          if (parsed.delivery === "pr") {
            delivery = preflightPrJob(repo, config, id);
            if (!(await confirmPr(ctx, repo, delivery, id))) return ctx.ui.notify("pi-jobs: PR job was not queued", "info");
            delivery.authorization.confirmedAt = new Date().toISOString();
          }
          const job = createJob({
            prompt: parsed.prompt, ...repo, budgetUsd: parsed.budgetUsd, timeoutMin: parsed.timeoutMin,
            maxTurns: parsed.maxTurns, policy: { tools: parsed.tools, noNetwork: parsed.noNetwork, maxTurns: parsed.maxTurns },
            provider: config.provider, model: config.model, delivery,
          }, { id });
          if (repo.dirtyAtSubmit) appendJobLog(job.id, "warning: uncommitted workspace changes are not included in this job");
          const wake = wakeWorker("job-add");
          const warning = repo.dirtyAtSubmit ? " Uncommitted changes are NOT included." : "";
          const paused = readQueueState().paused ? " Queue is paused." : "";
          if (wake.started) ctx.ui.notify(`pi-jobs: queued ${job.id}; worker requested.${warning}${paused}`, repo.dirtyAtSubmit ? "warning" : "info");
          else ctx.ui.notify(`pi-jobs: queued ${job.id}, but worker was not started (${wake.error}). Run /job setup.${warning}`, "warning");
          return;
        }
        case "list": {
          const all = /(?:^|\s)--all(?:\s|$)/.test(rest);
          const jobs = listJobs({ all });
          const paused = readQueueState().paused ? " — **PAUSED**" : "";
          send(pi, jobs.length ? `**pi-jobs ${all ? "history" : "active queue"}${paused}**\n\n${jobs.map(stateLine).join("\n")}` : `pi-jobs queue is empty${paused}`);
          return;
        }
        case "status": {
          const job = readJob(rest.trim());
          if (!job) return ctx.ui.notify(`pi-jobs: no such job ${rest.trim()}`, "warning");
          const fields = [
            `# ${job.id}`, `State: **${job.state}${job.phase ? `/${job.phase}` : ""}**`,
            job.statusDetail && `Detail: ${job.statusDetail}`,
            `Source: ${job.source || "pi-jobs"}`, `Repository: \`${job.repoRoot}\``,
            `Base: \`${job.baseCommit}\`${job.baseRef ? ` (${job.baseRef})` : ""}`,
            job.dirtyAtSubmit && "⚠ The submit workspace was dirty; uncommitted changes were not included.",
            job.migrationBaseApproximate && "⚠ Legacy pending job used the committed HEAD at migration time as an approximate base.",
            `Budget/timeout: $${job.budgetUsd} / ${job.timeoutMin}m`,
            `Policy: tools=${job.policy?.tools?.join(",") || "unknown"}; no-network=${job.policy?.noNetwork ?? "unknown"}; max-turns=${job.policy?.maxTurns ?? job.maxTurns ?? "unknown"}`,
            `Cost: $${Number(job.costUsd || 0).toFixed(4)}`,
            `Delivery: ${job.delivery?.status}${job.delivery?.branch ? ` — \`${job.delivery.branch}\`` : ""}`,
            job.delivery?.prUrl && `PR: ${job.delivery.prUrl}`,
            job.stopCause && `Stop: ${job.stopCause} at ${job.stopRequestedAt}`,
            `Revision: ${job.revision}`,
          ].filter(Boolean);
          send(pi, fields.join("\n\n"));
          return;
        }
        case "log": {
          const id = rest.trim();
          if (!readJob(id)) return ctx.ui.notify(`pi-jobs: no such job ${id}`, "warning");
          send(pi, `**log ${id}**\n\n\`\`\`text\n${readJobLog(id) || "(no log yet)"}\n\`\`\``);
          return;
        }
        case "result": {
          const job = readJob(rest.trim());
          if (!job) return ctx.ui.notify(`pi-jobs: no such job ${rest.trim()}`, "warning");
          const delivery = job.delivery || {};
          const review = delivery.branch && job.baseCommit ? `\n\nReview: \`git -C "${job.repoRoot}" diff ${job.baseCommit}..${delivery.branch}\`` : "";
          const pr = delivery.prUrl ? `\n\nDraft PR: ${delivery.prUrl}` : "";
          send(pi, `**${job.source === "legacy-nightshift" ? "legacy-nightshift" : "pi-jobs"} result ${job.id}**\n\nState: ${job.state}${job.statusDetail ? ` (${job.statusDetail})` : ""}\n\nDelivery: ${delivery.status}${delivery.branch ? ` — \`${delivery.branch}\`` : ""}${delivery.commit ? ` @ \`${delivery.commit}\`` : ""}${pr}\n\n${job.summary || "(no summary)"}${review}`);
          return;
        }
        case "cancel": {
          const id = rest.trim();
          const job = requestCancel(id, "pi-command");
          ctx.ui.notify(`pi-jobs: ${job.state === "canceled" ? "canceled" : "cancel requested for"} ${id}`, "info");
          return;
        }
        case "retry": {
          const old = readJob(parseJobIdArg(rest, "usage: /job retry <id>"));
          if (!old) return ctx.ui.notify(`pi-jobs: no such job ${rest.trim()}`, "warning");
          if (!["done", "failed", "overbudget", "timeout", "canceled"].includes(old.state)) return ctx.ui.notify("pi-jobs: only terminal jobs can be retried", "warning");
          const repo = inspectRepo(old.repoRoot);
          const config = loadConfig();
          const id = generateJobId();
          let delivery: any = { type: "branch", status: "not-started", branch: null, commit: null };
          if (old.delivery?.type === "pr") {
            delivery = preflightPrJob(repo, config, id);
            if (!(await confirmPr(ctx, repo, delivery, id))) return ctx.ui.notify("pi-jobs: PR retry was not queued", "info");
            delivery.authorization.confirmedAt = new Date().toISOString();
          }
          const retry = createJob({
            prompt: old.prompt, ...repo, budgetUsd: old.budgetUsd, timeoutMin: old.timeoutMin,
            maxTurns: old.policy?.maxTurns ?? old.maxTurns, policy: old.policy ?? undefined,
            provider: old.provider, model: old.model, retryOf: old.id, delivery,
          }, { id });
          if (repo.dirtyAtSubmit) appendJobLog(retry.id, "warning: uncommitted workspace changes are not included in this retry");
          const wake = wakeWorker("job-retry");
          ctx.ui.notify(`pi-jobs: queued retry ${retry.id} of ${old.id}${wake.started ? "" : "; worker start failed—run /job setup"}`, wake.started ? "info" : "warning");
          return;
        }
        case "setup-pr": {
          const args = parseSetupPrArgs(rest);
          const repo = inspectRepo(ctx.cwd);
          const config = loadConfig();
          const setup = inspectPrSetup(repo.repoRoot, { remoteName: args.remote, baseBranch: args.base });
          const accepted = await ctx.ui.confirm("Configure Draft PR delivery?", [
            `GitHub account: ${setup.account}`, `Repository: ${setup.repository}`,
            `Remote: ${setup.remoteName} (${setup.remoteUrl})`, `Base: ${setup.baseBranch}`,
            setup.transport === "https" ? "GitHub CLI will be configured as the Git credential helper." : "SSH credentials will be verified non-interactively.",
          ].join("\n"));
          if (!accepted) return ctx.ui.notify("pi-jobs: PR setup canceled", "info");
          configurePrRepository(config, setup);
          ctx.ui.notify(`pi-jobs: PR delivery configured for ${setup.repository} via ${setup.remoteName}/${setup.baseBranch}`, "info");
          return;
        }
        case "pause": {
          parseNoArgs(rest, "usage: /job pause");
          const state = setQueuePaused(true, "pi-command");
          ctx.ui.notify(state.changed ? "pi-jobs: queue paused; current job may finish" : "pi-jobs: queue is already paused", "info");
          return;
        }
        case "resume": {
          parseNoArgs(rest, "usage: /job resume");
          const state = setQueuePaused(false, "pi-command");
          const wake = wakeWorker("queue-resume");
          ctx.ui.notify(`${state.changed ? "pi-jobs: queue resumed" : "pi-jobs: queue was already active"}${wake.started ? "" : `; worker start failed (${wake.error})`}`, wake.started ? "info" : "warning");
          return;
        }
        case "prioritize": {
          const id = parseJobIdArg(rest, "usage: /job prioritize <id>");
          const job = prioritizeJob(id);
          const wake = readQueueState().paused ? null : wakeWorker("queue-prioritize");
          ctx.ui.notify(`pi-jobs: prioritized ${id} (priority ${job.queuePriority})${wake && !wake.started ? "; worker start failed" : ""}`, wake && !wake.started ? "warning" : "info");
          return;
        }
        case "digest": {
          const { hours, markdown, notify } = parseDigestArgs(rest);
          const digest = buildDigest({ hours });
          let path: string | null = null;
          if (markdown) path = writeDigestReport(digest);
          let warning: string | null = null;
          if (notify) {
            const toast = sendWindowsToast({
              title: `pi-jobs digest (${digest.counts.done} done, ${digest.counts.failed} stopped, ${digest.counts.canceled} canceled)`,
              body: `Cost $${digest.totals.cost.toFixed(4)} · ${digest.counts.cleanupNeeded} cleanup-needed`,
            });
            if (!toast.ok) warning = `toast: ${toast.error}`;
          }
          const text = renderDigestText(digest);
          const suffix = path ? `\n\n_Written: \`${path}\`_` : "";
          const warn = warning ? `\n\n⚠ ${warning}` : "";
          send(pi, `${text}${suffix}${warn}`);
          return;
        }
        case "audit": {
          const id = rest.trim();
          if (!id) return ctx.ui.notify("usage: /job audit <id>", "warning");
          const audit = buildAudit(id);
          if (!audit.available) return ctx.ui.notify(`pi-jobs: ${audit.reason}`, "warning");
          const path = writeAuditReport(audit);
          send(pi, `${renderAuditText(audit)}\n\n_Written: \`${path}\`_`);
          return;
        }
        case "cleanup": {
          const { dryRun } = parseCleanupArgs(rest);
          const config = loadConfig();
          const result = cleanup({ dryRun, config });
          send(pi, `**pi-jobs cleanup${dryRun ? " (dry-run)" : ""}**\n\n${formatCleanupResults(result.results, dryRun)}`);
          return;
        }
        case "setup": {
          const result = setupScheduledTask();
          wakeWorker("setup");
          ctx.ui.notify(`pi-jobs: scheduled task ${result.TaskName || "pi-jobs-worker"} installed with Queue policy`, "info");
          return;
        }
        case "doctor": send(pi, `**pi-jobs doctor**\n\n\`\`\`text\n${formatDoctor(doctor({ cwd: ctx.cwd }))}\n\`\`\``); return;
        case "version": {
          const runner = scheduledRunnerStatus();
          send(pi, [
            `**${PACKAGE_NAME} ${PACKAGE_VERSION}**`,
            `Runner: \`${RUNNER_PATH}\``,
            `Scheduled runner: ${runner.ok ? "current" : "needs /job setup"}`,
            !runner.ok && runner.detail,
          ].filter(Boolean).join("\n\n"));
          return;
        }
        case "uninstall": {
          const result = uninstallScheduledTask();
          ctx.ui.notify(`pi-jobs worker task removed; data preserved at ${result.dataPreserved}`, "info");
          return;
        }
        default:
          ctx.ui.notify("usage: /job add|list|status|log|result|cancel|retry|setup-pr|pause|resume|prioritize|digest|audit|cleanup|setup|doctor|version|uninstall", "info");
      }
    } catch (error) {
      ctx.ui.notify(`pi-jobs: ${error}`, "error");
    }
  };

  pi.registerCommand("job", {
    description: "auditable background jobs: branch/PR delivery, policies, queue control, reports, and maintenance",
    handler: handle,
  });
  pi.registerCommand("ns", {
    description: "deprecated compatibility alias for /job",
    handler: async (args: string, ctx: any) => {
      ctx.ui.notify("/ns is deprecated; use /job (compatibility alias will be removed in a future major version)", "warning");
      const trimmed = (args || "").trim();
      const mapped = trimmed.replace(/^rm(?:\s+|$)/, "cancel ").replace(/^digest(?:\s*)$/, "digest");
      return handle(mapped, ctx);
    },
  });
}

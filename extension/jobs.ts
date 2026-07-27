import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inspectRepo } from "../lib/gitops.mjs";
import { migrateLegacyData } from "../lib/migrate.mjs";
import {
  appendJobLog, createJob, listJobs, loadConfig, readJob, readJobLog, requestCancel,
} from "../lib/store.mjs";
import {
  doctor, formatDoctor, setupScheduledTask, uninstallScheduledTask, wakeWorker,
} from "../lib/scheduler.mjs";

function takeFlag(text: string, name: string, fallback: number) {
  const match = text.match(new RegExp(`(?:^|\\s)--${name}\\s+(\\d+(?:\\.\\d+)?)`));
  const value = match ? Number(match[1]) : fallback;
  return { text: match ? text.replace(match[0], " ") : text, value };
}

function stateLine(job: any) {
  const phase = job.phase ? `/${job.phase}` : "";
  const detail = job.statusDetail ? ` (${job.statusDetail})` : "";
  const dirty = job.dirtyAtSubmit ? " ⚠ submit workspace was dirty" : "";
  const approximate = job.migrationBaseApproximate ? " ⚠ approximate migration base" : "";
  return `- \`${job.id}\` **${job.state}${phase}**${detail} — $${Number(job.costUsd || 0).toFixed(4)} — ${job.prompt}${dirty}${approximate}`;
}

function send(pi: ExtensionAPI, content: string) {
  pi.sendMessage({ customType: "pi-jobs", content, display: true }, { triggerTurn: false });
}

export default function (pi: ExtensionAPI) {
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
          const budget = takeFlag(rest, "budget", config.budgetUsd);
          const timeout = takeFlag(budget.text, "timeout", config.timeoutMin);
          rest = timeout.text.replace(/\s+/g, " ").trim();
          if (!rest || /--(?:budget|timeout)\b/.test(rest) || !(budget.value > 0) || !(timeout.value > 0)) {
            ctx.ui.notify("usage: /job add <prompt> [--budget N] [--timeout MIN]", "warning");
            return;
          }
          const repo = inspectRepo(ctx.cwd);
          const job = createJob({
            prompt: rest, ...repo, budgetUsd: budget.value, timeoutMin: timeout.value,
            maxTurns: config.maxTurns, provider: config.provider, model: config.model,
          });
          if (repo.dirtyAtSubmit) appendJobLog(job.id, "warning: uncommitted workspace changes are not included in this job");
          const wake = wakeWorker("job-add");
          const warning = repo.dirtyAtSubmit ? " Uncommitted changes are NOT included." : "";
          if (wake.started) ctx.ui.notify(`pi-jobs: queued ${job.id}; worker requested.${warning}`, repo.dirtyAtSubmit ? "warning" : "info");
          else ctx.ui.notify(`pi-jobs: queued ${job.id}, but worker was not started (${wake.error}). Run /job setup.${warning}`, "warning");
          return;
        }
        case "list": {
          const all = /(?:^|\s)--all(?:\s|$)/.test(rest);
          const jobs = listJobs({ all });
          send(pi, jobs.length ? `**pi-jobs ${all ? "history" : "active queue"}**\n\n${jobs.map(stateLine).join("\n")}` : "pi-jobs queue is empty");
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
            `Cost: $${Number(job.costUsd || 0).toFixed(4)}`,
            `Delivery: ${job.delivery?.status}${job.delivery?.branch ? ` — \`${job.delivery.branch}\`` : ""}`,
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
          send(pi, `**${job.source === "legacy-nightshift" ? "legacy-nightshift" : "pi-jobs"} result ${job.id}**\n\nState: ${job.state}${job.statusDetail ? ` (${job.statusDetail})` : ""}\n\nDelivery: ${delivery.status}${delivery.branch ? ` — \`${delivery.branch}\`` : ""}${delivery.commit ? ` @ \`${delivery.commit}\`` : ""}\n\n${job.summary || "(no summary)"}${review}`);
          return;
        }
        case "cancel": {
          const id = rest.trim();
          const job = requestCancel(id, "pi-command");
          ctx.ui.notify(`pi-jobs: ${job.state === "canceled" ? "canceled" : "cancel requested for"} ${id}`, "info");
          return;
        }
        case "retry": {
          const old = readJob(rest.trim());
          if (!old) return ctx.ui.notify(`pi-jobs: no such job ${rest.trim()}`, "warning");
          if (!["done", "failed", "overbudget", "timeout", "canceled"].includes(old.state)) return ctx.ui.notify("pi-jobs: only terminal jobs can be retried", "warning");
          const repo = inspectRepo(old.repoRoot);
          const retry = createJob({
            prompt: old.prompt, ...repo, budgetUsd: old.budgetUsd, timeoutMin: old.timeoutMin,
            maxTurns: old.maxTurns, provider: old.provider, model: old.model, retryOf: old.id,
          });
          if (repo.dirtyAtSubmit) appendJobLog(retry.id, "warning: uncommitted workspace changes are not included in this retry");
          const wake = wakeWorker("job-retry");
          ctx.ui.notify(`pi-jobs: queued retry ${retry.id} of ${old.id}${wake.started ? "" : "; worker start failed—run /job setup"}`, wake.started ? "info" : "warning");
          return;
        }
        case "setup": {
          const result = setupScheduledTask();
          wakeWorker("setup");
          ctx.ui.notify(`pi-jobs: scheduled task ${result.TaskName || "pi-jobs-worker"} installed with Queue policy`, "info");
          return;
        }
        case "doctor": send(pi, `**pi-jobs doctor**\n\n\`\`\`text\n${formatDoctor(doctor())}\n\`\`\``); return;
        case "uninstall": {
          const result = uninstallScheduledTask();
          ctx.ui.notify(`pi-jobs worker task removed; data preserved at ${result.dataPreserved}`, "info");
          return;
        }
        default:
          ctx.ui.notify("usage: /job add|list|status|log|result|cancel|retry|setup|doctor|uninstall", "info");
      }
    } catch (error) {
      ctx.ui.notify(`pi-jobs: ${error}`, "error");
    }
  };

  pi.registerCommand("job", {
    description: "auditable background jobs: add, list, status, log, result, cancel, retry, setup, doctor, uninstall",
    handler: handle,
  });
  pi.registerCommand("ns", {
    description: "deprecated compatibility alias for /job",
    handler: async (args: string, ctx: any) => {
      ctx.ui.notify("/ns is deprecated; use /job (compatibility alias will be removed in a future major version)", "warning");
      const trimmed = (args || "").trim();
      const mapped = trimmed.replace(/^rm(?:\s+|$)/, "cancel ").replace(/^digest(?:\s*)$/, "list");
      return handle(mapped, ctx);
    },
  });
}

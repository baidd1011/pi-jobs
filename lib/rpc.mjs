import { appendFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { DATA_DIR, readCancelMarker } from "./store.mjs";

const PRIORITY = { canceled: 4, overbudget: 3, timeout: 2, "max-turns": 1 };

function millis(value) {
  const number = new Date(value).getTime();
  return Number.isFinite(number) ? number : Number.POSITIVE_INFINITY;
}

export function selectStopCandidate(...candidates) {
  return candidates.filter((candidate) => candidate?.cause).sort((a, b) => {
    const byTime = millis(a.requestedAt) - millis(b.requestedAt);
    return byTime || (PRIORITY[b.cause] ?? 0) - (PRIORITY[a.cause] ?? 0);
  })[0] ?? null;
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try { execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
}

function spawnPi(config, args, cwd) {
  const command = config.piPath || "pi";
  const commandArgs = [...(Array.isArray(config.piArgs) ? config.piArgs : []), ...args];
  const shell = process.platform === "win32" && (!/\.[A-Za-z0-9]+$/.test(command) || /\.(?:cmd|bat)$/i.test(command));
  const options = {
    cwd, detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  };
  if (shell) {
    const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
    return spawn([quote(command), ...commandArgs.map(quote)].join(" "), { ...options, shell: true });
  }
  return spawn(command, commandArgs, options);
}

// Resolves with a terminal result and never rejects. Hooks persist stopCause before abort.
export function runPiTask(task, config, log, hooks = {}) {
  return new Promise((resolve) => {
    const args = ["--mode", "rpc", "--no-extensions"];
    const provider = task.provider ?? config.provider;
    const model = task.model ?? config.model;
    if (provider) args.push("--provider", provider);
    if (model) args.push("--model", model);

    const startedMs = Date.now();
    const child = spawnPi(config, args, task.worktreePath || task.cwd || task.repoRoot);
    const state = {
      cost: 0, tokens: null, sessionFile: null, lastText: "", stderrTail: "",
      settled: false, stop: null, stopReason: null, llmError: null, turns: 0,
    };
    let buffer = "";
    let done = false;
    let abortStarted = false;
    let graceTimer = null;

    const statsPollMs = config.statsPollMs ?? 15_000;
    const cancelPollMs = config.cancelPollMs ?? 1_000;
    const abortGraceMs = config.abortGraceMs ?? 30_000;
    const finalStatsMs = config.finalStatsMs ?? 500;
    const timeoutMs = Math.max(1, Number(task.timeoutMin ?? config.timeoutMin ?? 30) * 60_000);
    const maxTurns = task.maxTurns ?? config.maxTurns ?? 200;

    const send = (value) => {
      try { child.stdin.write(JSON.stringify(value) + "\n"); } catch {}
    };

    const finish = (status, error) => {
      if (done) return;
      done = true;
      clearTimeout(timeoutTimer);
      clearInterval(statsTimer);
      clearInterval(cancelTimer);
      clearTimeout(graceTimer);
      try { child.stdin.destroy(); } catch {}
      try { child.stdout.destroy(); } catch {}
      try { child.stderr.destroy(); } catch {}
      try { child.kill("SIGKILL"); } catch {}
      killTree(child.pid);
      const cause = state.stop?.cause ?? null;
      resolve({
        status: cause === "max-turns" ? "timeout" : cause || status,
        statusDetail: cause === "max-turns" ? "max-turns" : null,
        stopCause: cause,
        stopRequestedAt: state.stop?.requestedAt ?? null,
        cost: state.cost, tokens: state.tokens, sessionFile: state.sessionFile,
        summary: state.lastText.slice(0, 500), error: error ?? state.llmError,
      });
    };

    const beginAbort = () => {
      if (abortStarted) return;
      abortStarted = true;
      send({ type: "abort" });
      graceTimer = setTimeout(() => finish("failed", `abort grace expired after ${abortGraceMs}ms`), abortGraceMs);
    };

    const markerCandidate = () => {
      const marker = (hooks.readCancel || readCancelMarker)(task.id);
      return marker?.requestedAt ? { cause: "canceled", requestedAt: marker.requestedAt } : null;
    };

    const reportUsage = () => {
      try { hooks.onUsage?.({ cost: state.cost, tokens: state.tokens, sessionFile: state.sessionFile }); }
      catch (error) { log?.(`could not persist usage: ${error}`); }
    };

    const requestStop = (candidate) => {
      const winner = selectStopCandidate(state.stop, markerCandidate(), candidate);
      if (!winner) return false;
      const changed = winner.cause !== state.stop?.cause || winner.requestedAt !== state.stop?.requestedAt;
      if (changed) {
        try { hooks.onStopRequested?.(winner.cause, winner.requestedAt); }
        catch (error) { log?.(`could not persist stop request: ${error}`); return false; }
        log?.(`stop requested: ${winner.cause} at ${winner.requestedAt}`);
      }
      state.stop = winner;
      beginAbort();
      return true;
    };

    const timeoutAt = new Date(startedMs + timeoutMs).toISOString();
    const timeoutTimer = setTimeout(() => requestStop({ cause: "timeout", requestedAt: timeoutAt }), timeoutMs);
    const statsTimer = setInterval(() => send({ type: "get_session_stats" }), statsPollMs);
    const cancelTimer = setInterval(() => {
      const marker = markerCandidate();
      if (marker) requestStop(marker);
    }, cancelPollMs);

    const checkBudget = (at = new Date().toISOString()) => {
      if (typeof task.budgetUsd === "number" && state.cost > task.budgetUsd) {
        log?.(`budget cap hit: $${state.cost.toFixed(4)} > $${task.budgetUsd}`);
        requestStop({ cause: "overbudget", requestedAt: at });
      }
    };

    const dispatch = (event) => {
      if (event.type === "response" && event.command === "get_session_stats" && event.success) {
        const data = event.data ?? {};
        if (config.costSource !== "events" && typeof data.cost === "number") state.cost = data.cost;
        if (data.tokens) state.tokens = data.tokens;
        if (data.sessionFile) state.sessionFile = data.sessionFile;
        reportUsage();
        checkBudget();
      } else if (event.type === "turn_end") {
        state.turns += 1;
        send({ type: "get_session_stats" });
        if (state.turns >= maxTurns) requestStop({ cause: "max-turns", requestedAt: new Date().toISOString() });
      } else if (event.type === "message_end") {
        const message = event.message;
        if (message?.role === "assistant") {
          if (message.stopReason) {
            state.stopReason = message.stopReason;
            state.llmError = message.errorMessage ?? null;
          }
          if (Array.isArray(message.content)) {
            const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
            if (text) state.lastText = text;
          }
          if (config.costSource === "events" && typeof message.usage?.cost?.total === "number") {
            state.cost += message.usage.cost.total;
            reportUsage();
            checkBudget();
          }
        }
      } else if (event.type === "agent_settled") {
        state.settled = true;
        send({ type: "get_session_stats" });
        setTimeout(finishSettled, finalStatsMs);
      }
    };

    const finishSettled = () => {
      if (state.stop) return finish(state.stop.cause);
      if (state.stopReason === "error") return finish("failed", state.llmError || "model returned an error");
      finish("done");
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (process.env.PI_JOBS_DEBUG) {
          try { appendFileSync(join(DATA_DIR, "logs", `rpc-${task.id}.jsonl`), line + "\n"); } catch {}
        }
        try { dispatch(JSON.parse(line)); } catch {}
      }
    });
    child.stderr.on("data", (chunk) => { state.stderrTail = (state.stderrTail + chunk.toString("utf8")).slice(-2_000); });
    child.on("error", (error) => finish("failed", `spawn failed: ${error}`));
    child.on("exit", (code) => {
      if (done) return;
      if (state.settled) return finishSettled();
      if (state.stop) return finish(state.stop.cause);
      finish("failed", `pi exited early (code ${code}). stderr: ${state.stderrTail}`);
    });

    const marker = markerCandidate();
    if (marker) requestStop(marker);
    else send({ type: "prompt", message: task.prompt });
  });
}

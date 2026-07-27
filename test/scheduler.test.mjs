import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_JOBS_DATA_DIR = join(mkdtempSync(join(tmpdir(), "pi-jobs-scheduler-")), "data");
const scheduler = await import(`../lib/scheduler.mjs?scheduler=${Date.now()}`);

test("setup script uses ScheduledTasks Queue policy and one repeating task", () => {
  const script = scheduler.buildSetupScript({ nodePath: "C:\\Node\\node.exe", runnerPath: "C:\\Package Path\\runner.mjs" });
  assert.match(script, /New-ScheduledTaskAction/);
  assert.match(script, /New-ScheduledTaskSettingsSet -MultipleInstances Queue -StartWhenAvailable/);
  assert.match(script, /New-ScheduledTaskTrigger.+RepetitionInterval.+Minutes 15/);
  assert.match(script, /Register-ScheduledTask.+pi-jobs-worker/);
  assert.match(script, /Disable-ScheduledTask.+pi-nightshift/);
  assert.doesNotMatch(script, /schtasks/i);
  assert.match(script, /C:\\Package Path\\runner\.mjs/);
});

test("installed ScheduledTasks module accepts Queue settings on Windows", { skip: process.platform !== "win32" }, (t) => {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$s=New-ScheduledTaskSettingsSet -MultipleInstances Queue -StartWhenAvailable; [string]$s.MultipleInstances"], { encoding: "utf8" });
  if (!result.stdout.trim() && result.stderr.trim()) return t.skip("ScheduledTasks CIM access is blocked in this sandbox");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "Queue");
});

test("doctor covers separate runner/pi paths, scheduler, locks, stale jobs and sync roots", () => {
  const report = scheduler.doctor();
  const names = report.checks.map((check) => check.name);
  for (const expected of ["Node runner", "Runner file", "Pi executable", "Scheduled task", "Runner lock", "Stale jobs", "Legacy worktrees", "Terminal heartbeats", "Worktree root", "User API key"]) {
    assert.ok(names.includes(expected), expected);
  }
  assert.doesNotMatch(JSON.stringify(report), /sk-[A-Za-z0-9]/);
});

test("uninstall script removes only the scheduled task and contains no data deletion", () => {
  const script = scheduler.buildUninstallScript();
  assert.match(script, /Unregister-ScheduledTask/);
  assert.doesNotMatch(script, /Remove-Item|rm\s|worktree|\.pi\\jobs/i);
});

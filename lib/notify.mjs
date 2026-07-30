import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, writeFileSync } from "node:fs";

// Send a short Windows toast using the native Windows Runtime toast APIs.
// On non-Windows hosts, or when the runtime is unavailable, this returns
// { ok: false, error } so callers can downgrade to a Pi warning rather than
// failing the whole command.
//
// AppId defaults to the always-registered Microsoft.Windows.Explorer AUMID so
// we never have to install a Start-menu shortcut just to surface a one-line
// digest summary.
const DEFAULT_APP_ID = "Microsoft.Windows.Explorer";

export function buildToastScript() {
  return [
    "$ErrorActionPreference='Stop'",
    "try { [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null } catch { throw 'Windows.UI.Notifications unavailable' }",
    "$template=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$nodes=$template.GetElementsByTagName('text')",
    "$null=$nodes.Item(0).AppendChild($template.CreateTextNode(([string]$args[0]).Substring(0, [Math]::Min(128, ([string]$args[0]).Length))))",
    "$null=$nodes.Item(1).AppendChild($template.CreateTextNode(([string]$args[1]).Substring(0, [Math]::Min(512, ([string]$args[1]).Length))))",
    "$toast=[Windows.UI.Notifications.ToastNotification]::new($template)",
    "$toast.ExpirationTime=[DateTimeOffset]::Now.AddSeconds(10)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier([string]$args[2]).Show($toast)",
  ].join("; ");
}

export function sendWindowsToast(
  { title, body, appId = DEFAULT_APP_ID } = {},
  {
    platform = process.platform,
    tempDir = tmpdir(),
    execFile = execFileSync,
    writeFile = writeFileSync,
    unlinkFile = unlinkSync,
    nonce = randomBytes(4).toString("hex"),
  } = {},
) {
  if (!title || !body) return { ok: false, error: "title and body are required" };
  if (platform !== "win32") return { ok: false, error: "non-windows host" };
  const scriptPath = join(tempDir, `pi-jobs-toast-${process.pid}-${nonce}.ps1`);
  try {
    writeFile(scriptPath, buildToastScript(), "utf8");
    execFile("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
      String(title), String(body), String(appId),
    ], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 10_000,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.stderr?.toString?.().trim() || error?.message || `${error}` };
  } finally {
    try { unlinkFile(scriptPath); } catch {}
  }
}

export const NOTIFY_APP_ID = DEFAULT_APP_ID;

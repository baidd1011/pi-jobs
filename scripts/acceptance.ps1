param(
  [string]$PackageSource = (Split-Path -Parent $PSScriptRoot),
  [switch]$SkipScheduler
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'pi-jobs acceptance is Windows-only' }

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pi-jobs-acceptance-' + [guid]::NewGuid().ToString('N'))
$agentDir = Join-Path $testRoot 'agent'
$dataDir = Join-Path $testRoot 'jobs'
$legacyDir = Join-Path $testRoot 'missing-legacy'
$taskName = 'pi-jobs-acceptance-' + $PID
$legacyTaskName = 'pi-jobs-legacy-acceptance-' + $PID

New-Item -ItemType Directory -Path $agentDir -Force | Out-Null
$env:PI_CODING_AGENT_DIR = $agentDir
$env:PI_JOBS_DATA_DIR = $dataDir
$env:PI_JOBS_LEGACY_DIR = $legacyDir
$env:PI_JOBS_TASK_NAME = $taskName
$env:PI_JOBS_LEGACY_TASK_NAME = $legacyTaskName

try {
  pi install $PackageSource
  if ($LASTEXITCODE -ne 0) { throw "pi install failed: $PackageSource" }

  $rpcOutput = '{"type":"get_commands"}' | pi --mode rpc --no-session --no-context-files
  if ($LASTEXITCODE -ne 0) { throw 'Pi RPC command discovery failed' }
  $responseLine = $rpcOutput | Where-Object { $_ -match '^\{"type":"response"' } | Select-Object -First 1
  if (-not $responseLine) { throw 'Pi RPC did not return get_commands' }
  $commands = ($responseLine | ConvertFrom-Json).data.commands
  $jobCommand = $commands | Where-Object { $_.name -eq 'job' -and $_.source -eq 'extension' } | Select-Object -First 1
  $nsCommand = $commands | Where-Object { $_.name -eq 'ns' -and $_.source -eq 'extension' } | Select-Object -First 1
  if (-not $jobCommand -or -not $nsCommand) { throw '/job or /ns was not registered' }

  $packageRoot = Split-Path -Parent (Split-Path -Parent $jobCommand.sourceInfo.path)
  $manifest = Get-Content -Raw (Join-Path $packageRoot 'package.json') | ConvertFrom-Json
  if (-not $manifest.peerDependenciesMeta.'@earendil-works/pi-coding-agent'.optional) {
    throw 'Pi peer dependency is not optional'
  }
  if (Test-Path (Join-Path $packageRoot 'node_modules\@earendil-works\pi-coding-agent')) {
    throw 'Git package duplicated the Pi host dependency'
  }

  $runtimeScript = Join-Path $packageRoot 'scripts\acceptance-runtime.mjs'
  $runtimeArgs = @($runtimeScript, $packageRoot, $testRoot)
  if (-not $SkipScheduler) { $runtimeArgs += '--scheduler' }
  & node @runtimeArgs
  if ($LASTEXITCODE -ne 0) { throw 'acceptance runtime failed' }

  Write-Output "pi-jobs acceptance passed: $PackageSource"
}
finally {
  try {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
  } catch {}
  try { pi remove $PackageSource | Out-Null } catch {}

  $resolved = [IO.Path]::GetFullPath($testRoot)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
      -not (Split-Path -Leaf $resolved).StartsWith('pi-jobs-acceptance-')) {
    throw "unsafe acceptance cleanup target: $resolved"
  }
  if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}

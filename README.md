# pi-jobs

简体中文 | [English](./README.en.md)

[![CI](https://github.com/baidd1011/pi-jobs/actions/workflows/ci.yml/badge.svg)](https://github.com/baidd1011/pi-jobs/actions/workflows/ci.yml)

`pi-jobs` 是为 Pi coding agent 提供的 Windows 优先、可审计后台任务队列。你可以在 Pi 会话中提交任务后离开终端，worker 会在隔离的 Git worktree 中继续执行，并默认以本地结果分支交付；显式配置后也可创建 GitHub Draft PR。状态、成本、日志、执行策略和追加式审计事件都会持久记录。

队列仍严格串行，不唤醒睡眠中的计算机、不自动重试模型调用，也不支持 Windows 以外的调度器。PR 交付是可选能力，默认不会安装、调用或要求登录 `gh`。

## 安装

从固定版本标签安装：

```powershell
pi install git:github.com/baidd1011/pi-jobs@v1.3.0
```

如果此前手动注册过 `extension/nightshift.ts` 或 `extension/jobs.ts`，请先在 `pi config` 中禁用旧入口，避免命令重复注册。

安装后进入 Pi，执行：

```text
/reload
/job setup
/job doctor
```

使用 `pi list` 可以查看 Git 包的实际安装位置。

查看当前运行版本及计划任务是否仍指向当前安装包：

```text
/job version
```

### 升级

Git tag 属于固定版本，不会被普通 `pi update` 自动移动。升级时安装新的 tag，然后刷新计划任务中的 runner 路径：

```powershell
pi install git:github.com/baidd1011/pi-jobs@vX.Y.Z
```

```text
/reload
/job version
/job setup
/job doctor
```

### 卸载

必须先删除计划任务，再移除 Git 包；数据、日志、结果分支和遗留 worktree 都会保留：

```text
/job uninstall
```

```powershell
pi remove git:github.com/baidd1011/pi-jobs
```

## 执行模型

1. `/job add` 固定当前仓库已提交的 `HEAD`，并原子写入 queued 任务。主工作区可以是 dirty，但未提交修改绝不会复制进任务。
2. 命令写入 wake 请求，并调用 `Start-ScheduledTask pi-jobs-worker`。
3. 单个 worker 按 `queuePriority DESC, createdAt ASC, id ASC` 认领任务。每个任务在 `~/.pi/jobs/worktrees/<id>` 下运行，并使用 `pi-jobs-<id>` 分支；用户的主工作树不会被 checkout 或 reset。
4. worker 将归一化后的工具、离线和 max-turns 策略显式传给 Pi，同时记录成本、token、日志、实际策略和状态转换；heartbeat 每 30 秒单独写入。
5. 有变更的分支保留为 `branch-ready`；无变更的分支会被删除并记录为 `no-changes`。只有成功且有提交的 PR 任务才会非强制 push 并创建 Draft PR；任何外部交付失败都保留本地分支。

队列为空时，worker 每秒重扫一次，连续 5 次为空才退出。计划任务使用 `MultipleInstancesPolicy=Queue`，关闭 add 与退出之间的竞态。同一计划任务还有一个每 15 分钟触发的 watchdog。

## 命令

| 命令 | 作用 |
|---|---|
| `/job add <prompt> [--budget N] [--timeout MIN] [--max-turns N] [--tools read,edit,...] [--no-network] [--delivery branch\|pr]` | 固定已提交的 HEAD、记录策略、入队并请求启动 worker；默认本地分支交付 |
| `/job list [--all]` | 查看活动任务或全部历史 |
| `/job status <id>` | 查看状态、阶段、成本、停止原因、base 和交付信息 |
| `/job log <id>` | 查看任务日志 |
| `/job result <id>` | 查看结果分支、摘要和 review 命令 |
| `/job cancel <id>` | queued 时立即取消，running 时通知 RPC 进程停止 |
| `/job retry <id>` | 创建新任务，并重新固定仓库当前已提交的 HEAD |
| `/job setup-pr --remote <name> [--base <branch>]` | 为当前仓库验证并保存 GitHub PR 交付配置 |
| `/job pause` / `/job resume` | 软暂停后续认领，或解除暂停并唤醒 worker；当前任务会继续完成 |
| `/job prioritize <id>` | 将一个 queued 任务移到队首，并写入任务审计事件 |
| `/job digest [--hours N] [--markdown] [--notify]` | 汇总最近 N 小时（默认 24h）完成的任务，附 review 命令；额外列出全部尚未解决的 cleanup-needed；可写 Markdown 或发 Windows Toast |
| `/job audit <id>` | 在 Pi 中展示完整审计报告，并默认写入 `~/.pi/jobs/reports/audits/<id>-r<revision>.md` |
| `/job cleanup [--dry-run]` | 安全清理终态 heartbeat、cancel marker、合格临时文件和 clean/commit 匹配的 worktree；其余只列出原因和建议命令 |
| `/job setup` | 幂等注册或更新 `pi-jobs-worker` |
| `/job doctor` | 检查运行环境、provider key、调度器、锁、stale 任务和 worktree；不再顺手清理终态 heartbeat |
| `/job version` | 显示包版本，并检查计划任务 runner 路径是否过期 |
| `/job uninstall` | 只删除计划任务，保留全部数据和 Git 产物 |

`/ns` 在一个大版本内保留为弃用兼容别名。`/ns rm` 映射为 cancel，`/ns digest` 映射为新的 digest 命令；每次使用都会显示弃用提示。

cleanup 的临时文件扫描仅限数据根目录及 `jobs/control/heartbeats/locks`，不会进入 `worktrees/logs/reports`。真正删除前会重新检查任务状态、文件指纹、worktree cleanliness 和结果 commit；`--dry-run` 会逐项显示 `would-remove`，任何未知参数都会被拒绝。

### PR 交付

PR 交付只支持 GitHub Draft PR，并且必须显式安装并登录 GitHub CLI。先在目标仓库内配置：

```text
/job setup-pr --remote origin --base main
```

配置会按规范化仓库路径保存 remote、脱敏 URL、GitHub host、`owner/repo`、base、`gh` 绝对路径和确认账号。随后每个 PR 任务仍需单独确认：

```text
/job add 修复登录错误并补测试 --delivery pr
```

提交和 push 前都会复查 remote URL、账号、push 权限及远端 base。提交时本地 committed HEAD 必须与远端 base HEAD 完全一致；结果分支使用非强制 push。失败、取消、超预算、超时、无变更或外部交付失败都不会丢失本地成果，也不会发布部分成果。配置和任务记录绝不保存 token。

### 任务策略

默认工具固定为 `read,bash,edit,write`。`--tools` 只接受 `read,bash,edit,write,grep,find,ls`，`--max-turns` 范围为 1–1000。`--no-network` 禁止 agent 工具主动联网，因此不能与 `bash` 同时使用；它不隔离模型 API，也不限制 runner 自己执行已确认的 GitHub 交付。例如：

```text
/job add 只读检查配置 --tools read,grep,find,ls --no-network --max-turns 20
```

## 设置

要求：

- Windows、Node.js 22.19.0 或更高版本、支持 worktree 的 Git，以及 Pi。
- 仅使用 `--delivery pr` 时需要 GitHub CLI (`gh`) 和可 push 的 GitHub 仓库权限。
- provider API key 必须保存为 **Windows 用户级环境变量**；计划任务无法继承只在 `.bashrc` 中 export 的 key。
- 计算机必须保持唤醒，用户会话必须保持登录；锁屏不影响运行。

在 Pi 中运行：

```text
/job setup
/job doctor
```

setup 使用 Windows ScheduledTasks PowerShell 模块，而不是 `schtasks /Create`，并注册：

- action executable：当前 `process.execPath`；
- action argument：当前安装包内的 `runner/run.mjs`；
- settings：`MultipleInstances Queue` 和 `StartWhenAvailable`；
- `pi-jobs-worker` 上一个每 15 分钟重复的 trigger；
- 当前用户的 interactive principal，因此不保存密码。

如果旧的 `pi-nightshift` 计划任务存在，setup 会禁用它；旧任务不存在不算错误。

诊断时如需手动运行 worker，可先通过 `pi list` 找到包目录，再执行：

```powershell
node "<pi-jobs-package-dir>\runner\run.mjs"
```

## 数据与权威来源

新状态保存在 `~/.pi/jobs/`：

```text
config.json              运行默认值和独立的 piPath
queue-state.json         权威全局暂停状态
queue-events.jsonl       派生队列审计事件
jobs/<id>.json           唯一权威任务记录
events.jsonl             按 jobId + revision 标识的派生审计事件
control/<id>.cancel.json 取消信号
heartbeats/<id>.json     轻量 worker 存活信息（不增加 revision/event）
logs/<id>.log            每任务日志
worktrees/<id>/          隔离的临时 Git worktree
reports/digests/         /job digest 写出的 Markdown 报告
reports/audits/          /job audit 写出的 Markdown 报告
runner.lock              PID + 进程启动时间 + token 所有权锁
```

任务状态包括 `queued`、`running`、`done`、`failed`、`overbudget`、`timeout` 和 `canceled`。运行阶段包括 `preparing`、`agent`、`finalizing` 和 `delivering`。交付类型为 `branch` 或 `pr`；状态还包括 `push-pending`、`pushed` 和 `pr-ready`。

新任务使用 schema v4：记录请求策略、实际运行策略、队列优先级，以及可选的 PR 配置与确认快照；进入 agent 阶段时一次性持久化 runtime。旧 v1–v3 任务不批量改写，缺失字段显示为 `unknown / not recorded`，绝不根据当前环境伪造历史值。

运行时决策不会读取 `events.jsonl`。任务记录先写入，审计事件随后追加；启动时会补写缺失 revision 的事件。heartbeat 每 30 秒单独写入，超过 5 分钟视为 stale。`/job doctor` 只报告终态 heartbeat 数量并提示运行 `/job cleanup`，不再顺手删除。

## 停止与恢复

取消信号每秒检查一次。成本通过 `get_session_stats` 每 15 秒及每个 turn 边界检查，因此预算是软上限，可能超出一次已经计费的调用。停止原因会在执行 `abort` 前持久化；宽限期后仍未退出则强制终止进程树。

时间戳更早的停止原因优先；时间戳相同时使用：

```text
canceled > overbudget > timeout > max-turns
```

`max-turns` 保存为 `state=timeout` 和 `statusDetail=max-turns`，避免与墙钟超时混淆。

stale running 任务绝不会再次发送给模型。恢复流程会提交 worktree 中已有内容，保留已持久化的取消、预算或超时原因；没有停止原因时记录为 `failed / worker-crashed`。只有 `/job retry` 会产生新的模型调用和潜在费用。

## 旧数据迁移

`~/.pi/nightshift` 始终只读。迁移是幂等的，导入 ID 记录在新数据目录中。已完成结果会成为不可变的 `legacy-nightshift` 记录。旧 pending 任务若没有保存 base，则使用迁移时观察到的 committed HEAD，并显示 `migrationBaseApproximate=true`。旧 running 任务会导入为 failed，绝不会自动恢复执行。

## 测试

```powershell
npm test
```

测试套件使用临时仓库、隔离数据目录和假的 Pi JSONL RPC 进程，不会调用真实 provider，也不会修改 `~/.pi/nightshift`。

完整的干净机验收还会验证 Pi 包加载、命令注册、假 RPC 分支交付，以及使用唯一临时任务名进行 scheduler setup/doctor/uninstall：

```powershell
npm run test:acceptance
```

GitHub Actions 会在 Node.js 22.19.0 和 24.x 上运行单元测试，并单独执行分发验收。版本变化记录在 [CHANGELOG.md](./CHANGELOG.md)。

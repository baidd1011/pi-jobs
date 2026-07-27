# pi-jobs

简体中文 | [English](./README.en.md)

`pi-jobs` 是为 Pi coding agent 提供的 Windows 优先、可审计后台任务队列。你可以在 Pi 会话中提交任务后离开终端，worker 会在隔离的 Git worktree 中继续执行，并以本地结果分支交付，同时持久记录状态、成本、日志和追加式审计事件。

首个版本刻意保持串行和本地化：不创建或推送 PR、不并行执行任务、不唤醒睡眠中的计算机、不自动重试模型调用，也不支持 Windows 以外的调度器。

## 安装

从固定版本标签安装：

```powershell
pi install git:github.com/baidd1011/pi-jobs@v1.0.0
```

如果此前手动注册过 `extension/nightshift.ts` 或 `extension/jobs.ts`，请先在 `pi config` 中禁用旧入口，避免命令重复注册。

安装后进入 Pi，执行：

```text
/reload
/job setup
/job doctor
```

使用 `pi list` 可以查看 Git 包的实际安装位置。

## 执行模型

1. `/job add` 固定当前仓库已提交的 `HEAD`，并原子写入 queued 任务。主工作区可以是 dirty，但未提交修改绝不会复制进任务。
2. 命令写入 wake 请求，并调用 `Start-ScheduledTask pi-jobs-worker`。
3. 单个 worker 按创建顺序认领任务。每个任务在 `~/.pi/jobs/worktrees/<id>` 下运行，并使用 `pi-jobs-<id>` 分支；用户的主工作树不会被 checkout 或 reset。
4. worker 记录成本、token、日志和状态转换，并单独每 30 秒写一次 heartbeat。无论成功、失败、取消、超预算或超时，都会尝试提交已有成果。
5. 有变更的分支保留为 `branch-ready`；无变更的分支会被删除并记录为 `no-changes`；若 Windows 无法释放 worktree，则保留现场并记录为 `failed / cleanup-needed`。

队列为空时，worker 每秒重扫一次，连续 5 次为空才退出。计划任务使用 `MultipleInstancesPolicy=Queue`，关闭 add 与退出之间的竞态。同一计划任务还有一个每 15 分钟触发的 watchdog。

## 命令

| 命令 | 作用 |
|---|---|
| `/job add <prompt> [--budget N] [--timeout MIN]` | 固定已提交的 HEAD、入队并请求启动 worker |
| `/job list [--all]` | 查看活动任务或全部历史 |
| `/job status <id>` | 查看状态、阶段、成本、停止原因、base 和交付信息 |
| `/job log <id>` | 查看任务日志 |
| `/job result <id>` | 查看结果分支、摘要和 review 命令 |
| `/job cancel <id>` | queued 时立即取消，running 时通知 RPC 进程停止 |
| `/job retry <id>` | 创建新任务，并重新固定仓库当前已提交的 HEAD |
| `/job setup` | 幂等注册或更新 `pi-jobs-worker` |
| `/job doctor` | 检查运行环境、provider key、调度器、锁、stale 任务和 worktree |
| `/job uninstall` | 只删除计划任务，保留全部数据和 Git 产物 |

`/ns` 在一个大版本内保留为弃用兼容别名。`/ns rm` 映射为 cancel，`/ns digest` 映射为活动队列摘要；每次使用都会显示弃用提示。

## 设置

要求：

- Windows，已安装 Node.js、支持 worktree 的 Git，以及 Pi。
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
jobs/<id>.json           唯一权威任务记录
events.jsonl             按 jobId + revision 标识的派生审计事件
control/<id>.cancel.json 取消信号
heartbeats/<id>.json     轻量 worker 存活信息（不增加 revision/event）
logs/<id>.log            每任务日志
worktrees/<id>/          隔离的临时 Git worktree
runner.lock              PID + 进程启动时间 + token 所有权锁
```

任务状态包括 `queued`、`running`、`done`、`failed`、`overbudget`、`timeout` 和 `canceled`。运行阶段包括 `preparing`、`agent` 和 `finalizing`。交付始终是本地分支，状态为 `not-started`、`pending`、`branch-ready`、`no-changes` 或 `failed`。

运行时决策不会读取 `events.jsonl`。任务记录先写入，审计事件随后追加；启动时会补写缺失 revision 的事件。heartbeat 每 30 秒单独写入，超过 5 分钟视为 stale。

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

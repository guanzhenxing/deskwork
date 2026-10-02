# 启动恢复分类协议

```json
{ "name": "startup-recovery", "major": 1, "minor": 1 }
```

- 状态：已实现（`packages/shell-core/src/failure-policy.ts`、`packages/shell-core/src/recovery-controller.ts`、`packages/host-supervisor` 阶段化 boot）

## 1. 分类模型

启动失败在**捕获位置**结构化为 `StartupFailure = { stage, code, category, summary, retryable }`；归因不足的一律 `unknown`，绝不从错误消息包含的词推断责任插件。

Host 侧命名阶段（host-runner，随 fatal 信封透传，不压平为 BOOT_FAILED）：

| stage             | code                      | category            | retryable |
| ----------------- | ------------------------- | ------------------- | --------- |
| `resolve-runtime` | `RUNTIME_UNAVAILABLE`     | runtime             | true      |
| `resolve-profile` | `PROFILE_INVALID`         | profile-composition | false     |
| `load-home-patch` | `HOME_PATCH_INVALID`      | home-config         | false     |
| `boot`            | `BOOT_FAILED`（未识别码） | unknown             | true      |
| `boot`            | `MISSING_CREDENTIAL`¹     | credentials         | false     |
| `boot`            | `PORT_IN_USE`¹            | network             | false     |
| `publish-surface` | `SURFACE_MISSING`         | renderer            | false     |
| `host-control`    | Host-control 错误码       | runtime             | false     |

launcher 侧阶段（shell-core / desktop-recovery）：

| stage                  | code                      | category              | 说明                                           |
| ---------------------- | ------------------------- | --------------------- | ---------------------------------------------- |
| `reconcile-profile`    | `RECONCILE_FAILED`        | profile-write         | 事务 apply 阶段失败（`ProfileReconcileError`） |
| `resolve-profile`      | `PROFILE_INVALID`         | profile-composition   | reconcile plan 阶段失败（用户内容不可解析）    |
| `recover-transactions` | `RECOVERY_CONFLICT` 等    | unknown（有意不映射） | 中断事务结算失败，永不作为自动回滚依据         |
| `cache-quarantine`     | `CACHE_QUARANTINE_FAILED` | runtime               | cache 隔离机制自身失败                         |

`HOME_BUSY`（home lock 被占）不进恢复窗口：孤儿 Host 判定失败保持启动生命周期行为（对话框 + 退出 1）。

¹ 当前上游基线的 boot 阶段错误统一以 `BOOT_FAILED` 到达，尚不携带结构化的 `MISSING_CREDENTIAL`/`PORT_IN_USE` 码；这两行映射在上游 fatal 信封携带这些 code 时生效，当前这类失败分类为 unknown（绝不从消息文本猜测）。native-ui 阶段同样为接口预留。

## 2. 摘要脱敏

`toStartupFailure` 对 summary 做：home 路径替换为占位提示、token/api-key/password/Bearer 形态打码（含引号形态）、控制字符替换为空格、长度上限 1024、空结果回退为 `<stage> failed (<code>)`。credentials 类附"通过官方 DSH 设置配置凭据，桌面不创建或复制凭据"指引。

## 3. 自动回滚资格与会话恢复语义

`shouldRollbackProfile(failure, changed, healthy)` 仅当三者同时成立：

1. 本次启动从未 healthy；
2. 本次 reconcile 确实修改了 profile（或采纳了一个仍处 applied 的未归因事务）；
3. 失败 category ∈ { profile-write, profile-composition }。

其余一切失败（home 所有权、home-config、credentials、network、runtime、renderer、unknown）保持用户数据原样，pending 事务以 `retained` 终态记录失败类别后进入恢复窗口，由用户选择重试、Safe Mode 或退出。

会话语义（`RecoverySessionController`）：

- **外层 lease 全程持有**：恢复窗口存活期间会话不释放 lease——手动重试与 Safe Mode 复用同一 lease；lease 仅在 quit 链（stop Host → 确认退出 → release）释放。release 自身失败时故意保留 lease 并在日志中说明（完全退出后需人工按 owner 身份处理锁残留）。
- **正常链**：`孤儿 Host 判定 → home session → 恢复未完成 journal → cache 检查 → reconcile plan → 持久 journal → apply → Host ready → 窗口挂载 → committed`。committed 仅在 surface 挂载后写入。
- **失败链**：stop Host 并确认退出 → 分类 → 可归因且 SHA 匹配时回滚 → **最多一次自动正常重启**（relaunch-once）→ 恢复窗口。自动重启预算是 **home 级**：marker（`<userData>/recovery/<home 摘要>.json`，`schemaVersion: 1`）一旦写入即视为已消耗，新事务 id 不能重置；健康会话清除 marker，未知格式的 marker 视为已消耗且永不覆写或删除。
- **重试预算**：滚动 60 秒窗口内手动重试至多 3 次，且失败必须 `retryable`；非重试失败（如 PROFILE_INVALID）不提供手动重试。post-ready 崩溃不自动重启。
- **Safe Mode**：仅用户在恢复窗口显式选择；先准备 safe profile，然后以 `mode: 'safe'` 创建新 attempt，与正常 attempt 组合互斥。退出 Safe Mode 不自动修改正常 profile。
- **恢复事务结算**：`recover-transactions` 阶段的失败（conflict / needs-review）有意映射为 `unknown` 且不可重试——它们是需人工介入的诊断态：恢复窗口的摘要指向 `<home>/run/profile-transactions`（journal 记录分歧详情）并禁用重试。锁残留只可能来自仍在运行的 Host；恢复窗口存活期间本进程即写入者，视图因此不提供解锁命令。

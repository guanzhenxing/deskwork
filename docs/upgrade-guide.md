# 升级与回退指南

- 适用对象：Deskwork 的手动升级与回退（当前版本无自动更新器）
- 相关文档：[upstream-baseline](upstream-baseline.md)、[home-compatibility 协议](protocols/home-compatibility.md)

## 1. 手动升级流程

1. **完全退出旧版**：托盘菜单退出，或 Dock 右键退出；确认退出完成（Host 进程结束、home lock 释放）再继续。
2. **核对制品与兼容性**：确认新 DMG 的 SHA-256 与 `release/artifacts.json` 记录一致（`shasum -a 256`）；查看 DMG 内嵌的 `Contents/Resources/compatibility.json`（schema 2）中的 `dataEpoch` 与 `dsh` 基线。
3. **（可选但推荐）备份 home**：`cp -R ~/.deskwork ~/.deskwork.backup-<日期>`。升级不修改 credentials/settings/会话，但备份是唯一可靠的回退保险。
4. **替换应用**：把新 `.app` 拖入 `/Applications`（或你的安装目录）覆盖旧版。
5. **启动验证**：启动后确认能读到历史会话；新建一条会话确认可写；退出并再次启动确认可恢复。
6. **保留旧 DMG**：上一版 DMG 是二进制回退候选，不要删除。

## 2. 兼容性保护如何工作

- 每个受支持入口（Desktop、Safe Mode）在写入 home 之前执行最小准入：读取兼容性 marker → 校验 schemaVersion 与 dataEpoch → 写入预约（`<home>/run/compatibility.json`）。
- 新版本能在旧数据上启动（epoch 在支持范围内）；**旧版本拒绝打开新版本写过的高 epoch 数据**（恢复页明确提示，不产生任何写入）。
- 损坏或未知 schema 的 marker 一律拒绝：数据保持原状，等待能处理它的版本。
- 升级不升级、不卸载、不重写用户第三方插件与 home settings；这两类内容完全留给你。

## 3. 拒绝降级时怎么办

如果旧版启动后提示“由更高数据版本写入”（`HOME_DATA_UNSUPPORTED`）：

1. **不要**删除 marker、不要手工改 `~/.deskwork/run/compatibility.json`；
2. 装回能读该数据的版本（写入它的那个版本）继续使用；
3. 只有在确认放弃数据、或已有经过验证的备份时，才考虑从零初始化。

## 4. 什么情况不能升级

- 制品 SHA 与记录不符 → 重新下载/重建，不要强行安装；
- 清单声明 `MIGRATION_REQUIRED` 场景 → 该版本不自动迁移，等迁移版本（需要单独的迁移设计）。

## 5. 升级执行流程（面向维护者）

上游出现新 tag 时，真实升级在独立候选分支 `chore/upgrade-dsh-<实际标签>` 上执行，与功能分支严格隔离。

### 5.1 升级风险面

生产代码对上游的依赖集中在少数几个文件；升级时先读它们，就能判断这次是否会被上游 API 变动波及。

| 文件                                          | 触及的上游                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/host-supervisor/src/host-runner.ts` | `@deepseek-ai/dsh-app-boot` 的 `boot`、`loadProfile`、`createRuntimeResolution`、`loadOptionalPatches`、`PluginPackages`，以及 `dsh-cmdline`、`dsh-launch-environment` |
| `packages/desktop-plugin/src/index.ts`        | cordis 的 `Context` 类型与服务名 `connection`、`webServer`                                                                                                             |
| `packages/desktop-recovery-bridge/src/`       | 同上                                                                                                                                                                   |

历史上破坏性较强的上游变动（模块解析物化方式的替换、自动化任务移入可选插件包）都落在第一个文件上。

### 5.2 版本声明的位置

上游版本只有**一个事实源**：`build/upstream-artifacts.json` 的 `dsh.npmVersion`（由 `verify:dsh-closure` 对账）。它被投影到三处，全部由 `pnpm upgrade:dsh-pins` 生成：

1. `pnpm-workspace.yaml` 的 `overrides['@deepseek-ai/dsh*']`；
2. `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`：逐个 DSH 包的条目（当前 284 条）。这份列表存在的原因是上游 rc 发布过新、会触发 pnpm 的 minimumReleaseAge 策略；它**不是排序集合**，而是历史批次的拼接，脚本按原顺序改写、只追加新解析出的包名；
3. 各 `packages/*`、`apps/*` 清单里对 `@deepseek-ai/dsh*` 的依赖声明。

`@deepseek-ai/cordis` 是独立版本轴（见 `build/upstream-artifacts.json` 的 `independentPackages`），脚本永不改动。

`pnpm check` 已包含 `check:dsh-pins`：任何一处漏改都会让 CI 红。

### 5.3 升级 runbook

| #   | 动作               | 说明                                                                                                          |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------- |
| 0   | 判断是否值得升     | 由新 tag、影响本项目的缺陷或安全问题、真实使用需求触发，不按日历                                              |
| 1   | 开候选分支         | `chore/upgrade-dsh-<实际标签>`                                                                                |
| 2   | 更新基线账本       | `build/upstream-artifacts.json` 的 `tag`、`commit`、`npmVersion` 与逐包 integrity                             |
| 3   | 同步版本声明       | `pnpm upgrade:dsh-pins`                                                                                       |
| 4   | 重解依赖           | `pnpm install`                                                                                                |
| 5   | 重新生成兼容性清单 | `pnpm generate:compatibility`                                                                                 |
| 6   | 跑门禁             | `pnpm verify:dsh-closure`、`pnpm verify:patches`、`pnpm verify:runtime-tree`、`pnpm check`                    |
| 7   | 集成测试           | `pnpm test:integration`                                                                                       |
| 8   | **无头启动冒烟**   | `pnpm smoke:headless`——核心信号：profile 能否在纯 Node 中启动并服务官方 UI                                    |
| 9   | 桌面冒烟           | `pnpm smoke:dsh-ui`、`host-crash`、`profile-recovery`、`safe-mode`、`lifecycle`                               |
| 10  | 打包验收           | `pnpm package:dir` 与 `pnpm smoke:package`                                                                    |
| 11  | 数据格式决策       | 仅当上游改动会话或设置的磁盘格式时，才决定是否升 `build/compatibility-policy.json` 的 `dataEpoch`；不预先升级 |
| 12  | 保留回退候选       | 保留上一版 `.app`；旧版本靠准入拒绝高 epoch 数据，不靠运气                                                    |

放行标准是门禁全绿加安装级冒烟（`smoke:package`）。升级窗口前后在**副本 home** 上手动做一次"读历史 → 写入 → 重启 → 再读"验证，绝不读写真实数据目录。

若无头启动冒烟在第 8 步失败，说明宿主与上游的接缝变了：先读 5.1 的第一行文件，再决定是改代码还是放弃该版本。

## 6. 已知边界

- 旧 DMG 只回退二进制；它**不承诺**能读取新格式数据（靠 admission 拒绝，不靠运气）。
- **冻结旧制品与新版共存**：两个世代的 home 所有权载体在同一个路径上互斥——旧制品把 `<home>/run/host.lock` 当**目录**（`mkdir` 取得，内含 owner 记录），新版把它当**文件**（内核 `flock`）。目录在前时新版打不开文件，文件在前时旧版 `mkdir` 得到 EEXIST，双方都拒绝启动，因此双写在载体层就不可能发生。限制：升级窗口内不要用任何旧二进制指向新版正在使用的 home；该限制随旧制品淘汰自然消失。
- marker 只约束受支持入口之间的协作：裸 CLI、无 guard 的旧二进制或手工写入不受保护。
- 本地自用构建未签名/未公证：Gatekeeper 首次启动需要右键打开；公开分发预编译二进制前需先完成发行要求。公开源代码、由使用者自行构建不受此项限制。

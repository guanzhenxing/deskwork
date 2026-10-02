# Deskwork 收敛方案 v3

- 状态：执行中（2026-09-30 立）
- 日期：2026-09-30
- 关系：取代 `deskwork-plan-v2.md`；产品方向与功能需求冻结并转入 `docs/deferred-work.md`；架构与协议以[架构](architecture.md)与[协议](protocols/host-control.md)为准
- 变更动因：产品需求冻结、入口收敛为单一桌面端。壳的所有权模型是按"两个入口共享 home"设计的，与单入口前提不再匹配，因此需要一次收敛而不是一次功能扩展
- 读法：本文中用反引号包裹的路径，表示该文件在本方案执行过程中会被移动、删除或新建，因此不建立 Markdown 链接；其余路径为可点击链接

## 0. 终态定义

| 维度       | 终态                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------- |
| 入口       | 只有 Electron 桌面应用；无 CLI、无 `dsh-native`                                                |
| 所有权模型 | 进程内不变量 + Electron 单实例锁 + 文件级原子写；无跨进程 lease、无原生 C helper、无 Xcode CLT |
| 插件       | 只有 `desktop-plugin`（把 loopback surface 交给 launcher）；无工作台                           |
| 防腐机制   | `pnpm smoke:headless`：纯 Node boot `deskwork` profile + 官方 Web UI 可达 + 无 Electron        |
| 文档       | 本仓库定位为壳；产品需求在冻结清单；旧方案归档                                                 |
| 规模       | 实现 TS 约 10.2k → 约 6.5k；全仓 TS 约 18.5k → 约 12.5k                                        |
| 打包产物   | 去掉 `runtime-cli` 与 `native` 两类额外资源                                                    |

## 1. 范围

**做**：无头启动冒烟、删除工作台、删除 CLI、重写所有权模型、文档收口、重复与死代码清理。

**不做**：产品功能（全部冻结）、企业自管与托管形态、Windows 与 Linux、自动更新、插件市场、远程访问。以上均记录于冻结清单并写明进入条件。

**保留**：DMG 作为安装级验收的载体（`smoke:package` 从 DMG 副本安装并启动）。此前的方案曾写“不做 DMG 安装镜像”，但 DMG 是当前唯一的安装级验收路径，删掉它等于删掉验收能力而换不来任何产品收益，故决定保留并在本文记录。

## 2. 已验证的前提

| 事实                                                            | 证据                                                                                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 官方 CLI 无条件拒绝 `desktop` profile 的 boot                   | `@deepseek-ai/dsh/lib/bin.js` 的 `rejectElectronProfile`，boot 路径无条件调用                                                             |
| 官方 CLI 仅在自家载体下放开 `desktop` profile 的 plugin 管理    | 同上文件，plugin 路径为 `if (!manageDesktopProfile) rejectElectronProfile(...)`                                                           |
| `@deepseek-ai/dsh-desktop-host` 私有且不可从 npm 获得           | 官方应用内该包 `package.json` 的 `"private": true`，描述为 Private Node-mode host process                                                 |
| `HomeLease` 身兼三职：写权限凭证、Host 归属记录、写入前持锁断言 | `isHomeLease()` 作写入授权判据；`host-supervisor/src/supervisor.ts` 的 `attachHost`；12 处生产代码调用 `assertHeld()`                     |
| `host-runner` 零 Electron 依赖，纯 Node 下已能启动真实 Host     | `packages/host-supervisor/test/host-runner.integration.test.ts` 以 `LoopbackTransport` 跑通                                               |
| `dsh-app-boot` 公开导出 profile 初始化、清单读写与恢复原语      | 其 `lib/index.js` 导出表含 `initProfile`、`readProfileManifest`、`writeProfileBundles`、`sanitizeProfile`                                 |
| `dsh-atomic-write` 公开导出原子写与跨进程文件锁                 | 其 `lib/index.js` 导出 `writeFileAtomic` 与 `withFileLock`                                                                                |
| 基线测试全绿                                                    | 36 个测试文件、361 个测试                                                                                                                 |
| 生产代码触及上游 API 的文件共 5 个                              | 全仓检索 `from '@deepseek-ai/`：host-runner、desktop-plugin、desktop-recovery-bridge 的两个文件、home-lease 的 lease-fs                   |
| 上游版本 pin 散落在三处，其中一处是 284 条逐包列表              | `pnpm-workspace.yaml` 的 `overrides` 与 `minimumReleaseAgeExclude`（284 条 dsh 条目）、`packages/host-supervisor/package.json` 的上游依赖 |

## 3. 执行阶段

### 阶段一 · 无头冒烟与升级流程

**目的**：把"脱离 Electron 的宿主"从集成测试里的偶然通过，固化为一条随时可验证的命令。这是壳在企业与托管形态下唯一可复用的能力。

**改动**

| 动作                      | 位置                                                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增纯 Node 冒烟          | `tests/smoke/headless-boot.mjs`，含自破坏开关 `DSH_HEADLESS_SMOKE_BREAK`                                                                             |
| 新增命令                  | 根 `package.json` 增加 `smoke:headless`                                                                                                              |
| CI 增加一步               | `.github/workflows/ci.yml` 的 macOS job                                                                                                              |
| 新增上游版本 pin 同步脚本 | `scripts/sync-dsh-pins.mjs` 与 `scripts/sync-dsh-pins.test.mjs`，根 `package.json` 增加 `upgrade:dsh-pins` 与 `check:dsh-pins`（后者已并入 `check`） |
| 重写升级流程              | [升级指南](upgrade-guide.md)第 5 节：写入完整 runbook、升级风险面清单、三处版本声明位置                                                              |

冒烟内容：创建隔离 `<testHome>` → 初始化 `deskwork` profile → 在纯 Node 进程中启动 Host → 取 surface 的 loopback URL → 走认证跳转并断言官方 Web UI 的客户端组合图完整（含模块、布局、侧栏条目）→ 断言未加载 Electron → 释放并校验隔离 home 已清除。

上游版本 pin 同步脚本：以 `build/upstream-artifacts.json` 的 `dsh.npmVersion` 为唯一事实源，投影到 `pnpm-workspace.yaml` 的 `overrides` 与 `minimumReleaseAgeExclude`（当前 284 条），以及各包清单里的上游依赖声明。该列表用于绕过 pnpm 的 minimumReleaseAge 策略（上游 rc 发布过新），**且不是排序集合而是历史批次的拼接**，因此脚本按原顺序改写、只追加新解析出的包名，保证在当前基线上零 diff。`@deepseek-ai/cordis` 属独立版本轴，永不改动。

升级流程重写：把第 5 节的 runbook 落成可执行步骤，并在其中写明升级风险面（收敛后仅两个源文件触及上游 API，见第 5 节）与三处版本声明的位置。

**验收**：`pnpm smoke:headless` 绿；负例（`DSH_HEADLESS_SMOKE_BREAK=profile-patch` 破坏 profile 的 patch 层）必须非零退出；真实 `~/.dsh` 与 `~/.deskwork` 的 mtime 不变；`pnpm upgrade:dsh-pins` 在当前基线上运行后不产生 diff，且故意改错一条 pin 后 `check:dsh-pins` 报错。

**回滚**：纯新增，删除即可。

### 阶段二 · 删除工作台

| 动作         | 位置                                                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 删包         | `packages/deskwork-workbench/`                                                                                                                             |
| 删引用       | 根 `tsconfig.json` 的项目引用、`apps/desktop-launcher/package.json` 的依赖、`packages/profile-manager/src/reconcile-templates.ts` 中 bundle 列表里的对应项 |
| 保留知识     | 把该包的浏览器入口移为 `docs/examples/workbench-bundle.md`，它是"bundle 如何注册进官方侧栏插槽"的唯一样例                                                  |
| 更新文档     | 仓库根 `AGENTS.md` 第 1 段、[架构](architecture.md)第 4.2 节                                                                                               |
| 重新生成产物 | `release/`                                                                                                                                                 |

**验收**：`pnpm check` 绿；`pnpm smoke:dsh-ui` 绿（壳照常启动，侧栏不再有产品入口）；`pnpm test:integration` 绿。

**回滚**：单一提交，反向提交即回。

### 阶段三 · 删除 CLI 与共享 home 叙事

**约束**：本阶段只删入口，**不动 lease 模型**。此阶段结束后得到的是"干净的单入口壳 + 一套确实多余的 lease"，阶段四要动什么因此一目了然。

**代码**

| 动作                    | 位置                                                                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 删应用                  | `apps/bundled-cli/`                                                                                                                                                                                                                          |
| **先拆分再删除** helper | `tests/helpers/shared-home-driver.mjs` 不可整删：其中 `ensureLauncherBuilt`、`waitUntilDead`、`withDesktop` 被多个冒烟与 `tests/helpers/installed-app.mjs` 引用。先搬到 `tests/helpers/desktop-driver.mjs` 并跑绿，再删 shared home 专属部分 |
| 改导入                  | `tests/smoke/` 下的 auth、conversation、lifecycle、navigation、package-main，以及 `tests/helpers/installed-app.mjs`                                                                                                                          |
| 删冒烟与夹具            | `tests/smoke/shared-home.mjs`、`tests/fixtures/lease-holder.mjs`                                                                                                                                                                             |
| 删开发入口              | `scripts/dsh-native.mjs`                                                                                                                                                                                                                     |
| 清打包链                | `scripts/stage-runtime.mjs` 中部署 CLI 闭包、捆绑 Node 与 pnpm、CLI shim 与 closure 摘要的段落；`build/electron-builder.config.cjs` 的对应额外资源                                                                                           |
| 清 helper 期望          | `tests/helpers/installed-app.mjs` 中的 CLI 入口字段                                                                                                                                                                                          |
| 删命令                  | 根 `package.json` 中 CLI 入口、shared home 冒烟与 shared home 集成测试三条                                                                                                                                                                   |
| 清 CI                   | `.github/workflows/ci.yml` 中 shared home 的集成测试与冒烟两步                                                                                                                                                                               |
| 更新脚本测试            | `scripts/stage-runtime.test.mjs`、`scripts/verify-runtime-tree.test.mjs` 中与 CLI 闭包相关的断言                                                                                                                                             |

**文档**：`docs/protocols/home-lease.md` 移入归档并从 `scripts/verify-docs.mjs` 的必检清单移除；仓库根 `README.md` 的并发限制整节、使用章节的 CLI 段与架构摘要的 CLI 支线；[架构](architecture.md)第 2 节与第 4.1 节；[数据布局](data-layout.md)的 CLI 与清锁段；[开发指南](development.md)的目录树与命令表；[升级指南](upgrade-guide.md)的入口枚举；[home-compatibility](protocols/home-compatibility.md)的适用入口；[启动恢复](protocols/startup-recovery.md)的清锁表述。

**验收**：`pnpm check` 绿；`pnpm test:integration` 绿；桌面 UI、Host 崩溃、profile 恢复、Safe Mode、生命周期五个冒烟全绿；`pnpm package:dir` 产物可安装启动。

**回滚**：单一提交。**本阶段结束是一个决策点**：如需止损，可停在此处。

### 阶段四 · 重写所有权模型

四个子阶段，各自一个提交、独立可验证。

#### 4a · 建立替代类型

在 `packages/desktop-contracts` 新增 home session 类型（持有 home、generation、profile 三个只读字段）与构造函数；**不改任何调用点**，与既有 lease 并存。

**验收**：`pnpm check` 全绿，零行为变化。

#### 4b · 换掉写权限与持锁断言

- `packages/profile-manager`：写入授权类型改为"home session 或隔离 authority"；删除 9 处 `assertHeld`（revision transaction 5 处、reconcile plan、safe profile、revision recovery）。
- `packages/release-compatibility/src/home-marker.ts`：删除 lease 参数与 `assertHeld`；**保留数据 epoch 准入**（与 lease 无关，仍有价值）。
- `packages/shell-core/src/projection-cache.ts`：删除 2 处 `assertHeld`。

**验收**：`pnpm test:integration` 全绿，尤其 profile 事务与准入负例。

#### 4c · 重建 Host 归属与孤儿检测

> **执行时修订（2026-10-02）**：本节原设计用"pid + argv 针脚 + 启动身份"推断孤儿，实现时改为**内核 flock 作为存活性权威**。原因见下方 §9，实际实现以该节为准。

- `packages/host-supervisor/src/supervisor.ts`：把 `attachHost` 与 `confirmHostExited` 换成精简的 owner 记录（pid、Host 入口路径、时间戳），写入使用上游原子写。
- 新增 `packages/host-supervisor/src/host-owner.ts`：Host 进程自身持有 `<home>/run/host.lock` 的内核 `flock`（随进程消亡释放，永不陈旧、免疫 pid 复用）；启动前的判定是"能取到锁就没有活跃 Host"，取不到时按记录终止，终止不掉即拒绝启动。
- 第一道防线保持不动：`apps/desktop-launcher/src/host-entry.ts` 中父端口关闭即退出的处理。

**验收**：`host-owner.test.ts` 覆盖锁互斥、锁释放、陈旧记录接管、pid 存活但锁空闲时**不得发信号**、活锁下等待/终止、杀不掉时拒绝启动并保留记录。

#### 4d · 删包与收尾

- 删 `packages/home-lease/`（含原生 C helper）。
- 删 `scripts/build-lease-helper.mjs`、根 `package.json` 的原生构建命令、CI 的原生构建步骤、`build/electron-builder.config.cjs` 的原生额外资源。
- 删 `apps/desktop-launcher/src/lease-diagnostics.ts`（其中仍需要的 `resolveSmokeHome` 移入 `smoke-home.ts`）。
- launcher：获取 lease 改为构造 home session；启动前做一次孤儿 Host 判定，拒绝时报告并退出。

**验收**：`pnpm check`、`pnpm test:integration` 与全部桌面冒烟绿；手工负例——放入死 pid 的陈旧 owner 记录，启动应自动接管；放入存活的伪造 pid，启动应进入恢复窗口而非静默覆盖。

**回滚**：4a 至 4d 逐级可退，任一子阶段失败退回上一子阶段，不影响阶段一至三。

### 阶段五 · 文档收口与清理

**文档**

- 新建 `docs/deferred-work.md`：冻结的功能需求清单，逐条写明进入条件。
- `deskwork-blueprint.md`、`deskwork-features.md`、`deskwork-plan-v2.md`、`movo-research.md` 移入 `docs/archive/`（该目录已被文档门禁忽略）。
- 仓库根 `README.md` 的范围与限制一节、`AGENTS.md` 第 1 段改写为壳的定位。
- 校验 `scripts/verify-docs.mjs` 的必检清单与实际文件一一对应。
- 文档中不得出现已退役的规划阶段编号（字母加数字的旧阶段标签），否则文档门禁会红。
- ~~顺带决策：CI 的打包 job 仍在构建 DMG，而此前决定"不做 DMG 安装镜像"。~~ **已决（2026-10-02）：保留 DMG**，理由见第 1 节。

**清理**（放在 4d 之后，否则前两项会做两遍）

1. 6 处手写原子写统一为上游原子写；6 份重复的目录同步 helper 合并。
2. `packages/profile-manager` 中逐字重复的清单解析与重建函数合并。
3. 删除隔离 authority 的遗留分支（`legacyIsolatedReconcile` 及其调用路径）；`createIsolatedHomeAuthority` **保留**——阶段一的无头启动冒烟是它的正式消费者，不再是"仅测试使用"。
4. 删除无生产者的格式准入校验面。
5. 删除 `packages/release-compatibility/lib/` 下无对应源码的过期编译产物。
6. `packages/desktop-recovery-bridge` 与 `packages/desktop-plugin` 合并，或至少删除前者中丢弃返回值的调用。
7. `packages/profile-manager` 的清单读写与 Safe Mode 改用 `dsh-app-boot` 的公开导出。

**验收**：`pnpm check` 绿；测试全绿；行数下降可量化。

## 4. 阶段总表

| 阶段 | 内容               | 预估          | 累积终态                         | 回滚点        |
| ---- | ------------------ | ------------- | -------------------------------- | ------------- |
| 一   | 无头冒烟与升级流程 | 2 天          | 壳获得防腐机制与可执行的升级流程 | 删除文件      |
| 二   | 删除工作台         | 半天          | 产品面归零，纯壳                 | 反向提交      |
| 三   | 删除 CLI           | 1 至 1.5 天   | 单入口，**决策点**               | 反向提交      |
| 四   | 重写所有权         | 1.5 至 2.5 周 | 模型自洽，去 Xcode 依赖          | 4a 至 4d 逐级 |
| 五   | 文档与清理         | 2 天          | 文档说真话，重复清完             | 反向提交      |

## 5. 上游升级

本节描述收敛完成后长期适用的升级流程，由阶段一落成到[升级指南](upgrade-guide.md)第 5 节。

### 5.1 升级风险面

生产代码对上游的依赖收敛前集中在 5 个文件，收敛后只剩 2 个：

| 阶段       | 文件                                                            | 触及的上游                                                                                                                                                |
| ---------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 收敛前     | `packages/host-supervisor/src/host-runner.ts`                   | `dsh-app-boot` 的 `boot`、`loadProfile`、`createRuntimeResolution`、`loadOptionalPatches`、`PluginPackages`，以及 `dsh-cmdline`、`dsh-launch-environment` |
| 收敛前     | `packages/desktop-plugin/src/index.ts`                          | cordis 的 `Context` 类型与服务名 `connection`、`webServer`                                                                                                |
| 收敛前     | `packages/desktop-recovery-bridge/src/index.ts` 与 `runtime.ts` | 同上（阶段五清理第 6 条会并入 `desktop-plugin`）                                                                                                          |
| 收敛前     | `packages/home-lease/src/lease-fs.ts`                           | `writeFileAtomic`（4d 删除）                                                                                                                              |
| **收敛后** | `packages/host-supervisor/src/host-runner.ts`                   | 同上                                                                                                                                                      |
| **收敛后** | `packages/desktop-plugin/src/index.ts`                          | 同上                                                                                                                                                      |

升级时先读 `host-runner.ts`：上游 rc 迭代中破坏性较强的变动（模块解析物化方式的替换、自动化任务移入可选插件包等）都集中在这里。

### 5.2 升级 runbook

| #   | 动作                     | 位置                                                                                                                                                                    |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | 判断是否值得升           | 由新 tag、影响本项目的缺陷或安全问题、真实使用需求触发，不按日历                                                                                                        |
| 1   | 开候选分支               | `chore/upgrade-dsh-<实际标签>`，与功能分支隔离                                                                                                                          |
| 2   | 同步版本声明             | `pnpm upgrade:dsh-pins`（阶段一新增），覆盖 `pnpm-workspace.yaml` 的 `overrides` 与 `minimumReleaseAgeExclude`，以及 `packages/host-supervisor/package.json` 的上游依赖 |
| 3   | 重解依赖                 | `pnpm install`                                                                                                                                                          |
| 4   | 更新上游制品账本         | `build/upstream-artifacts.json` 的 tag、commit、npmVersion 与逐包 integrity                                                                                             |
| 5   | 重新生成兼容性清单       | `pnpm generate:compatibility`                                                                                                                                           |
| 6   | 跑门禁                   | `pnpm verify:dsh-closure`、`pnpm verify:patches`、`pnpm verify:runtime-tree`、`pnpm check`                                                                              |
| 7   | 集成测试                 | `pnpm test:integration`                                                                                                                                                 |
| 8   | **无头冒烟（核心信号）** | `pnpm smoke:headless`                                                                                                                                                   |
| 9   | 桌面冒烟                 | `pnpm smoke:dsh-ui`、`host-crash`、`profile-recovery`、`safe-mode`、`lifecycle`                                                                                         |
| 10  | 打包验收                 | `pnpm package:dir` 与 `pnpm smoke:package`                                                                                                                              |
| 11  | 数据格式决策             | 仅当上游改动会话或设置的磁盘格式时，才决定是否升 `build/compatibility-policy.json` 的 `dataEpoch`；不预先升级                                                           |
| 12  | 保留回退候选             | 保留上一版 `.app`；旧版本靠准入拒绝高 epoch 数据，不靠运气                                                                                                              |

门禁全绿加安装级冒烟通过即放行。升级窗口前后在副本 home 上手动做一次"读历史 → 写入 → 重启 → 再读"验证，绝不读写真实数据目录。

### 5.3 收敛带来的简化

- lease 删除后，[升级指南](upgrade-guide.md)第 6 节关于"冻结旧制品的清锁入口与新版身份格式不兼容、靠哨兵与看门狗压缩双写窗口"的整段叙事随之消失，减少一类长期兼容性负担。
- 没有 CLI，就不再有 CLI 子进程与桌面端之间的互斥与身份格式问题。
- 原生构建、shared home 的集成测试与冒烟从升级验证中消失。

## 6. 风险与对策

| 风险                                      | 对策                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| 拆分测试 helper 时连带弄红多个冒烟        | 先搬公共导出并跑绿，再删 shared home 专属部分，分两个提交                                 |
| 阶段四在恢复路径下换地基，回归难以定位    | 严格按 4a 至 4d 分段，每段跑集成测试与五个桌面冒烟                                        |
| 以 pid 存活判据误判（pid 复用）           | 增加 argv 针脚二次确认；保留父端口关闭的第一道防线；恢复窗口保留人工强制解锁              |
| 孤儿 Host 检测写漏，新旧 Host 同时写 home | 4c 必须补齐三个负例测试；冒烟增加"终止 launcher 但保留 Host 后重启"的用例                 |
| 冻结之后壳随上游版本漂移而失效            | 阶段一的冒烟挂进 CI 与升级流程，每次引擎升级必跑                                          |
| 升级时漏改上游版本 pin（284 条）          | 阶段一落成 `pnpm upgrade:dsh-pins`，并由 CI 比对生成结果与仓库内容一致                    |
| 文档改动触发文档门禁                      | 先改文档再跑检查；必检清单同步；避免旧阶段标签与新链接指向尚未移动的文件                  |
| 触碰真实用户数据                          | 一切测试与冒烟只用隔离 `<testHome>`；真实 `~/.dsh` 与 `~/.deskwork` 的 mtime 作为验收证据 |

## 7. 中止条件

出现任一条即停下报告，不自行扩大范围：

1. 阶段一的冒烟在隔离 home 下无法稳定通过；
2. 阶段三之后任一桌面冒烟无法恢复绿；
3. 4b 之后 profile 事务或准入负例失败且一天内无法定位；
4. 任何阶段触碰或污染真实的 `~/.dsh`、`~/.deskwork`。

## 8. 每阶段纪律

1. 一次只改一件事，改完立刻真跑，用真实结果说话；
2. 每阶段一个提交，使用既有提交前缀；
3. 卡住就贴原始报错与行号，不写"可能 / 多半 / 预计"；
4. 做完一步停下报结果，不附带长总结；
5. 未获明确许可，不开分支、不写提交、不开始下一步。

## 9. 执行记录

### 9.1 进度（2026-10-02）

阶段一至四已完成，代码、测试与文档一致；阶段五未开始。全部改动仍在工作区，未提交。

| 阶段                    | 状态   | 验收                                                |
| ----------------------- | ------ | --------------------------------------------------- |
| 一 · 无头冒烟与升级流程 | 完成   | `smoke:headless` 绿；`upgrade:dsh-pins` 基线零 diff |
| 二 · 删除工作台         | 完成   | 客户端条目 66 → 65；残留引用 0                      |
| 三 · 删除 CLI           | 完成   | 集成测试 31 通过；打包链去掉 `runtime-cli`          |
| 四 · 重写所有权模型     | 完成   | 单元 305、集成 18、无头冒烟绿；全部门禁绿           |
| 五 · 文档收口与清理     | 未开始 | 冻结清单与 A 类清理仍待做                           |

### 9.2 对 4c 的修订：用 flock 而不是 pid 推断

原设计让孤儿检测"读 pid → 判断存活 → 用 argv 针脚确认是本应用的 Host"。第一版按此实现，用 `ps` 读取进程启动时间与命令行；**当场失败**：

```text
Error: spawn EPERM
```

这不只是本机沙箱的限制。用"再起一个进程去观察另一个进程"来回答"它是否还活着"，同时依赖外部二进制、PATH 与不可靠的启动身份，是把一个内核已经解决的问题重新做成启发式判断。

改为：**Host 进程自己持有 `<home>/run/host.lock` 的内核 `flock`**（`@deepseek-ai/node-addon-system`，本就在依赖闭包内）。

- 锁是存活性权威：内核在进程消亡时释放，包括 SIGKILL，因此不存在陈旧锁，也无法被 pid 复用欺骗；
- owner 记录（pid + Host 入口路径）只是可达性：锁被持有时才知道该终止谁；
- 判定退化为一句：能取到锁就没有活跃 Host，取不到就按记录终止，终止不掉即拒绝启动。

改完之后，此前因 `ps` 失败的两个集成测试直接转绿。`process-probe.ts` 也随之缩到只剩 `isProcessAlive`。

### 9.3 与其余既定事项的差异

- 阶段三方案把 `tests/fixtures/lease-holder.mjs` 列为待删，实际保留：它被保留的 `home-lease` 集成测试使用；该夹具随阶段四删包一并消失。
- 阶段三方案只列了三处打包改动，实际连锁到 `resource-paths.ts`（三个只有测试在断言、生产零消费者的 `runtime-cli` 路径字段）、`verify-runtime-tree.mjs` 的第二闭包校验、`package-main.mjs` 的五个 CLI 场景。
- 两个最大的测试文件（`supervisor.test.ts` 684 行、`recovery-controller.test.ts` 807 行）深度绑定已删除的 lease 语义，执行时整体重写；`supervisor.test.ts` 中"用 `mkdir` 失败触发未授权子进程"的初始建议被否决——那样会让"记录仍在"的断言恒假，改用"授权前子进程死亡"触发。

### 9.4 验收范围（2026-10-02 晚修正）

**此前本节写着"沙箱无法启动 Electron"，这个结论是错的。** 当时只试了 `env -u ELECTRON_RUN_AS_NODE`，漏了 `ELECTRON_DISABLE_SANDBOX=1`；两者同时给上之后 Electron 44.0.0 正常启动（`ELECTRON_READY_OK`）。

**已执行且通过**：

| 类别               | 冒烟                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 源码级（Electron） | `smoke:dsh-ui`、`smoke:host-crash`、`smoke:lifecycle`、`smoke:conversation`、`smoke:auth`、`smoke:navigation`      |
| 纯 Node            | `smoke:headless`、`smoke:safe-mode`、`smoke:profile-recovery`                                                      |
| 安装级             | 打包 `.app` 后以 `DSH_DESKTOP_SMOKE=ui` 直接启动，报告 `ui-ready`（launcher 与 Host 独立进程、profile `deskwork`） |

**仍不可执行**：`smoke:package` 需要 `release/artifacts.json`，而该文件只收录 DMG；`hdiutil create` 在本沙箱被拒绝（"操作不被允许"），因此 DMG 与其清单无法产出，`smoke:package` 的五个场景未跑。

**跑起来之后发现的缺陷**（全部由"从未跑过"造成，均已在 9.8 记录并修复）：三处冒烟失效、一处打包前置检查仍要求已删除的 `runtime-cli`、一处 `clearHostOwner` 语义与冒烟期望不符。

**执行环境**：`pnpm` 的依赖校验在非 TTY 下会挂起，需要 `CI=true`；corepack 与 Electron 的缓存目录都在工作区外不可写，分别用 `COREPACK_HOME` 与把 `HOME` 指到工作区内绕过。

### 9.5 阶段五执行记录（2026-10-02）

**文档冻结**：新建[冻结的产品需求](deferred-work.md)（11 个模块、69 条未排期功能、各自进入条件与上游可复用件）；`deskwork-blueprint.md`、`deskwork-features.md`、`deskwork-plan-v2.md`、`movo-research.md` 移入 `docs/archive/`；README 文档索引改为指向方案、冻结清单与 bundle 样例。**DMG 决策已定：保留**，理由见第 1 节。

**A 类清理结果**

| 项                               | 结果                                                                        |
| -------------------------------- | --------------------------------------------------------------------------- |
| 1 · 统一原子写                   | **改做**：新建 `packages/durable-fs`，把 5 份复制合并为 1 份                |
| 2 · profile-manager 重复函数     | 完成（随第 3 项一并删除，不再需要去重）                                     |
| 3 · 删遗留隔离分支               | 完成：`legacyIsolatedReconcile` 删除，隔离冒烟改走生产同一条 journaled 路径 |
| 4 · 死掉的格式准入面             | **部分**：删除两个永不可产生的 verdict；`formats` 校验保留                  |
| 5 · 过期构建产物                 | 完成（`inspect-home`、`preflight`）                                         |
| 6 · recovery-bridge 重复         | 完成：`runtime.ts` 删除，索引直接发布，少一层纯仪式                         |
| 7 · 改用 `dsh-app-boot` 公开原语 | **否决**，理由见下                                                          |

### 9.6 阶段五否决的两项与理由

**第 1 项不能照做**。上游 `@deepseek-ai/dsh-atomic-write` 的实现里明确写着 "Crash durability (fsync) is out of scope"，而它要替换的六份手写实现**全都做了 fsync，且都是为崩溃恢复而写**（事务 journal、准入 marker、恢复 marker、owner 记录）。直接替换会把这些文件的耐久性降到"可能丢"，是拿正确性换行数。改做后：新建 `packages/durable-fs` 作为唯一持久写原语（fsync 临时文件 → 原子 rename → fsync 文件 → fsync 目录），`profile-manager`、`shell-core`、`release-compatibility`、`host-supervisor` 统一使用，并补了 8 个测试。

**第 7 项不能做**。上游 `sanitizeProfile` 的语义是"备份用户 patch 后覆盖 bundle 列表"——那是官方桌面 fatal recovery 的锤子。而 `profile-manager` 的 Safe Mode 刻意相反：发现 safe profile 里有无法解析的用户内容就返回 `conflict` 并放弃写入。换用上游原语，等于放弃 README 与 `SECURITY.md` 里"绝不自动覆盖 home 级用户数据"这条承诺。清单读写同理：上游 `writeProfileBundles` 整体重写 manifest，而现有实现是"比对字节、只写白名单三文件、内容相同就完全不碰"。

两项的共同点：**方案把"行数更少"当成了目标，而这两处的行数买的是耐久性与不覆盖承诺。**

### 9.7 清理过程中修正的两处真实缺陷

删掉遗留隔离分支后，测试暴露了两个此前被掩盖的行为差异，均已修在实现侧：

- `planDesktopReconcile` 的重复文件守卫把"符号链接"与"非普通文件"合并成一条文案，导致按 symlink 断言的用例失败；现分开报告。
- `reconcileDesktopProfile` 在幂等运行（无写入）时把 `beforeRevision` 报成 `undefined`，使"内容未变"与"无法确定"不可区分；现回退到当前字节的摘要，创建场景仍为 `undefined`。

### 9.8 补跑冒烟发现的缺陷（2026-10-02 晚）

这些都不是新功能，而是"改完之后没有真跑"留下的空洞。全部已修。

| 位置                                                           | 问题                                                                                                                        | 来源                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `tests/smoke/profile-recovery.mjs`                             | require 了 `desktop-contracts/package.json`——该包不导出这个子路径，冒烟在 `ERR_PACKAGE_PATH_NOT_EXPORTED` 上直接死掉        | 本次改动（重命名残留）               |
| `tests/smoke/profile-recovery.mjs`                             | fixture 对象里一个裸 `session,` 简写指向自身，构造即 TDZ 崩溃                                                               | 本次改动（重命名残留）               |
| 两个纯 Node 冒烟                                               | 仍用改名前的 profile 名 `'desktop'`，且没传 `ownedProfileName`，导致 reconcile 被整个跳过——没有事务、没有回滚、没有自动重启 | 早于本次改动（`c04bb33` 漏改调用点） |
| `tests/smoke/profile-recovery.mjs`                             | 断言"第二次获取同一 home 被拒绝"——该性质已随 lease 一起废弃，互斥现在由 Host 的 flock 承担                                  | 本次改动（语义变更未同步）           |
| `scripts/package-app.mjs`                                      | `assertStaged()` 仍要求 `runtime-cli/bin/dsh-native` 与 `runtime-cli/node/bin/node`，打包在第一步就失败                     | 本次改动（阶段三删 CLI 漏改）        |
| `tests/smoke/package-main.mjs`                                 | 三个场景用被删除的第二份 Node 跑驱动                                                                                        | 本次改动（同上）                     |
| `tests/smoke/dsh-ui.mjs` + `apps/desktop-launcher/src/main.ts` | 冒烟只断言工作台的侧栏面板；launcher 里对应有 55 行工作台校验死代码（`workbench-panel-verified` / `-failed`）               | 本次改动（阶段二删工作台漏改）       |
| `packages/host-supervisor/src/host-owner.ts`                   | `clearHostOwner` 写墓碑而不是删除记录，与"退出后记录消失"的期望不符                                                         | 本次改动                             |

教训写在这里而不是别处：**这八处里有六处是本次收敛自己造成的，而六处中的每一处都能被一条现成的冒烟命令抓到——只是那几条命令从来没跑过。** 静态检查、类型检查、单元测试和 lint 全绿，与"应用还能不能起来"是两件事。

# Deskwork 执行方案（v2）

- 状态：执行中（v2.1；整合 2026-09-28 两轮五遍审查修订，第二轮记录见 §9；执行进度见 §2.1）
- 日期：2026-09-28
- 关系：整合并取代 `deskwork-plan.md` 草案（三遍审查版，已归档于 `docs/archive/deskwork-plan-v1.md`）
- 相关文档：[蓝图](deskwork-blueprint.md)、[架构](architecture.md)、[开发指南](development.md)、[home-lease 协议](protocols/home-lease.md)、[home-compatibility 协议](protocols/home-compatibility.md)

## 1. 目标

把本仓库现有的 macOS 壳代码变成 **Deskwork**：一个数据在自己手里、引擎用 DSH 的本地 AI 工作台。现有代码（112 个源文件、21,275 行、43 个测试文件）是起点，继续在上面长，不重写。

## 2. 已定的事（不要重新讨论）

| 项   | 定                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------- |
| home | Deskwork 自己的应用数据目录 `~/.deskwork`，只认 `DESKWORK_HOME`（上游 `DSH_HOME` 已明确不是输入） |
| 引擎 | `@deepseek-ai/dsh` 跟随上游 rc 基线，当前 `0.2.0-rc.1`                                            |
| 起点 | 仓库现有代码，不重写，不称"旧壳"                                                                  |
| 节奏 | 一次只改一件事，改完真跑，做完停下                                                                |

### 2.1 执行进度（2026-09-28 更新）

- **已完成**：第一段全部（1 身份与 home——后续经 4ef7220 收紧为只认 `DESKWORK_HOME`；2 引擎 0.1.7-rc.2；2b 准入最小化；3 真启动）；第二段全部（4 slot 机制、5/6 workbench 上侧栏）；第三段 7 前置（证据链摘除）；引擎再升级 0.2.0-rc.1（514be7f）；profile 改名 `deskwork`（24bf96b，上游保留 `desktop`）。
- **进行中**：7（打包）与 7b（包名/appId 身份收尾）。
- **未开始**：第四段工作台（8–14）、第五段 office（15）。

## 3. 保留、放弃、暂不动

### 保留（继续用）

`host-supervisor`（引擎启动与监督）、`desktop-contracts` 的 Host-control、`shell-core` 的失败分类与恢复会话、`profile-manager` 的修订事务、两个 bundle 作为插件写法样板、测试与隔离 home 夹具、staging 与打包链、home lease（防自己多开）。

### 放弃（要动代码，不是只改文档）

| 放弃的东西                      | 代码上要做什么                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 边界与豁免（五遍审查查实）                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 跨产品格式准入                  | 先把 launcher 与 CLI 的准入调用（`runHomeCompatibilityChain` / `admitHome`）替换成最小检查（marker 的 `schemaVersion` 与可接受的 epoch；替换发生在 `home-marker.ts` 链内，launcher 与 CLI 调用点不动），并清空 `build/compatibility-policy.json` 的 `formats[]`（保留 `dataEpoch`/`supportedDataEpochs`/`pluginApi`——其证据被 `generate-compatibility.mjs:115-140` 机器校验钉死在 0.1.2-rc.1，引擎升级后生成器直接抛错），验证通过后再删 `inspect-home.ts` 的槽位勘察与 `preflightHome` 的判定树及其测试 | 保留：`home-admission.ts`（marker 解析）、`reserveHomeWrite`（marker 预约）、`manifest.ts` 的 `loadReleaseManifest`（epoch 事实来源）、launcher 侧 `admitHomeBeforeAnyWrite` 的失败分类（`HOME_FORMAT_*` 错误码暂无生产者，枚举保留）。`inspect-home`/`preflight` 包外无消费者，删除面干净                                                                       |
| 公开发行证据链                  | 先摘引用再删：`package.json` 的 `generate/verify-release-evidence`、`verify:artifacts`、`rehearse:upgrade`、`verify:release` 脚本行与 `test:unit` 行内的 `release-evidence.test.mjs`；CI（`ci.yml` 候选打包 job 的 `verify:artifacts`）；删 `generate-release-evidence.mjs`、`verify-release-evidence.mjs`、`release-evidence-lib.mjs` 及测试、`verify-artifacts.mjs`、`rehearse-upgrade.mjs`、`verify-release.mjs`（被删步骤的编排器，留着必红）与 `tests/upgrade/**`；删已提交的 `release/evidence/*`  | **`tests/helpers/upgrade-fixture.mjs` 当时因 plugin-intake 冒烟引用而豁免**（执行备注：plugin-intake 三件套随后整体删除，该夹具随之删除）；`loadReleaseManifest` 被准入链使用，保留；同步更新 `verify-docs.mjs` 的 `additionalPublicTextFiles` 清单（写死了 `generate-release-evidence.mjs`）；`development.md` §9 发布流程与 `upgrade-guide.md` 同步重写为 `check + package + smoke:package` |
| 与官方 CLI 共享 home 的并发叙事 | 只改文档与用户可见文案：README「重要并发限制」节、架构 §2、数据布局 §2 末行、home-lease 协议 §1 目标句的共享表述                                                                                                                                                                                                                                                                                                                                                                                         | lease 本身保留（防自己多开）；协议中 launcher/CLI 互斥的 normative 部分不动                                                                                                                                                                                                                                                                                      |

### 暂不动（一行不碰，等承诺明确再处理）

- 其余一切"可删"的东西（不参与运行）；
- **包名前缀 `@dsh-desktop/*` 与根包名 `deepseek-harness-desktop`、`appId`**：全仓机械改名，已排入 7b（第三段），在那之前不动，绝不混入步 1；
- `defaultProfileName: 'desktop'`：等第二段组装产品 Profile 时再定（蓝图定的 Profile 名 `deskwork` 届时落地）；
- `binName`/`cliName`/`rendererPartition`：随 7b 一并评估定案。

## 4. 第 0 步 · 环境预检（动手前过一遍）

1. 一切测试与冒烟确保 `DESKWORK_HOME` 未设置（隔离 home 夹具在它存在时拒绝运行）；环境里残留的 `DSH_HOME` 对产品与夹具均无效（4ef7220 起解析只读 `DESKWORK_HOME`）。
2. Node 用 nodejs.org 的 24.11.1（`/tmp/deskwork-spike/toolbin` 有现成 shim）；**绝不用 DSH 运行时自带的 node**——macOS Team ID 不匹配，加载不了 npm 安装的原生插件。
3. pnpm 11.7.0；若 `node_modules` 曾由 pnpm 10 安装，`CI=true` 可跳过 purge 确认。
4. `build:native` 与打包需要 Xcode Command Line Tools。
5. 红线：一切测试与冒烟只用隔离 `<testHome>`。真实 `~/.dsh` 正被官方 DSH 桌面应用（0.1.7-rc.2）占用，sessions 已是 v3/v4 混合——**绝不写入**。
6. `/tmp/deskwork-spike/` 与 `/tmp/deskwork-code-cards.md` 是易失材料，可随时重建。

## 5. 工作分段

### 第一段 · 成为 Deskwork 并跑起来

| 步  | 做什么                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 验收                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | **身份与 home 一次改完**：`packages/product-config/src/index.ts` 的 `name`/`displayName`/`dataDirectoryName` → `Deskwork`（蓝图 §3.1）；`packages/home-lease/src/home-paths.ts:37` 的默认值 `~/.dsh` → **`~/.deskwork`**；调用点两处（launcher `main.ts:536`、bundled CLI `main.ts:405`）；改写 `home-paths.test.ts` 的上游 parity 测试组；清扫硬编码旧名（grep `DeepSeek Harness` 字面量：11 处非测试代码、7 个文件，**含保留 smoke 的名字断言** `tests/smoke/package-main.mjs`、`startup-performance.mjs`、`plugin-intake.mjs`，不扫则 `smoke:package` 红；`tests/upgrade/rehearsal.mjs` 的命中随 7 前置删除，不用扫）；隔离夹具 `assertOutsideForbiddenRoots` 禁入清单加 `~/.deskwork`（与 `~/.dsh` 同等待遇）；同步文档（README、架构、数据布局的 `<home>` 定义）与共享 home 叙事文案。`defaultProfileName` 不动。（执行备注：本步最初保留了 `DSH_HOME` 覆盖机制，后经产品决策收紧——`resolveDesktopHome` 只读 `DESKWORK_HOME`，见 4ef7220。）  | 数据落在 `~/.deskwork`；`~/.dsh` 的 mtime 不变；`pnpm check` 绿 |
| 2   | **引擎 0.1.2-rc.1 → 0.1.7-rc.2**：第一个动作 `pnpm install`，真实规模以实测为准，之前不做任何估算。已知断点：`healProfilesModuleFallback`（`host-runner.ts:10` import，`:268`/`:289` 调用），候选替代 `createRuntimeResolution`，动手时以新包实际导出为准。注意：新导出 `removeLinkProjections` 清理的是 `<profile>/node_modules` → `.dsh-module-fallback` 的投影，与本壳 `profiles/.dsh-desktop-run-*/node_modules` 路径不同，**不要据此断定中性启动根多余**；cordis 4.0.2→4.0.4，`ctx.provide` 必须先于 `ctx.set`（实测）。本步同时更新 `build/upstream-artifacts.json`（新 tag/commit/npmVersion/闭包）并对账 `docs/upstream-baseline.md`——`verify:dsh-closure` 按 lockfile 强制闭包等于记录的 npmVersion，不更新则打包链必红。本步验收**不含**集成套件（准入会拒），全套验证归步 3；**本步与 2b 之间 `check:docs` 红是已知中间态**（`docs/compatibility.json` 的 `dshNpmVersion` 比对 + policy 证据卡住生成器），不触发中止条件，2b 落地后转绿 | lockfile 里 `@deepseek-ai/dsh*` 全为 `0.1.7-rc.2`；typecheck 过 |
| 2b  | **准入链替换为最小检查**。理由：`SESSION_FORMAT_VERSION` 从 0 跳到 4、`dsh-settings-file` 包消失，而 `inspect-home.ts:14-20` 写死 0.1.2-rc.1 的格式 ID——第一次启动写入 v4 会话/新 settings 后，第二次启动必被旧勘察拒进恢复页（机制已在 `preflight.ts:44-75` 逐行核实）。动作按序：(a0) 清空 `build/compatibility-policy.json` 的 `formats[]`（保留 `dataEpoch`/`supportedDataEpochs`/`pluginApi`），`generate:compatibility` 重新生成 `docs/compatibility.json`；实现时确认 `parseReleaseManifest` 容忍空 formats（若严格拒绝则同步放宽，属本步接口修整面）。(a) 最小检查落在 `home-marker.ts` 链内——launcher（`main.ts:704-714`）与 CLI（`main.ts:299-313`、`:432`、`:476`）的调用点与失败分类不动；marker 预约照旧写入空 formats（解析允许，`home-admission.ts:42-55` 已核实）。(b) 隔离 home 连续启动两次验证。(c) 验证通过后删勘察与判定树及其测试                                                                                            | 空 home 连续两次启动都过准入；删除后 `pnpm check` 绿            |
| 3   | **真启动**：launcher → utilityProcess → Host runner → surface，隔离 home。本壳自己的启动路径在 0.1.7-rc.2 下**从未验证过**（验证过的只是 CLI 路径），这是本步要回答的问题；起不来用 diagnose 系统化定位。起得来不算完——退出再起第二次，证明 2b 生效；**Safe Mode 也在 rc.2 下起一次**（safe profile 走同一 runner，三个固定 bundle，可能独立坏，`smoke:safe-mode` 现成）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Host ready、官方 UI 挂载；重启后依旧；Safe Mode 可进            |

### 第二段 · 第一个工作台可见

| 步  | 做什么                                                                                                                             | 验收                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 4   | 读上游 UI slot（侧栏入口）机制。现有两个 bundle 只发布过 surface，没注册过任何 UI 入口，该机制只有调研未在本仓库验证，所以是必需步 | 能说出一个 bundle 注册侧栏入口的确切写法 |
| 5   | 写 bundle：侧栏入口 + 空面板（以 `desktop-plugin`/`desktop-recovery-bridge` 为写法样板）                                           | 侧栏出现 Deskwork 入口                   |
| 6   | 装上、启动                                                                                                                         | 点进去是空面板，不是报错                 |

### 第三段 · 打包前移

| 步     | 做什么                                                                                                                                                                                                       | 验收                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 7 前置 | 按第 3 节"放弃"第二行摘除发行证据链（先摘 `package.json` 与 CI 引用，再删代码与 `tests/upgrade/**`、`release/evidence/*`，同步 development.md §9 与 upgrade-guide）                                          | `pnpm check` 绿；CI 配置不再引用已删命令                 |
| 7      | staging + `package:dir`/`package:dmg`（fresh clone 需先 `generate:compatibility`；`build:native` 需 Xcode CLT）                                                                                              | 可安装制品装上能启动。此后每个工作台都用**打包产物**验收 |
| 7b     | **包名与身份收尾**（打包前、门禁保护下，一步做完，不与删除混在同一变更）：包名前缀 `@dsh-desktop/*` → `@deskwork/*`、根包名 → `deskwork`、`appId` 定稿；`binName`/`cliName`/`rendererPartition` 一并评估定案 | `pnpm check` 绿                                          |

### 第四段 · 工作台（每步一个独立可验收的插件，按依赖排序）

| 步  | 工作台         | 验收                                                                                                                      |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 8   | identity-local | 身份服务存在，且被后续工作台正确消费（它是 library/projects 的运行时前置——调研结论，此步顺带验证）                        |
| 9   | library        | 导入本地目录；修订钉死（源文件更新后历史引用不漂移）；检索与预览可用；配额与防护负例通过                                  |
| 10  | skills         | **先读上游 `packages/skill` 的 loader 源码、先写目录条目名与 loader 解析名的契约测试**（workdsh 在这里踩坑最密），再动 UI |
| 11  | experts        | 发布冻结后不可变；旧发布可为新引擎重编译而不变异                                                                          |
| 12  | projects       | 项目只聚合引用，不复制权威数据                                                                                            |
| 13  | activity       | 原生任务与子代理活动流；每会话用量摘要                                                                                    |
| 14  | connectors     | MCP 连接可用；会话内显式勾选生效                                                                                          |

### 第五段 · 交付物层

| 步  | 做什么                                                                                                                         | 验收                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| 15  | office 交付物层（"工作副本"模型，技术栈对标见蓝图 §6.2）：Word → PPT → HTML → PDF → 表格。与第 2、9 步同级，是数量级更大的工作 | 每档按声明标准做端到端往返校验；表格档标注实验性 |

## 6. 每步纪律

1. 一次只改一件事，改完立刻真跑一遍，拿真实结果说话。
2. 卡住就贴原始报错和行号；不写"可能 / 多半 / 预计"。
3. 超过 5 分钟的步骤，动手前先问（按本方案，步 2b、7 前置、7、9、15 都会超）。
4. **没有得到明确许可，不开分支、不写提交、不写文档、不开始执行**——每一步都等明确指令。
5. 不出"A 还是 B"选择题；能判断的自己判断并写明理由（home 路径、2b 的插入位置即如此）。
6. 做完一步停下报结果，不附带长总结。

## 7. 中止条件

- 第 2 步：`pnpm install` 装不上，或 typecheck 失败面超出"逐个修接口"的量级 → 停下报原始错误，不硬改。
- 第 3 步：Host 在隔离 home 里起不来，且定位不到根因 → 停，不带病往下做。
- 删除类步骤（2b(c)、7 前置）做完 `pnpm check` 不绿且短时间定位不到 → 回退该步（git 可整体还原；提交仍需许可）。
- 步 2 与 2b 之间 `check:docs` 红是**已知中间态**（步 2 动作列有说明），不是中止信号；2b 落地后必须转绿。
- 任何一步触碰真实 `~/.dsh` → 立即停。

## 8. 知识来源与未验证声明

| 内容                                               | 来源                          | 状态                                                                            |
| -------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| 导入面只有 `healProfilesModuleFallback` 消失       | 新旧 `.d.ts` 导出集比对       | 已核实，但是**下界**（未查 subpath 与运行期导出；install/typecheck 会暴露剩余） |
| 第二次启动会被旧准入拒绝                           | `preflight.ts:44-75` 代码核实 | 已核实                                                                          |
| cordis `ctx.provide` 先于 `ctx.set`                | 隔离实测                      | 已核实                                                                          |
| rc.2 上非模板 profile 能启动并渲染官方 UI          | 隔离 home 实测                | 已核实（仅 CLI 路径，非本壳路径）                                               |
| 本壳在 0.1.7-rc.2 下能启动                         | —                             | **未验证**（第 3 步回答）                                                       |
| 侧栏 / UI slot 机制                                | 对参考项目的调研              | **未在本仓库验证**（第 4 步回答）                                               |
| identity-local 是 library 与 projects 的运行时前置 | 对参考项目的调研              | **未在本仓库验证**（第 8 步回答）                                               |
| 各工作台的功能范围与验收标准                       | 对参考项目与竞品的调研        | 方向性，非实测                                                                  |
| office 各档的保真标准                              | 竞品对标                      | 方向性，非实测                                                                  |

## 9. 审查记录（两轮 × 五遍，2026-09-28）

**第一轮（针对原草案与本方案初版，产出 v2）**

| 遍  | 视角           | 发现并已修订                                                                                                                                                                                                                                                                                                                                                                   |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 事实核对       | 逐条对照代码坐实：二次启动拒绝机制（`preflight.ts:44-60`）、准入每次启动都跑（`recovery-controller.ts:189`，故升级后 `smoke:conversation` 等现有测试自己会红，2b 位置比原案更紧是对的）、userData 钉死点（`main.ts:110`）、`inspect-home` 包外无消费者                                                                                                                         |
| 2   | 删除爆炸半径   | 方案漏排的隐藏依赖：`test:unit` 串着 `release-evidence.test.mjs`（`package.json:44`）、`verify-docs.mjs:35` 写死待删脚本、`ci.yml:101` 跑 `verify:artifacts`、`plugin-intake.mjs:21` 依赖 `tests/helpers/upgrade-fixture.mjs`（不可删）、`verify-release.mjs` 是被删步骤的编排器必须一并删并重写 development.md §9；`HOME_FORMAT_*` 错误码与 `reserveHomeWrite` 的保留边界补明 |
| 3   | 顺序与依赖     | 2b 独立成步且在真启动之前（不并入步 2，守住"一次只改一件事"）；7 前置必须在任何 CI 触发前完成；步 2 验收不含集成套件；步 1 与 7 前置的文档更新分两波，不合并大重写                                                                                                                                                                                                             |
| 4   | 自欺与范围     | **home 路径改判**：`~/Library/Application Support/Deskwork/dsh` 与 Electron userData 嵌套，应用级重置会静默毁掉 sessions/credentials，且违背数据布局的分离原则 → 改为 `~/.deskwork`；包名前缀改名显式列入"暂不动"；确认 2b 非范围膨胀（原方案 §3 本就要求）；步 1 文件面清点后维持"一步改完"                                                                                   |
| 5   | 可执行性与纪律 | 每步验收补齐（2b 两次启动、7 前置 check 绿）；中止条件补删除步回退一条；超 5 分钟的步（2b、7 前置、7、9、15）执行前先打招呼；全部提交仍需明确许可                                                                                                                                                                                                                              |

**第二轮（针对本文 v2，产出 v2.1）**

| 遍  | 视角             | 发现并已修订                                                                                                                                                                                                                                                                                      |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 一致性与引用精度 | 2b 保留集与代码签名吻合（`reserveHomeWrite` 接 `decision`，marker 空 formats 解析允许：`home-admission.ts:42-55`、`home-marker.ts:157-167`）；共享叙事引用由"协议 §5"改判"协议 §1 目标句"                                                                                                         |
| 2   | 步 2 隐藏工作面  | 最大发现：`compatibility-policy.json` 的 formats 证据被 `generate-compatibility.mjs:115-140` 机器校验钉死在 0.1.2-rc.1，引擎升级后生成器直接抛错、`check:docs` 无法靠再生成修复 → policy `formats[]` 清空归 2b(a0)；`build/upstream-artifacts.json` 与 `docs/upstream-baseline.md` 的更新补进步 2 |
| 3   | 删除/保留边界    | policy `formats[]` 从"暂不动"改判为准入体系一部分（随 2b 走）；更正上轮"acceptance-runtime 将成孤儿"的误判——三个保留 smoke 在用它；`parseReleaseManifest` 空 formats 容忍度列为 2b 确认点；electron-builder 读 PRODUCT 无硬编码（`electron-builder.config.cjs:50-51`）                            |
| 4   | 自欺与范围       | 旧名字面量量化（11 处非测试代码、7 文件，含 3 个保留 smoke 的名字断言）写进步 1；步 7 的开放式"是否此时改包名"收敛为独立步 7b；`tests/upgrade/rehearsal.mjs` 的命中随 7 前置删除不扫                                                                                                              |
| 5   | 可执行性与纪律   | 中止条件补"步 2 与 2b 之间 `check:docs` 红属预期"；隔离夹具禁入清单加 `~/.deskwork`；超 5 分钟清单不变（2b 因 (a0) 更超）                                                                                                                                                                         |

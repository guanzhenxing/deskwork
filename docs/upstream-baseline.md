# Upstream Baseline

- 相关文档：[路线图](roadmap.md)、[兼容性清单](compatibility.json)
- 机器可读事实：[build/upstream-artifacts.json](../build/upstream-artifacts.json)、[build/compatibility-policy.json](../build/compatibility-policy.json)
- 校验门禁：`pnpm verify:dsh-closure`（lockfile/清单侧）、`pnpm verify:runtime-tree`（staged 闭包侧）、`pnpm verify:patches`（补丁账本）

## 1. DSH 基线

| 事实        | 值                                                         |
| ----------- | ---------------------------------------------------------- |
| 上游 tag    | `dsh-v0.1.7-rc.2`                                          |
| 上游 commit | `477b4f420553e8a52c2fbccc464d7561b239c443`                 |
| npm 版本    | `0.1.7-rc.2`                                               |
| 消费方式    | 官方 npm 发布包，逐包精确 pin；零 fork release、零本地补丁 |

证据链接：

- Tag：<https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.7-rc.2>
- Commit：<https://github.com/deepseek-ai/deepseek-harness/commit/477b4f420553e8a52c2fbccc464d7561b239c443>
- npm tarball：<https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.7-rc.2.tgz>（integrity 记录于 upstream-artifacts，lockfile 逐包 integrity 由 `verify:dsh-closure` 对照）

红线：DSH 包逐包精确 pin；catalog/overrides/lockfile 由脚本校验，禁止手工漂移；本地补丁不得隐式引入。

## 2. 独立版本包与 singleton

| 包                    | 版本           | 分类                                                                                |
| --------------------- | -------------- | ----------------------------------------------------------------------------------- |
| `@deepseek-ai/cordis` | `4.0.4`        | 独立版本轴，**不是** DSH 版本；按本表声明值检查，绝不按 `@deepseek-ai/*` 前缀推断   |
| `react`               | `18.3.1`       | 第三方 UI singleton，版本随上游 peer 约束记录                                       |
| `@deepseek-ai/dsh`    | `0.1.7-rc.2`   | DSH runtime 本体                                                                    |

singleton 规则：整个闭包（lockfile 与每个 staged closure）中每个受监视包只允许一个版本；Host runner（host-supervisor）与 normal bundle（desktop-plugin）是解析锚点，实测必须解析到同一 store 实例。Safe Mode bundle（desktop-recovery-bridge）由 Host 的 cordis loader 加载、自身零 Node import——它的保证来自闭包级唯一性 + 必备文件清单（含 `cordis.patch.yml`），不做解析探测。Node CLI 与 Electron Host 允许各持一份依赖树，但 native ABI 分别以 bundled Node / Electron 验证（`verify-runtime-tree`），两闭包间禁止 symlink 逃逸。

## 3. 本地补丁账本（三问审查）

[patches/manifest.json](../patches/manifest.json) 是显式空数组：本项目当前**没有任何本地补丁**，运行时闭包是纯上游 npm 制品。因此三项审查（上游是否已修、能否干净应用、移除补丁是否复现失败）对每个条目空缺；`verify:patches` 校验账本 schema、字段完整性与 baseline commit 绑定。引入任何补丁前必须先补齐 `id/file/upstreamCommit/reason/testCommand/status` 并附回归测试证据。

## 4. 基线升级流程

上游升级只由真实信号触发（新 tag、影响本项目的 bug/安全问题/格式变化、真实使用需求），不由任何外部桌面项目的节奏代替判断。出现新 tag 时：

- 真实升级在独立候选分支 `chore/upgrade-dsh-<实际标签>` 上更新 tag/commit/闭包并演练，与功能分支严格隔离；流程见[升级指南 §5](upgrade-guide.md)；
- 演练以已验证基线制品（冻结于 `release/baselines/`）→ 新候选完成：历史保留、第三方 bundle 不被触碰、降级/未知格式拒绝负例必须通过；
- 升级失败不阻塞其他交付，回退保留已验证基线；
- 涉及不可逆数据迁移的上游版本（例如改动 Session 持久化所有权并写入 Session v2 的版本线）属后续独立迁移资格计划，不并入常规升级。

当前基线 `dsh-v0.1.7-rc.2` 由此前的 `dsh-v0.1.2-rc.1`（commit [`a66e4702047846cdaa10c66c9d3df3951f5ea70d`](https://github.com/deepseek-ai/deepseek-harness/commit/a66e4702047846cdaa10c66c9d3df3951f5ea70d)，其自身演进自 `dsh-v0.1.2-alpha.3`（commit [`dd6322d604e00eec1ba0e0c8541159906a21094a`](https://github.com/deepseek-ai/deepseek-harness/commit/dd6322d604e00eec1ba0e0c8541159906a21094a)））演进而来；本次升级随 Deskwork 产品转向一并执行，module-resolution 文件物化被上游替换为进程内 runtime interception（`createRuntimeResolution` + `PluginPackages` 服务）。

## 5. 工具链出处

| 工具     | 版本    | 出处与校验                                            |
| -------- | ------- | ----------------------------------------------------- |
| Node     | 24.11.1 | nodejs.org 官方 SHASUMS256.txt 逐项核对（staging 时） |
| pnpm     | 11.7.0  | npm 官方 tarball + 固定 integrity（stage-runtime）    |
| Electron | 44.0.0  | launcher devDependency，经 pnpm-lock integrity 解析。上游 `node-addon-require-builtin@0.1.6` 按 Electron 版本精确白名单校验运行时指纹（43.0.0 / 44.0.0 / 45.0.0-alpha.6），44.1.0 不在列，故锁定 44.0.0 |

## 6. 外部参考实现（固定版本）

以下外部桌面项目只作为实现参考：不是本项目的依赖、升级信号、兼容性门或运行时基线。参考点固定在所阅读的提交上，避免以后把这些项目变化后的代码误当成当初的依据。

| 项目                                                      | 固定参考点                                                                                                                                                                                            | 参考范围                                                                      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) | commit [`e71a9ef0b168763d422042835a8c3b7d6d809800`](https://github.com/anywhere-labs/dsh-desktop/commit/e71a9ef0b168763d422042835a8c3b7d6d809800)（2026-08-30 master HEAD，晚于 v2.0.4 tag `d29bf7a`）                              | Desktop 插件/launcher 边界、profile 修复、Electron 生命周期、打包与平台适配   |
| anywhere-labs vendored DSH runtime                        | [`dsh-v0.1.2-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.2-alpha.1)，upstream commit [`cd5ef8148158c3a752a658978873241fdf8e2bbc`](https://github.com/deepseek-ai/deepseek-harness/commit/cd5ef8148158c3a752a658978873241fdf8e2bbc) | 只用于理解其当时的兼容性处理，不作为本项目 DSH 基线                           |
| [dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop) | commit [`07fd40a2a9301fd34672931faeb37d1ddbe67538`](https://github.com/dataelement/dsh-desktop/commit/07fd40a2a9301fd34672931faeb37d1ddbe67538)（2026-08-31 main HEAD）                                                                 | 独立 Host 进程监督、Safe Mode、插件 generation、配对 bridge、更新状态机与打包 |
| dataelement vendored DSH runtime                          | [`dsh-v0.1.2-alpha.1`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.2-alpha.1)                                                                                                        | 只用于理解其协议适配与 generation 实现，不作为本项目 DSH 基线                 |

记录规则：

- 后续只有在实际查阅新的外部代码并采用了其中思路时，才更新这张记录；
- 外部项目的 PR、release 节奏和测试结果不是本项目的升级信号或放行条件；
- 本项目采用架构模式，不复制外部实现；若以后直接移植 dataelement 的代码，必须按其 [MIT License](https://github.com/dataelement/dsh-desktop/blob/07fd40a2a9301fd34672931faeb37d1ddbe67538/LICENSE) 保留版权和许可声明，并在本仓库的依赖/NOTICE 记录中注明来源。

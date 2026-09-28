# 插件引入（Plugin Intake）工作流

- 实现入口：`scripts/plugin-intake.mjs`（纯校验器）、`tests/smoke/plugin-intake.mjs`（打包制品级演练）、`pnpm verify:plugin-intake`

## 1. 引入是什么、不是什么

引入（intake）是把一个第三方 bundle 纳入本产品信任边界的**审查与验证**流程：声明式记录 + 逐字节校验 + 隔离演练。它**不是**安装，也**不是**启用：

- 引入不把插件装进任何用户的 profile；
- 引入不改变默认 profile 的任何字节（演练以摘要对比证明）；
- 引入不构成插件市场、远程分发或自动更新——这些都不在当前范围。

## 2. 引入记录（intake record）

记录是一个 JSON 文档（schema 1），逐字段对应校验器 `validatePluginIntake(record, bundleRoot, releaseManifest)` 的检查：

| 字段                  | 语义                                                    | 校验                                               |
| --------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| `schemaVersion`       | 恒为 1                                                  | 否则拒绝                                           |
| `package` / `version` | bundle 的 npm 身份                                      | 必须与 bundle `package.json` 逐字一致（漂移即拒）  |
| `source`              | 出处；当前只接受 `{kind:'repository', commit:<40-hex>}` | 未知出处拒绝                                       |
| `integrity`           | `sha256-<base64url>` 的 bundle 目录摘要                 | 与磁盘字节重算值必须一致                           |
| `license`             | SPDX 声明（存在性）                                     | 缺失拒绝；不做合规判断                             |
| `capabilities`        | 声明的能力清单（字符串数组）                            | 形状校验                                           |
| `validatedPlatforms`  | 已在哪些平台完成打包级验证                              | 必须包含当前 `platform-arch`，否则“无打包证据”拒绝 |

目录摘要算法：按排序后的相对路径枚举常规文件（symlink 与特殊文件一律拒绝），对每个文件喂给哈希器“相对路径 + NUL + 文件 SHA-256 十六进制 + LF”；顶层 `*.intake.json` 排除在外（记录不能为自己声明的摘要背书）。空 bundle 的摘要恒为 `sha256-47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU`。

额外硬性拒绝：bundle 自带 singleton 依赖（react / cordis / dsh——整个闭包只允许一份）；bundle 声明安装期生命周期脚本（preinstall/install/postinstall 等）。

## 3. 工作流

1. **建记录**：为候选 bundle 写 intake 记录，`integrity` 用 `bundleDigest()` 从实际字节计算。
2. **审查**：人工过记录与 bundle 内容（出处、许可证、能力声明）。
3. **隔离验证**：`validatePluginIntake` 在任何 staging 之前跑通；拒绝时按 `PLUGIN_INTAKE_*` 错误码处置，修复后重来。
4. **打包级演练**：`pnpm verify:plugin-intake` 用安装候选制品复演——记录校验 → 经候选自己的 `plugin --profile <新名> add` 流程把合成 fixture 只装入全新临时 profile → 对 staged 字节复验摘要（含加载器将导入的 bundle 模块与 profile 补丁层）→ **在该 intake profile 上经候选 CLI 完成一个真实回合（fail-closed 门）** → 默认 `desktop` profile 摘要前后逐字节一致。fixture bundle 是可加载的（`main: index.js` + 惰性 `apply()`，无副作用以保持摘要确定）。**当前状态（如实）**：启动轮是必经门、不可跳过——它受上游两处限制阻断（全新非模板 profile 无法完成回合的上游缺陷、嵌入式运行时 loader 按包名从自身位置解析导致 app bundle 内 loader 走不到 profile `node_modules` 的布局断链），因此该命令在限制解除前**保持失败**，而不是口头注明后返回成功。Host 图上的 bundle 加载行为由 host-runner 集成测试覆盖。上游修复或设计落地后本门应自动转绿，无需改动。
5. **入册**：记录与演练证据归档后，该 bundle 才具备被（人工）安装到真实 profile 的资格。

## 4. 边界

- 校验器只读：不写 profile、不碰任何真实 home。
- 演练全部使用临时 home / 临时 profile / 安装副本。
- 本产品不提供插件市场、远程注册表或签名链——引入的信任来源是记录里的出处 commit 与逐字节摘要，责任在审查者。

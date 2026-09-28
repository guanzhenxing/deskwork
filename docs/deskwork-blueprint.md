# Deskwork：产品与实现蓝图

- 状态：草案（设计记录，未进入实现；产品已定名 Deskwork，中文"案头"）
- 日期：2026-09-27
- 性质：新产品方向的设计说明；本文不改变本仓库 v0.1.0 的范围与承诺
- 相关文档：[upstream-baseline](upstream-baseline.md)、[upgrade-guide](upgrade-guide.md)、[plugin-intake](plugin-intake.md)

## 1. 背景与决策

本仓库于 2026-09-08 发布 v0.1.0 后封版。官方 DeepSeek Harness（DSH）上游随后提供官方桌面应用（`apps/desktop`、`apps/desktop-host`），"为官方 Web UI 提供原生壳"这一本仓库的原始定位不再成立。

新决策：参考社区项目 techflag/workdsh 验证过的路线，构建一个 WorkBuddy 式的本地 AI 工作台，定名 **Deskwork**（中文"案头"）。约束与取向：

- 不以成本为决策变量，按完整产品功能规划；
- 上游 DSH 升级由本项目自行跟进，沿用本仓库已验证的升级纪律；
- 本仓库的壳层资产（进程监督、恢复、lease、准入、发行证据）作为新产品的差异化基础继承。

## 2. 参考项目固定观察点

仿照 [upstream-baseline](upstream-baseline.md) 的记录规则，外部参考固定在实际阅读的提交/发布点上，避免把参考项目后续变化误当成当初依据：

| 对象             | 固定观察点                                                                | 用途                                                                         |
| ---------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| techflag/workdsh | main @ 2026-09-26（desktop-v2.0.6-alpha.1 与 web v0.1.0-alpha.14 发布日） | 产品功能面、Profile 组合模型、发布门禁                                       |
| 上游 DSH         | `0.1.7-rc.2`（workdsh `upstream.json` 记录 commit `477b4f42`）            | cordis 插件机制、官方文档集（cordis-primer、capability-seams、module-graph） |
| 官方 DSH 桌面    | 上游 `apps/desktop` README（master 分支）                                 | 确认官方桌面独占 `profiles/desktop`、不支持第三方 profile                    |

两个事实性备注：

- workdsh 的 main 分支并入了上游 DSH 完整 git 历史，其贡献者统计不代表该项目实际开发者；实际开发者为 techflag 一人；
- 官方桌面独占 `$DSH_HOME/profiles/desktop`，CLI 不能启动或改动该 profile，也没有运行第三方 profile 的机制。workdsh 的支撑服务包以 private manifest + Profile 布局刻意排除在插件管理器之外，因此"官方桌面 + 单装它的插件"拿不到完整能力；这也限定了 Deskwork 必须拥有自己的 Profile。

## 3. 产品定义

一句话：**资料 → 项目任务 → 专家/技能/连接器 → 可检查、可编辑的成果**，全部本地运行（本地指数据与编排在本机；模型调用按用户配置出网）。

三条铁律（继承 workdsh 验证过的架构判断）：

1. **壳薄**：Electron 只做窗口、拉起本机服务、打包，不含任何产品逻辑；
2. **产品全在插件层**：所有功能是 DSH Profile 里的 cordis 插件；壳可换、Web 线可用、上游升级不伤筋动骨；
3. **上游零改动**：DSH 精确 pin（submodule 或逐包 npm pin，二选一后在 `upstream.json` 式单一事实源中声明），版本对齐检查不过不发版。

### 3.1 命名与标识约定（2026-09-27 定名）

| 项                     | 值                                                   |
| ---------------------- | ---------------------------------------------------- |
| 产品名                 | Deskwork                                             |
| 中文名/副题            | 案头 —— 基于 DeepSeek Harness 的本地 AI 工作台       |
| 仓库名                 | deskwork（本仓库已自 deepseek-harness-desktop 更名） |
| 包名前缀               | `@deskwork/*`                                        |
| Electron userData 目录 | `Deskwork`（固定，不随展示名变更）                   |
| DSH Profile 名         | `deskwork`                                           |

命名边界：

- 不将 DeepSeek 品牌词放入产品名；生态信号通过副题与文档表达，保持"未获官方背书"声明；
- 与 workdsh、WorkBuddy 保持名称距离；
- 撞车核查（2026-09-27）：Deskwork 仅有同名小型实验仓库（Claude computer-use demo）；中文"案头"仅有未上线的参赛创意；国内营销语境中"案头工作"已是该品类的通用描述（千问办公、OpenClaw 均如此表述）。

## 4. 功能全景

### 4.1 五大工作台（产品 bundle，对外可见）

| 模块   | 功能点                                                                                                                              | workdsh 现状 |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 项目   | 集中管理任务、计划、资产、活动记录；会话中选择项目能力；任务引用资料库的指定修订（pinned revision，历史任务不随源文件漂移自动切换） | 已发布       |
| 资料库 | 本地目录导入与浏览、全文检索、文件预览（Markdown/TXT/HTML/PDF/Word/PPT）、选定修订引用进任务、从引用直接发起会话                    | 已发布       |
| 专家   | 专家配置（角色/方法/头像）；制作→草稿→评审→发布冻结修订的生命周期；专家团队；内置只读专家复制为"我的专家"                           | 已发布       |
| 技能   | SKILL.md 管理、启用/禁用、任务内斜杠命令；ZIP/SKILL.md 导入；SkillHub 目录（图标/搜索/分页/源链接/版本/托管安装）                   | 已发布       |
| 连接器 | MCP 服务配置，任务中显式勾选启用哪些能力                                                                                            | 已发布       |

### 4.2 支撑服务（Profile 内私有，不出现在插件管理器）

| 模块            | 功能点                                                                                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| office          | 交付物"工作副本"的实时预览与编辑：Word（Tiptap + TableKit/Image、DOCX 导入导出、AI 实时共写侧栏）、PPT（React PPT 编辑器 + pptx-viewer）、表格（Univer/ExcelJS，实验性）、HTML（任务浏览器实时预览）、PDF（PDF.js + pdf-lib） |
| activity        | 紧凑工作动态流：原生任务与子代理活动                                                                                                                                                                                          |
| browser-session | 受管浏览器：agent 驱动的网页出现在右侧任务浏览器，与 Playwright MCP 共享同一个 Electron 页面（不打包第二份浏览器）；附件/输入/发送走 Harness 原生能力                                                                         |
| identity-local  | 本地身份                                                                                                                                                                                                                      |
| access          | 访问控制                                                                                                                                                                                                                      |
| audit           | 审计事件                                                                                                                                                                                                                      |

### 4.3 生态接入

- SkillHub（skillhub.cn）与 dsh-market（dshmarket.com）双目录：只读 catalog 客户端 + 安装走官方 `dsh plugin` 生命周期 + 校验和 + 兼容性过滤；
- 两个目录均为第三方、条目无预审无背书；Deskwork 在此之上叠加强化审查（见 6.2 与第 8 节的插件引入资产）。

### 4.4 参考项目在库未发布模块（功能扩展路线）

workdsh `packages/plugins/` 下共 18 个插件包，已发布 9 个；在库未发布的 9 个为：`admin`、`applications`、`automations`、`identity`、`model-policy`、`pages`、`tables`、`usage`、`workbench`。从命名推断其路线为治理三件套（admin/usage/model-policy）、自动化任务（applications/automations）、更多文档形态（pages/tables）与整合工作台（workbench）。Deskwork 的功能规划把这层计算在内。

### 4.5 壳与桌面层（本仓库独有资产，workdsh 没有）

- Host 进程监督：Host 崩溃壳存活，进入带结构化诊断的恢复窗口；
- Safe Mode：不加载正常插件与第三方 bundle 的最小恢复会话；
- 逐文件修订事务的 profile 恢复（有界重试预算）；
- home lease：Desktop 与 CLI 顺序共享同一 DSH home（workdsh 采用独立 profile 回避此问题，是否保留共享 home 是新产品需显式决策的选项）；
- home 兼容性准入：跨版本数据 epoch 与格式预检，未知格式与不安全降级写入前拒绝；
- 发行证据链：schema-2 发行清单、确定性 SBOM、许可证清单、DMG 摘要绑定、安装级冒烟与升级/降级演练。

## 5. 技术底座

### 5.1 cordis 机制要点（据上游官方 cordis-primer）

- **插件 = 实现 Service 的对象**：带可选 `inject` 与 `apply(ctx)` 的函数，或 Service 子类；生命周期由框架挂载进当前 context；
- **Context = 服务仓库**：服务认领稳定键（如 `ctx.tools`、`ctx.llm`、`ctx.sessions`），消费者按键定位而非 import 实现；这是"业务模块各自拥有领域数据"的基础；
- **依赖注入声明式排序**：`inject` 声明所需服务，加载顺序自动跟随服务依赖，无需手工编排启动序列；
- **五类定型事件**：`emit`（不等待）/ `waterfall`（环绕中间件，可改写或短路）/ `parallel` / `serial` / `bail`（一个处理即止）；策略类拦截用 waterfall 短路，注解类监听必须透传；
- **可逆注册**：所有注册（prompt 段、工具 schema、适配器、监听器）走 `ctx.effect()` / `ctx.on()`，带 disposer，重载/卸载自动回滚；
- **UI 插槽**：产品界面通过 UI slot 注册进官方 Web UI，五大工作台出现在同一界面的机制。

### 5.2 Profile 组合模型（workdsh 的关键设计）

```text
Profile（产品名）
 ├── 直接依赖：5 个产品 bundle（projects/library/experts/skills/connectors）
 ├── 可选运行时依赖：office/activity/audit/access/identity-local/browser-session
 │    （manifest 标 private + Profile 布局 → 从插件管理器隐藏）
 ├── cordis.patch.yml：激活支撑服务条目 + 组合客户端
 └── 整合 bundle：只做导航与展示组合，不拥有业务数据
```

## 6. 实现蓝图

### 6.1 工作区结构

```text
deskwork/
├── deepseek-harness/          # submodule，零改动；upstream.json 式单一版本事实源
├── packages/
│   ├── contracts/             # 跨插件类型与协议
│   ├── bundle/                # 整合包：导航、布局、工作台路由
│   ├── plugins/
│   │   ├── projects/  library/  experts/  skills/  connectors/
│   │   ├── office/  activity/  audit/  access/
│   │   └── admin/  usage/  model-policy/  automations/  pages/  tables/  workbench/
│   └── providers/
│       ├── browser-session/
│       └── identity-local/
├── runtime/profiles/deskwork/ # Profile 组装（cordis.patch.yml + 依赖清单）
├── apps/desktop-carrier/      # 薄壳：窗口、拉起 dsh --profile deskwork --no-open、token URL 加载
├── scripts/                   # 安装器、版本对齐检查、afterPack 门禁
└── tests/                     # 集成 + 每工作台验收（projects/library 专测）
```

### 6.2 关键模块实现要点

- **每个工作台**：独立 cordis 插件包，各自认领 `ctx.<domain>` 服务键 + 注册 UI 插槽 + 领域数据自持；跨模块只通过 contracts 里的定型事件交互（引用修订走 waterfall 事件，权限拦截用短路返回）；
- **office**：技术栈对标——Tiptap（TableKit/Image）做 Word 共写、`docx` 做导入导出、React PPT 编辑器 + pptx-viewer、Univer/ExcelJS（标注实验性）、PDF.js + pdf-lib。"工作副本"模型：交付物 = 会话产出的可编辑副本，AI 写入侧栏、人直接改正文、导出为标准格式；
- **skills**：workdsh 踩坑最密的区域（其一上午连发六个修复才对齐）：按官方 DSH skill name 管理条目、安装校验与上游 loader 行为对齐、skill roots 隔离、分类取真实值。实现前先读上游 `packages/skill` 的 loader 源码，不按 SKILL.md 文件名想当然；
- **browser-session**：两种实现选择——(a) workdsh 式：Electron 隐藏页 + Playwright MCP 经 CDP 连到该页，零额外浏览器但与壳耦合；(b) 独立受管 Chromium 实例，解耦但进程与体积代价高。取 (a)，但把接缝收进 provider 包内，不渗入其他插件；
- **生态目录**：SkillHub/dsh-market 只读 catalog 客户端；安装走官方 `dsh plugin` 生命周期 + 逐字节校验（复用本仓库 plugin-intake 的审查工作流与制品级隔离演练思路）+ 兼容性清单过滤；
- **identity/access/audit**：Profile 内部服务，经 `cordis.patch.yml` 激活，不做可单独管理的插件。

### 6.3 组合、门禁与打包

- **运行时门禁**：Profile 准备阶段现场启动插件管理器，`listBundles()` 必须恰好返回 N 个产品包；Electron `afterPack` 用打包产物内的 Node 和 Profile 重跑同一检查；安装级验收必须操作真实流程（源码级包数或配置转储成功不能证明运行时结果）；
- **打包红线**：`app.asar` 只有 Electron 入口，无第二份 `node_modules`；Node 可执行文件同时供 Host 和 office 技能使用；安装包内置 Node + Python；
- **双发布线**：Web/插件线（每包独立版本 tgz + `install-workdsh.mjs` 式安装脚本 + SHA256SUMS）与桌面线（Windows x64 Setup + macOS 双架构 DMG）；桌面线发版前对着同 commit 的 Web 线候选做交叉验证。

### 6.4 里程碑

| 阶段   | 交付                                                            | 验收                         |
| ------ | --------------------------------------------------------------- | ---------------------------- |
| 阶段一 | Profile 骨架：pin + 整合 bundle + 1 个空工作台出现在官方 Web UI | `listBundles()` 门禁跑通     |
| 阶段二 | skills + library（含检索/预览/修订引用）                        | 与上游 skill loader 对齐测试 |
| 阶段三 | experts + projects + activity                                   | 修订冻结不漂移的回归测试     |
| 阶段四 | office（Word→PPT→HTML→PDF→表格）                                | 按格式分档的端到端往返校验   |
| 阶段五 | connectors + identity/access/audit + browser-session            | 受管浏览器与 MCP 共存验证    |
| 阶段六 | 生态目录接入 + Web 插件线发布                                   | 校验和 + 兼容性过滤          |
| 阶段七 | 桌面壳：继承监督/恢复/Safe Mode/lease/准入                      | 本仓库 smoke 套件复用        |

### 6.5 上游 DSH 升级跟进

沿用本仓库 [upgrade-guide](upgrade-guide.md) 的纪律，适配为新产品形态：

1. 单一 pin（`upstream.json` 式事实源）；
2. 候选分支更新 tag/commit/闭包；
3. 全量门禁（typecheck/test/check:versions 式版本对齐）；
4. 升级/降级演练（历史保留、第三方 bundle 不触碰、未知格式拒绝）；
5. 对齐检查不过不发安装包。

上游 0.1.x 自我声明会有破坏性变更；每次升级先 diff 官方 `capability-seams` 与 `module-graph` 两份文档再动手。

## 7. 技术风险（与成本无关）

1. **上游 rc 基线**：DSH 0.1.x 承诺破坏性兼容变更，升级是常态而非例外；
2. **技能系统对齐**：先读上游 loader 再实现，避免重复 workdsh 的连续修复；
3. **Office 保真**：任意 Office 文件保真未有任何项目完整验收过；阶段四验收标准按格式分档设定，Univer 路线按实验性标注；
4. **private 支撑包的隐藏是约定不是机制**：靠 manifest + Profile 布局实现，插件管理器升级后需回归验证仍然成立；
5. **browser-session 与 Electron 的耦合**：接缝必须封在 provider 包内，Web 线明确标注该能力降级。

## 8. 与本仓库的关系（资产映射）

| 本仓库资产                                     | 新产品用途                                   |
| ---------------------------------------------- | -------------------------------------------- |
| `packages/host-supervisor`                     | 壳层 Host 进程监督与恢复窗口                 |
| `packages/desktop-recovery-bridge` + Safe Mode | 最小恢复会话与第一方恢复桥                   |
| `packages/home-lease`                          | 共享 home 顺序互斥（是否启用为产品决策）     |
| `packages/profile-manager`                     | 逐文件修订事务恢复                           |
| `packages/release-compatibility`               | 兼容性准入与发行证据链（SBOM/清单/摘要绑定） |
| `scripts/plugin-intake.mjs` 审查工作流         | 生态目录安装的逐字节校验与制品级隔离演练     |
| `docs/upgrade-guide.md` 演练纪律               | 上游升级跟进流程（见 6.5）                   |

本仓库已更名为 deskwork（GitHub 同步更名），作为新产品的蓝图与资产库：旧 v0.1.0 实现整体保留，作为上表资产的回迁来源；重建按 6.1 的工作区结构推进，逐阶段替换旧实现。

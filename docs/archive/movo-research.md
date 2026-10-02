# MOVO 调研与 Deskwork 规划影响

- 状态：调研记录 + 规划建议。维护者已于 2026-09-29 裁决：技术注入全部采纳（并入 [蓝图 v2](deskwork-blueprint.md) §5.2 与 [执行方案 v2](deskwork-plan-v2.md) 对应步骤），方向性结论的采纳与修订逐条见蓝图 v2 §2.3（其中 §4 结论 3 与 §6.3 第 1/6 条被修订，第 2 条收窄）。按本文 §7 第 5 条，调研事实与既有结论不追溯改写
- 日期：2026-09-28
- 起因：公众号文章《基于 DeepSeek Harness，这个开源项目搭了一套可私有化的企业 Agent 平台》（mp.weixin.qq.com/s/46ut7729aD9v8QTnLVw_JA）介绍 MOVO，要求全面调研并结 Deskwork 现状做规划
- 调研方法：himovo/movo 源码浅克隆逐文件分析、官方文档站 17 个核心页面逐页抓取、GitHub API 与中文社区/媒体报道检索、与 [架构](architecture.md)/[数据布局](data-layout.md)/[上游基线](upstream-baseline.md) 对照

## 0. 固定观察点（仿蓝图 §2 规则）

| 对象 | 固定观察点 | 用途 |
| --- | --- | --- |
| himovo/movo | main @ 2026-09-28 浅克隆（最新 release v0.1.16，2026-09-21；runtime-host 锁 `@deepseek-ai/dsh@0.1.6-alpha.1`） | 竞品情报、架构参照 |
| himovo.com 文档站 | 2026-09-28 全量抓取（17 页） | 功能面与治理能力对照 |
| 公众号文章 | 2026-09 刊发 | 引入线索（内容已被源码与官方文档覆盖） |

本文所有 MOVO 结论均锚定在上述观察点，MOVO 后续变化不追溯改写本文。

## 1. MOVO 是什么

一句话：**把 DeepSeek Harness 包装成可私有化部署的企业级 Agent 平台的服务端产品**——DSH 跑 Agent，MOVO 管企业生产（组织、权限、知识、治理、审计、配额）。

- 主体：北京果然智汇科技有限公司；团队十年企业智能客服背景（AskBot），2025 年底产品化，获海纳亚洲 SIG 投资（36 氪 2026-09-15 报道）；2026-09-01 开源，四周内 7 个 release，v0.1.11→v0.1.16 节奏约每周一到三版
- 热度：173 star / 41 fork / 2 位贡献者（基本单人维护）；已有真实装机用户（issue 集中在沙箱多租户隔离、流式输出、Windows 客户端）
- 商业模式：开放自部署 + 商业许可——30 天全功能试用后导入 License；许可证为 Apache 2.0 附加条件（自称 MOVO Community License，非 OSI 开源）：禁多租户 SaaS、禁去品牌、禁 OEM 白标
- 双端形态：员工用户端（对话/任务/我的 Skills/我的知识/我的 Tools/定时任务/快捷入口）+ 管理端（组织/模型/知识/企业 Skills/工具与 MCP/配额/审计/统计/设置）
- MOVO Desktop（Electron 壳）闭源分发；Web 端功能对等

## 2. 技术架构深读（源码证据）

### 2.1 部署与服务拓扑

Docker Compose 共 12 个服务：`bootstrap`（一次性 secret 生成，umask 077 产 12 个随机密钥）、`mongo`(6.0)、`redis`(7.4)、`weaviate`(1.25)、`dsh-runtime-host`(Node)、`chat-api`(FastAPI, 8000)、`admin-api`(FastAPI, 8100)、`document-api`(8200)、`document-worker`(Celery)、`user-web`/`admin-web`(Vue 3)、`gateway`(nginx, 对外 3000)。内外双网络，数据库与 runtime-host 不直接对外。

代码量：chat-api 约 14 万行 Python（核心单体）、双前端合计约 7.5 万行、runtime-host 约 2900 行 Node、document-parser 约 3800 行；测试 280 个 Python 测试文件 + 27 个 node:test + 12 个前端契约测试。

### 2.2 DSH Runtime Host——与本项目同构的关键验证

MOVO **不 spawn CLI**，而是把 DSH 作为 npm 库进程内组装：

- 入口 `dsh/runtime-host/src/host.mjs`：`--host/--port/--storage-root/--auth-token-file`（token 读后即删），stdout 打印就绪 JSON
- 组装 `composition.mjs`：`dsh-app-boot` 的 `appBoot.boot('askai-dsh-host', profileRoot, [官方 base patch, 官方 web-app preset 隔离 patch, MOVO overlay])`——复用官方宿主启动协议，以 overlay 注入策略（禁 hmr、禁 session-title-llm、启用 JSONL 会话/设置/凭证/附件、企业预设不含本地代码与 Shell 工具、`includeUserRoot: false`）
- 隔离：每个 runtime 按 `isolationKey`（sha256 → 独立 storageRoot）隔离；会话经 `ctx.agents.create/resume`，用户输入包装为 `createUserMessage`，支持 `followup`/`steer`，强制 `temporalContext`
- 事件：`EventJournal` 游标重放 + `LiveAssistantStream` 活流还原，双投影

**与 Deskwork 的对照**：本仓库 `host-runner.ts` 的 `runDshHost`（utilityProcess 内 `boot()`、bundle 符号链接投影、`--host 127.0.0.1 --port 0 --no-open`）与 MOVO 是同一架构判断的独立实现。MOVO 四周企业化落地未见推翻此路线，是对本仓库既定路线的有力旁证。

### 2.3 协议与收权：冻结契约 + 双网关

- chat-api ↔ runtime-host：纯 HTTP + NDJSON 事件流（`GET …/events?after=cursor` 断线补拉、`event-stream` 2s 心跳）；Bearer `DSH_RUNTIME_HOST_TOKEN`（≥32 字符）；协议版本 `askai.dsh-host.v1` / `askai.execution-v3` 冻结管理，写进 `dsh/COMPATIBILITY.md`
- **双网关回环收权**：模型调用与工具执行都必须回到 chat-api（`/internal/dsh/model/generate`、`/internal/dsh/tools/execute`），host 本体零凭证——审计、配额、审批、幂等获得单点控制位
- Python 侧 `DshAgentKernelGateway` 实现 `AgentKernelContract`：**产品服务从不直接消费 DSH API，全部 DSH 兼容代码收敛在 runtime-host 一个适配层**

### 2.4 Skill 系统：编译为自适应 Skill，不是图引擎

- 定义模型（pydantic）：`DshSkillDefinition`（name 规则 `^[a-z0-9][a-z0-9-]*$`、content ≤100k、`kind: ordinary|workflow`、`source_scope: personal|organization`、`bundle_archive_base64`）+ 独立 `WritingStyleDefinition`（写作规范）
- **可视化工作流 DAG 编译为中文 Markdown 自适应 Skill**，编译产物明确写入执行原则："这是供 DSH Agent Loop 使用的自适应 Skill，不是固定图执行计划……根据上下文决定跳过、重复或并行"。DAG 只做能力引用与权限校验（未授权工具 `PermissionError` fail-closed），不跑第二套确定性流程引擎
- 编译产物为不可变 Runtime Profile：内容 sha256 版本化、publish/activate/rollback/disable 全审计、单个坏 Skill 隔离跳过不拖垮租户、`synchronizer` 在回合边界把长对话切到新 Profile 而不中断
- ZIP 安装：`skill-bundle-materializer` 物化包内容 + `skill_resource_read` 工具按需读包内资源

### 2.5 MCP / 工具治理

- MCP 客户端走 Streamable HTTP（协议 2025-06-18，旧端点 400/404/405 自动降级）；JSON-RPC `tools/list` 发现、`tools/call` 执行、按子工具启用白名单
- **Schema 归一**：把 MCP 完整 JSON Schema 投影到 DSH 支持的确定性子集；无害元数据删除、服务端约束移除并报告；无法无损表达的构造**按子工具拒绝**（`McpSchemaCompatibilityError`）——fail-closed 而非静默丢约束
- 工具描述携带 `risk_level: read|write|dangerous`、审批策略、超时（fixed/activity 双模式）、幂等键、`delivery_mode`（model_synthesized / authoritative_markdown，后者产物绕过模型改写权威交付）
- 执行回执 `ActionReceipt`（状态、idempotency_key、business_key、replay_policy，running 超时回收）；断连即取消；敏感操作审批 broker 等待 240s

### 2.6 知识库 / RAG

- 解析：Docling（PDF 含 OCR 策略）+ LibreOffice 预览转换 + Celery 重试
- 分块：目标 750 token（400–1000、重叠 80），表格/图片各自成块；嵌入文本前缀标题路径与页码（contextual chunking）
- 检索：Weaviate 向量或混合（alpha 0.7）+ 可选 rerank + 去重；引用解析：模型返回 `used_chunk_ids` → `KnowledgeCitation`（文档/页码/标题路径锚点）+ 证据包
- **已知隐患**：Weaviate 内不承载权限，检索先按租户取回（扫描上限 1 万）再逐页鉴权过滤——数据量大时性能与越界面都放大

### 2.7 组织、审计与配额（Mongo 多租户）

`organizations`（租户）+ 员工 `end_users` 与后台 `admin_accounts` 双身份体系；部门树 `org_units`、岗位角色 `position_roles`；模型实例凭据加密存储；`org_quota_policies`/`user_quota_policies`/`token_usage_logs` 构成配额与成本观测；审计三类日志 + 不可变 `runtime_profile_versions` + `action_receipts` + 权威交付物登记。

### 2.8 供应链治理

`dsh/versions.lock` 逐包锁 tarball 地址、sha512 integrity、license 证据哈希 + SBOM；Dockerfile 内置"声明版本 ≠ 安装版本即失败"校验；CI 含每周定时 `dsh-upgrade-candidate`——**macOS runner 上隔离评估候选 DSH 版本，绝不在位变更活动 runtime**；保留回滚 train（0.1.2-alpha.2）。`COMPATIBILITY.md` 定义 7 项准入清单（创建-执行-取消-再执行-销毁-恢复等），明确要求**对真实组合而非 mock 验证**。

### 2.9 工程质量观察

优点：测试体量大且分层；升级治理文档化；secret bootstrap 严谨。问题：内部代号 `askai`/`gragentic` 遍布环境变量/路径/库名（闭源转开源的残留，理解成本高）；14 万行单体靠约定维持边界；ADR 仅 1 篇；Python 测试不在 CI 里跑。

## 3. 市场与生态（2026-09-28 数据）

| 项目 | star | 定位 | 许可 |
| --- | --- | --- | --- |
| DeepSeek Harness | 238,565 | Agent 运行时（MOVO 与本项目的共同底座） | MIT |
| n8n | 206,196 | 工作流自动化 + AI 节点 | fair-code |
| Dify | 157,408 | 低代码 LLMOps（画布编排 + RAG） | 修改版 Apache |
| RAGFlow | 91,427 | 深度文档理解 RAG | Apache-2.0 |
| FastGPT / MaxKB / Coze Studio | 2.2 万–3 万 | 知识库问答 / 可视化编排 | 各有商用限制 |
| MOVO | 173 | DSH 原生企业 Agent 平台 | 社区许可（非 OSI） |

判断：

1. 低代码画布与知识库问答两个位置已被重兵占据；MOVO 的差异化是反方向切入——先有自治 Agent 运行时（DSH），再补治理与企业壳，这是 DSH 出现后才可能的新空位；
2. "DSH 平台层"尚无统治者（DSH 本体 23.8 万 star、npm 周下载 49 万、生态目录 3362 条目，但平台化产品都在早期）；MOVO 是"DSH 上的 Dify"位置最早的卡位者之一；
3. MOVO 自身风险：单人维护、非标许可、桌面端闭源、绑 alpha 上游——企业采购会放大审视这四点；
4. 对 Deskwork 有参考意义的生态事实：Skill ZIP 已是 DSH 生态的事实分发格式（MOVO 的"标准 Skill ZIP"与 SkillHub/dsh-market 同源）， interoperability 是生态借力点。

## 4. 与 Deskwork 的定位关系

| 维度 | MOVO | Deskwork（蓝图既定） |
| --- | --- | --- |
| 形态 | 服务器端，Docker 12 服务 | macOS 本地单机 |
| 用户 | 企业全员（多租户、组织、岗位） | 单人，数据在自己手里 |
| 数据 | Mongo/Redis/Weaviate 服务栈 | 本地文件（`~/.deskwork`），无常驻服务端 |
| 产品逻辑位置 | Python 后端 + Vue 前端 | DSH Profile 内 cordis 插件（铁律二） |
| 桌面端 | 闭源 Electron 壳 | 开源薄壳 + 本仓库监督/恢复/lease 资产 |
| 治理 | 组织/配额/审计/审批全套 | identity/access/audit 私有服务（本地化轻量版） |

结论：

1. **不同生态位，不构成直接竞争**：MOVO 占"服务器端企业平台"，Deskwork 占"本地个人工作台"；两者共用 DSH 底座但架构约束相反（MOVO 需要多租户收权，Deskwork 铁律是壳薄、全插件、零上游改动）
2. **MOVO 的存在验证了赛道**：四周拿投资、有真实装机、生态注意力汇聚——"DSH 包装产品"是被资本与市场确认的位置，Deskwork 押注的生态红利成立
3. **不转向企业多租户**：那需要放弃三条铁律、引入服务栈与本仓库安全模型（无非回环监听）冲突，且该位置已有资本加持的先发者；Deskwork 的差异化恰是"本地、数据自持、开放"——与 MOVO Desktop（闭源）和官方桌面（独占 profiles/desktop、不支持第三方 profile）都不同
4. 未来若做 architecture.md 已预留的"单 Host 多客户端"远景，MOVO 的 principal/scope 与审计模型是现成参照，属远期而非现在

## 5. MOVO 对本仓库既有选择的验证

| 本仓库既有选择 | MOVO 侧对应 | 验证结论 |
| --- | --- | --- |
| host-runner 进程内 boot DSH（不 spawn CLI） | composition.mjs 同路线且已企业化落地 | 路线成立 |
| [host-control 1.0](protocols/host-control.md) 冻结协议 + 状态机 | askai.dsh-host.v1 / execution-v3 冻结 | 冻结协议是上游 rc 时代的必需品 |
| 真实组合冒烟（smoke 套件拒 mock 结论） | COMPATIBILITY.md 7 项真实组合准入 | 同一纪律 |
| 精确 pin + upstream-baseline + verify:dsh-closure | versions.lock + SBOM + 隔离评估 | 同向，MOVO 多走一步完整性锁（见 §6.3） |
| 修订事务/日志回滚（profile-manager） | 不可变 runtime_profile_versions + 审计 | 同向，可扩展到配置/Skill 产物 |

## 6. 规划：对执行方案 v2 的注入建议

原则：**不改 plan-v2 的步序、验收与纪律**（§2 已定的事不重开）；以下以"注记"形式注入对应步骤，采纳后由维护者合入 plan-v2；未采纳前不改变任何步骤内容。

### 6.1 既有步骤的技术注入点

| plan-v2 步 | 注入内容（源自 MOVO 实证） |
| --- | --- |
| 7b 包名收尾（未做） | MOVO 的 askai/gragentic 代号残留是"改名拖延成本"的活教材——环境变量、库名、路径遍布 14 万行代码。**建议提级：在 Segment 4 新包数量增长前完成 7b**，每多一个 `@deskwork/*` 新包，改名成本加一分 |
| 8 identity-local | 审计事件 schema 一步定型为五元组：主体/时间/对象/动作/结果，分类取 MOVO 四类审计的本地子集（管理操作、Agent 活动、权限拒绝——本地无"历史事件"归档需求）；principal 字段为"单 Host 多客户端"远景预留；access 服务同步定义资源动作清单与 `read/write/dangerous` 三级风险标记（connectors 步 14 消费） |
| 9 library | 引用锚点结构借鉴 `KnowledgeCitation`：文档 + 页码 + 标题路径，配合既定的 pinned revision 形成"历史任务不漂移且可回溯到原文位置"；修订/引用 schema 先写契约测试再动 UI；分块参数（750 token、重叠 80、标题路径前缀）记录为将来嵌入检索的默认参考，现在不实现；**吸取 MOVO 教训：权限过滤必须在查询期收敛（语料分域），不做取回后过滤** |
| 10 skills | 本步是 MOVO 借鉴密度最高处：① 采用"结构化定义 → 编译为 DSH 自适应 Skill"路线，**绝不引入固定图执行引擎**（MOVO 明确把"这不是固定执行计划"写进编译产物）；② 定义模型参考 `kind: ordinary/workflow` + 独立写作规范类型 + 命名规则与内容上限；③ 编译期能力引用校验 fail-closed（未授权工具直接拒绝，不留到运行时）；④ 编译产物不可变版本化 + 审计 + 回滚，复用 profile-manager 修订事务的思想建版本链，"旧发布可为新引擎重编译而不变异"（plan-v2 步 11 验收）天然成立；⑤ ZIP 安装走"物化 + 包内资源只读工具"模式，格式对齐 SkillHub/dsh-market 生态；⑥ 单个坏 skill 隔离告警，不拖垮整体加载 |
| 11 experts | "专家包 = 多个子 Skill 组合"的复合定义模型直接可采；专家 = 人设 + 能力引用集 + 组合 Skill，发布冻结即编译产物不可变快照 |
| 12 projects | 会话与能力集的绑定采用快照语义（MOVO `agent_kernel_bindings` + 回合边界切版本的思路）：任务引用的技能/连接器/资料修订在会话开始时定格，配置后续变更不漂移进进行中的任务——这是 pinned revision 语义在会话层的延伸 |
| 13 activity | 事件通道采用"活流 + 游标重放"双投影（活流即时、游标断线补拉）；每会话用量摘要对齐 MOVO token 统计的**个人观测视角**（只观测不配额——配额是企业能力，本地不做） |
| 14 connectors | ① Streamable HTTP（2025-06-18）+ 旧端点降级探测；② `tools/list` 发现 + 按子工具白名单；③ schema 归一为 DSH 确定性子集，无法无损表达的构造按子工具拒绝并报告被删约束（不静默丢）；④ 工具注册带风险三级/审批策略/超时（fixed 与 activity 双模式）/幂等键；⑤ 会话内显式勾选 = 会话级能力快照（与步 12 语义闭环）；⑥ dangerous 级操作经审批确认后执行（approval broker 模式，本地为 UI 确认而非服务端等待） |
| 15 office | 交付采用 authoritative 模式：产物作为权威文件落盘，模型只产出/修改"工作副本"，不经过模型转述交付——`delivery_mode: authoritative_markdown` 的思想用于 office 产物台账（生成物登记：来源会话、版本、校验和） |

### 6.2 新增候选事项（未纳入任何步骤，需逐项决策）

| 候选 | 内容 | 建议时机 | 成本 |
| --- | --- | --- | --- |
| 插件层边界规则 | `verify-boundaries.mjs` 增加规则：产品插件包禁止直接 import `@deepseek-ai/*`，只准经 contracts 类型与 ctx 服务消费——把 MOVO"单一适配层"原则机械化 | Segment 4 第一个工作台动工前 | 小（一条 lint 规则） |
| 上游完整性锁 | 在 upstream-baseline 式单一事实源中记录 `@deepseek-ai/*` 逐包 integrity（pnpm-lock 已含哈希，缺的是独立对账清单与"声明 ≠ 安装即失败"检查） | 下次引擎升级时顺带 | 小 |
| 升级候选隔离评估固化 | 现有"升级走候选 + 全量门禁"流程脚本化为固定入口（等价 MOVO 每周 dsh-upgrade-candidate 的手动版） | 引擎升级第二次发生时 | 小 |
| 竞品情报例行化 | 把 himovo/movo 列入固定观察点（§0 表），每个大段（Segment）开工前刷新一次；关注：贡献者多元化、Windows 支持、许可证收紧、DSH 版本跟进策略 | 即刻（本文已建档） | 忽略不计 |
| 模型用途槽位（个人版） | 参照 MOVO 按用途指派模型（对话/视觉/嵌入/重排/生图）设计个人偏好层——对应蓝图 v1 §4.4 预留的 model-policy 位置（v2 已升格为 §4.1 F4，提前为内核设计的一部分） | Segment 4 之后，非现在 | 中 |

### 6.3 明确不做（从 MOVO 反面取材）

1. 多租户、组织、岗位角色、配额计费体系——企业能力，违背本地单人定位；
2. Mongo/Redis/Weaviate 或任何常驻服务端进程——违背"数据在自己手里"与无回环外监听的安全模型；将来若需向量检索，选嵌入式本地方案并保持可选；
3. 低代码画布/固定流程执行引擎——Dify/Coze 已占，MOVO 也刻意不做的第二引擎，DSH Agent Loop 本身就是编排器；
4. 双端分离（管理端/用户端）——本地产品只有一个用户；
5. 搬运 MOVO 代码——许可为 Apache 2.0 附加条款（禁 OEM/去品牌）且技术栈无交集，**只学架构决策，不取一行代码**；
6. Web 线发布与多人 SaaS 形态——蓝图阶段六之外的叙事，不在本规划引入。

### 6.4 风险警示（MOVO 教训直接映射）

| MOVO 的坑 | Deskwork 对应防线 |
| --- | --- |
| 绑 alpha 上游，V3 API 差异迫使维护四类 compat 适配器；npm 源码映射 unverified | 引擎已在 0.2.0-rc.1：坚持先 diff 官方 capability-seams/module-graph 再升级（蓝图 v1 §6.5 的纪律；现行升级流程见 [upstream-baseline](upstream-baseline.md) §4）；smoke 全部打真实组合；host-control 冻结协议吸收 API 摆动 |
| 检索授权取回后过滤的规模隐患 | library 步权限在查询期收敛（6.1 步 9 注记） |
| 代号残留遍布全仓 | 7b 提级执行（6.1） |
| 14 万行单体靠约定维持边界 | 插件包 + contracts 定型事件 + （若采纳）边界 lint 规则，把边界交给机器 |

## 7. 建议的采纳动作（供决策，本文不自行执行）

1. 认可 §4 定位结论：不转向企业平台，维持蓝图既定方向；
2. 逐项裁决 §6.1 注记：合入 plan-v2 对应步骤（改文档需许可，plan-v2 §6 纪律不变）；
3. 裁决 §6.2 五个候选：建议至少采纳"插件层边界规则"与"竞品情报例行化"（成本最小、杠杆最大）；
4. 7b 是否提级到 Segment 4 之前执行；
5. 本文作为调研记录留在 docs/，观察点变化时新增日期分节，不改写既有结论。

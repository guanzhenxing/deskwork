# 数据布局与所有权

- 关联架构：[架构](architecture.md)

## 1. 路径变量

本文使用以下逻辑路径：

| 变量            | 解析规则                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<home>`        | `resolveDesktopHome()`（`packages/home-lease`）：`$DESKWORK_HOME` trim 后非空时生效（支持 `~` 展开，相对路径相对进程 cwd），否则为 `~/.deskwork`（Deskwork 自有 home，不指向官方 CLI 的 `~/.dsh`）；解析结果不得为 filesystem root。上游的 `DSH_HOME` **不是输入**——入口解析从不读它，仅由入口把它设置给引擎子进程 |
| `<isolatedHome>` | `<userData>` 下的专属隔离 home；受支持隔离冒烟入口专用，由 Electron 单实例/测试夹具独占，不是共享 `<home>`，不创建 lease                                                               |
| `<profile>`     | `<home>/profiles/deskwork`（上游把 `desktop` 这个名字保留给官方 Electron 应用，CLI 侧会被拒绝）                                                                                                  |
| `<safeProfile>` | Safe Mode 使用 `<home>/profiles/desktop-safe-mode`（精确三 bundle），同时是未来插件市场的前置能力                                                                                                |
| `<userData>`    | Electron 设置产品身份后返回的 `app.getPath('userData')`；macOS 预期位于 Application Support 下固定的 `Deskwork` 目录（`dataDirectoryName`，不随产品展示名改名迁移）                |
| `<testHome>`    | 测试通过系统临时目录 API 单独创建的 DSH home，绝不能指向真实 `<home>`                                                                                                                             |

所有可写路径先解析为绝对路径并验证预期父目录。写入逻辑不得跟随用户可植入的目标 symlink 覆盖其他位置。

产品身份（产品名 `Deskwork`、固定的 Electron userData 数据目录名 `Deskwork`、自有 DSH home 默认 `~/.deskwork`、CLI 名 `dsh-native`、设置 namespace `dsh-native-shell`、renderer partition、默认 profile 名）集中维护在 `packages/product-config`，该包不允许依赖 Electron 或任何 `@deepseek-ai/*` 包。

## 2. DSH home

| 路径                                                                 | 权威/所有者          | Desktop 写入规则                                                                                                                                                                        | 备份与迁移                                                                                                                                                           |
| -------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<home>/.credentials.yaml`                                           | 用户/DSH credential provider | Desktop 不复制、不回滚内容                                                                                                                                                                | 由 DSH/用户负责；日志不得包含内容                                                                                                                                    |
| `<home>/settings.yaml`                                               | 用户与所有 profile   | 只由正式 DSH 设置能力修改；启动恢复不覆盖                                                                                                                                                       | 格式迁移由对应 DSH provider 定义                                                                                                                                     |
| `<home>/cordis.patch.yml`                                            | 用户                 | Desktop 启动恢复不修改                                                                                                                                                                          | 用户负责；错误只诊断                                                                                                                                                 |
| `<home>/sessions/**`                                                 | DSH session provider | 仅活跃 Host 写入                                                                                                                                                                                | 升级测试使用副本，不能在真实数据上演练                                                                                                                               |
| `<home>/storages/**`                                                 | DSH storage providers | 仅活跃 Host 写入                                                                                                                                                                                | 迁移和降级范围进入兼容性清单                                                                                                                                         |
| `<profile>/**`                                                       | `profile-manager` 与用户 | 只修改白名单文件并做修订校验                                                                                                                                                                   | 修改前保存存在性、内容和 SHA-256                                                                                                                                     |
| `<safeProfile>/**`                                                   | `profile-manager`    | 只创建 Safe Mode 自身投影，不自动修改正常 profile                                                                                                                                               | 可重建；不得包含第三方 bundle 或正常 patch layer                                                                                                                     |
| `<home>/run/compatibility.json`                                      | 受支持写入者         | 任何受支持入口写入前执行固定链：parse marker → 只读格式勘察 → 纯预检 → 原子预约 marker（fsync temp+rename+目录 fsync）；缺失允许，未知 schema/损坏/不支持 epoch/未知格式/不可读格式/需迁移一律拒绝（exit/恢复页 fail-closed），拒绝不触碰任何数据文件 | 预约后启动失败不回滚 epoch；损坏即拒绝不自动重写（[home-compatibility 协议](protocols/home-compatibility.md)） |
| `<home>/run/host.lock/`（含 `owner.json` 与 `.dsh-writer-sentinel`） | `home-lease`         | launcher 或 bundled CLI 在整个 Host writer 生命周期持有；哨兵使目录恒非空（布局 v2 单写者载体），原子镜像 generation、supervisor、Host 与 pendingSpawn，供 doctor 兜底判定                      | 不是数据备份；只可按 owner 身份受控恢复                                                                                                                              |
| `<home>/run/profile-transactions/**`                                 | `profile-manager`    | 持有 home lease 时原子写入                                                                                                                                                                      | 用于崩溃恢复，终态（committed/rolled-back/retained）最近 20 条保留，conflict 与未终态不自动清理                                                                      |
| `<home>/profiles/.dsh-desktop-run-*`                                 | `host-supervisor`    | Host 每次启动的中性 launch root（临时 cordis 根 + bundle 投影）；退出时删除                                                                                                                     | 不含用户数据；异常残留不阻塞（下次启动新目录）                                                                                                                       |
| `<home>/run/projection-cache-quarantine.json`                        | `shell-core`         | cache 隔离 rename 前后的意图 journal（crash 窗口 spanning）；move 落定后自清理                                                                                                                   | 只写相对路径与字节数；不复制内容                                                                                                                                     |
| `<home>/storages/session_projcache.quarantine-<id>`                  | `shell-core`         | 超 512 MiB 的可重建 projection cache 在持 lease、无 Host 时同文件系统 rename 隔离                                                                                                               | 备份保留不自动删除；rename 前后写意图 journal                                                                                                                        |
| `<userData>/node-compile-cache/`                                     | desktop launcher     | Host 子进程的 Node 编译缓存（launcher 经受控 `NODE_OPTIONS --require` 预载与 host-entry 兜底开启）；缓存按源码哈希键，不进 `<home>` 不受 admission 检查                                          | 纯性能产物，随时可删；删除只影响下一次冷启动速度                                                                                                                     |

“Desktop 与 CLI 共享 home”表示它们在不同时间读写同一批数据，不表示两个 Host 可以并发写入。

## 3. Home lease

受支持入口在共享 `<home>` 上写入前必须持有 lease（协议细节见 [home-lease 协议](protocols/home-lease.md)）；`<isolatedHome>` 由 Electron 单实例/测试夹具独占，不创建 lease。这不是对共享 home 规则的放宽。

正常启动不接受任意 userData 覆盖。只有 `ui`/`host-crash` smoke 可使用系统临时目录下通过 symlink/实际路径检查的专用目录。profile-manager 的隔离 authority 必须绑定调用方指定 userData 下的专属隔离 home；该 authority 是受信调用方的写入前提，不是对同用户任意代码的安全沙箱。

lease 目录固定为：

```text
<home>/run/
├── host-lease.guard    # 永久 owner-only advisory lock 文件，原生 helper flock 短临界区
└── host.lock/
    ├── owner.json
    └── .dsh-writer-sentinel
```

`owner.json` 至少记录：

- schema version；
- lease generation；
- supervisor PID 与 start identity；
- Host PID 与 start identity；
- entrypoint、profile、创建时间与应用版本。

owner 文件不包含凭据、authenticated URL、控制通道 capability 或完整命令行。

lease 目录通过原子 `mkdir` 创建。任何清理都必须重新验证 generation、supervisor 和 Host 身份；不能按目录年龄自动解锁。身份不明时由 `dsh-native doctor --unlock` 在确认没有活跃 owner 后显式处理。

## 4. Profile 修改事务

共享 home 的 reconcile 走**逐文件修订事务**：先 `planDesktopReconcile` 计算纯写入计划（只含白名单三文件的相对路径、before 存在性/SHA/字节、候选字节/SHA），再 `applyProfileTransaction` 持久化 journal 并逐文件应用；`commitProfileTransaction` 仅在 Host ready 后写 committed；`rollbackProfileTransaction` 验证所有受影响文件只处于 before/candidate 后幂等恢复，出现第三种内容返回 conflict 并保留；`recoverInterruptedTransactions` 在新 Host boot 前处理中断事务（未达 applied 的幂等恢复，applied 无归因的返回 needs-review，明确不可回滚的以 retained 终态记录失败类别）。隔离 authority 路径保持直接写入，不建 journal。事务目录：

```text
<home>/run/profile-transactions/<transaction-id>/
├── transaction.json
└── before/
    └── <whitelisted-profile-relative-path>
```

`transaction.json` 记录 schema、transaction id、`ProfileRef`、操作类型、状态、修改前存在性/摘要、候选摘要和应用版本。`before/` 只保存白名单 profile 文件，不复制 settings、home patch、sessions、storages 或 credentials。

写入顺序是：

1. 持有 home lease；
2. 验证 profile 路径和 symlink 约束；
3. 原子写 transaction 意图与 before snapshot；
4. 原子替换白名单文件；
5. Host ready 且真实窗口挂载 surface 后标记 committed（`RecoverySessionController` 的会话语义）；
6. 失败时仅在当前摘要仍等于本次候选摘要时恢复 before；rollback 写回前对每个文件复验路径/inode/摘要，阶段间漂移返回 conflict；
7. committed/rolled-back/retained 终态记录按有界保留策略保留最近 20 条；conflict 与未终态不自动清理。

journal 是**不可信输入**：`readJournal` 校验 `ref` 必须落在 `<home>/profiles/<name>` 布局内，越界即视为 corrupt；恢复窗口对 journal 内字段不做任何路径拼接之外的信任。

generation ledger（插件市场的前置能力）仍将由 `profile-manager` 拥有，但在其 schema、迁移和清理策略经专门设计评审确定前不创建 generation 存储目录。transaction journal 与 generation ledger 的分离不改变 profile-manager 的唯一权威。

## 5. Electron userData

| 路径                                       | 所有者                        | 用途                                                                                             | 恢复规则                                                                 |
| ------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `<userData>/window-state.json`             | `shell-core`                  | 窗口位置、大小和最大化状态                                                                       | 可重建；离屏时回退默认值                                                 |
| `<userData>/recovery/<home 摘要>.json`     | launcher（`shell-core` 会话） | profile 自动恢复 relaunch-once 的 marker：`schemaVersion: 1`，绑定 home 匿名摘要、transaction id、attempt；fsync 原子写 | 会话健康后清除；损坏或未知格式的 marker 视为“预算已消耗”且永不覆写或删除 |
| `<userData>/logs/**`                       | launcher/Host 结构化日志      | 本地诊断                                                                                         | 有界轮换；必须脱敏                                                       |
| `<userData>/recovery/**`                   | launcher                      | crash-loop marker、最近失败阶段                                                                 | 只恢复 launcher-owned 状态                                               |
| `<userData>/updates/effective-policy.json` | future `desktopUpdater` adapter | 校验后的 last-effective policy                                                                 | 更新能力进入前不创建；损坏时退回 embedded emergency source              |
| `<userData>/updates/cache/**`              | future updater                | 已校验的下载制品                                                                                 | 更新能力进入前不创建；可删除并重新下载                                   |

Chromium 的 `persist:dsh-desktop-renderer` partition 也位于 Electron 管理的数据范围。清理 renderer cache 不得被描述为清理 DSH session 或 storage。

DSH credential、settings、sessions 和 storages 不复制到 `<userData>`。

## 6. 应用只读资源

打包应用内包含：

- Desktop 版本和 machine-readable compatibility manifest；
- DSH tag、commit、依赖闭包和 SHA-256 清单；
- 第一方 bundle 与 bundle patch；
- Host-control schema fixtures；
- 更新能力引入后的更新签名信任根和 emergency stable source。

运行时不能原地修改应用 bundle。更新通过新制品校验、停止 Host、替换应用和 relaunch 完成。

## 7. Secret storage

未来远程设备私钥放入 macOS Keychain 或等价系统 secure storage，不放入 DSH settings、profile、日志或普通 userData 文件。

`desktopSecureStore` 只暴露用途受限的生成、签名、解密、封装和删除操作。Host 和 renderer 不能取得原始私钥或长期主秘密。

## 8. 测试数据

所有涉及 profile、lease、恢复或迁移的自动化测试必须使用 `<testHome>`：

- 测试开始时由 `tests/helpers/isolated-home.mjs` 的 `createIsolatedHomeFixture()` 在系统临时目录下创建；创建时拒绝环境 `DESKWORK_HOME` 已设置、仓库目录、filesystem root 与真实 `~/.dsh`、`~/.deskwork`，清理前复核 realpath 与 dev/ino 身份；
- fixture 可以从脱敏数据复制，不能链接到真实 home；
- 失败时保留路径供诊断，清理命令只能针对已记录且验证过的临时目录；
- 打包冒烟使用独立临时 macOS userData。

## 9. 数据迁移原则

1. 每个持久化文件都有 schema version 或由其 DSH provider 明确拥有格式；
2. 写入使用临时文件、fsync/等价持久化和原子替换；
3. 不可逆迁移在 Host 停止后创建可验证备份；
4. compatibility manifest 不允许旧应用读取新格式时，launcher 明确禁止降级；
5. 删除只针对可重建数据或超过保留策略且未被引用的 generation；
6. 任何无法确定所有权或版本的数据保持不动并给出诊断。

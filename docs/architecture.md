# 架构

- 相关文档：[协议](protocols/)、[数据布局](data-layout.md)

## 1. 架构目标

本项目以一个 DSH bundle 插件承载 Desktop 产品集成，以薄 Electron launcher 承载插件无法自举的操作系统能力。

架构同时满足四个约束：

1. Electron Main 与 renderer 不加载 DSH Host 或第三方插件代码；
2. Desktop 功能保持插件化，但 boot、进程监督、恢复和应用替换不依赖普通 Host 成功启动；
3. profile、Host 和原生能力各有唯一权威，不在 UI、launcher 和插件之间复制状态机；
4. 市场、远程和更新以后可以作为独立能力加入，而不扩张成通用 `desktopRuntime`。

## 2. 系统上下文

当前运行路径：

```text
macOS
└── Electron desktop-launcher
    ├── BrowserWindow / Tray / Dock / Menu
    ├── launcher-owned recovery control plane
    ├── profile-manager
    └── host-supervisor
        └── Node-capable DSH Host runner
            ├── DSH runtime and official Web UI
            ├── desktop-plugin                  # normal mode
            ├── desktop-recovery-bridge         # Safe Mode surface bridge
            └── future product plugins
                ├── plugin-market
                ├── remote-access
                └── desktop-updater
```

Electron renderer 只加载 Host 发布的 authenticated loopback URL。Host runner 与 launcher 通过 [Host-control 1.0](protocols/host-control.md) 通信，不解析 stdout 文案。

## 3. 进程与信任边界

| 边界                | 内部内容                                        | 信任与失败语义                                          |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| Electron Main       | launcher、窗口、托盘、控制通道、最低恢复/更新面 | 发行版信任基；必须在 Host 故障时继续运行                |
| Electron renderer   | 官方 DSH Web UI                                 | sandboxed renderer；不具备 Node 或任意 Electron IPC     |
| DSH Host 子进程     | DSH runtime、第一方和第三方插件                 | 故障隔离于 Electron，但仍拥有当前用户的系统权限         |
| DSH home            | 凭据、设置、会话、storages、profiles            | 用户与 DSH 数据；同一时刻只允许一个受支持 Host writer   |
| 远程 bridge（未来） | 受限 carrier 和设备连接                         | 不具备业务授权权威；Host 必须逐方法检查 principal/scope |

子进程隔离用于故障收敛和生命周期监督，不是插件权限沙箱。安装第三方插件等价于允许代码以当前用户权限在 Host 中执行；完整安全约束见 [`SECURITY.md`](../SECURITY.md)。

## 4. 组件职责与依赖方向

### 4.1 应用入口

`apps/desktop-launcher`：

- 设置应用身份、userData 与单实例锁；
- 解析产品配置；
- 调用 `shell-core` 编排启动、窗口、恢复和关停；
- 提供 boot-independent 的最低恢复/更新 UI；
- Electron Main 只导入监督器根入口，不导入 DSH Host 包或第三方插件；专用 `host-entry` subpath 在 utility process 内导入 Host runner。

### 4.2 DSH 插件

`packages/desktop-plugin`：

- 声明正常 `deskwork` profile 的 bundle patch；
- 等待官方 `connection` 服务；
- 校验 loopback URL 并通过 `desktopSurface` 发布 normal surface；
- 缺少 launcher 能力时可读降级；
- 不导入 Electron。

`packages/desktop-recovery-bridge`：

- 随应用发布的最小第一方 bundle；
- 在 `desktop-safe-mode` 中发布 recovery surface；
- 不包含市场、profile 修改、产品设置或更新策略；
- 不导入 Electron。

产品层不在本仓库。壳只负责启动 DSH 并让路：`deskwork` profile 的组合是 `dsh-base`、`dsh-web-app` 与 `desktop-plugin` 三者。将来若要在该 profile 中加入产品界面，按 [bundle 样例](examples/workbench-bundle.md)以独立 bundle 的形式加入，不进壳的依赖图。

### 4.3 通用机制包

`packages/desktop-contracts`：

- 只含 schema、类型、版本协商、错误定义和双向 fixture；
- 不依赖 Electron；
- 按能力提供独立 subpath export 和 `{ name, major, minor }` 版本。

`packages/host-supervisor`：

- 创建独立 Host runner；
- 建立私有控制通道；
- 验证握手、Host 身份、稳定性窗口和有界关停；
- 把 Host 异常转化为结构化状态，不直接拥有窗口或 profile；
- 根 export 只暴露监督器；DSH Host runner 只能从 `./host-runner` subpath 导入，防止 Electron Main 间接求值 DSH；
- Host runner 的 shared module fallback 只物化当前安装依赖闭包；选中 bundle 的局部 fallback 与中性 `cordis.yml` 位于临时 launch root，不写入 named profile。产品安装入口由 launcher 注入，共享 `desktopSurface` 服务定义归 `desktop-contracts/host-control`。

`packages/profile-manager`：

- 唯一拥有 `ProfileRef`、reconcile、修订恢复和 Safe Mode 投影规则；
- 以后唯一拥有 generation ledger、事务 journal 和 drift 处理（见数据布局的迁移原则）；；
- 不依赖 Electron，也不启动 Host；
- home 写入要求调用方持有该 home 的 home session；隔离冒烟入口使用绑定 `<userData>` 下专属隔离 home 的 authority；
- 隔离 authority 下唯一写入的 profile 文件是 manifest、用户 patch 模板与 profile workspace 配置；Host runner 不成为这些文件的第二权威。

`packages/host-supervisor` 的 `host-owner`：

- 定义唯一一份 home 所有权的两端：Host 进程持有的内核 `flock`（存活性权威）与 `<home>/run/host-owner.json`（可达性与诊断）；
- 启动前判定孤儿 Host：锁空闲即接管并清理陈旧记录，锁被持有则按记录终止，终止不掉即拒绝启动；
- 不按时间或年龄推断锁是否失效——判据只有内核是否仍持有它。

`packages/shell-core`：

- 编排 `home-owner` 的启动判定、`profile-manager`、`host-supervisor` 与 Electron 资源；
- 管理窗口、托盘、菜单、日志和恢复状态；
- 不直接成为 profile 或 Host 状态的第二权威。

依赖方向固定为：

```text
desktop-launcher
  → shell-core
      → profile-manager
      → host-supervisor
      → desktop-contracts/host-control

desktop-plugin
  → DSH public services
  → desktop-contracts/host-control

desktop-recovery-bridge
  → DSH public services
  → desktop-contracts/host-control
```

底层机制包不得反向依赖 launcher、产品文案或产品插件。

## 5. 正常启动

```text
launcher identity/single-instance
→ resolve DSH home
→ settle any orphan Host, then create the home session
→ home compatibility admission（marker 的 schemaVersion 与 dataEpoch 检查；写入预约随首次写入，见协议）
→ profile-manager snapshots and reconciles ProfileRef("deskwork")
→ host-supervisor creates private channel and Host runner
→ the Host process takes <home>/run/host.lock for its lifetime
→ Host runner boots DSH and injects desktopSurface proxy
→ desktop-plugin obtains authenticated connection URL
→ desktop-plugin publishes normal surface
→ launcher validates Host-control envelope and loopback URL
→ BrowserWindow loads and stabilizes
→ launcher marks profile healthy
```

Host-control `ready` 只说明 Host 和 surface publisher 已完成协议侧就绪。应用 `ready` 还要求 BrowserWindow 成功挂载并通过 launcher 的稳定性窗口。失败分类与恢复语义见[启动恢复分类协议](protocols/startup-recovery.md)。

## 6. Safe Mode 启动

Safe Mode 是不加载正常 profile 组合的最小恢复会话，也是未来插件市场的前置能力：

```text
launcher keeps the same home session
→ normal Host is fully stopped
→ profile-manager prepares desktop-safe-mode
→ Host boots dsh-base + dsh-web-app + desktop-recovery-bridge
→ recovery bridge publishes recovery surface
→ launcher loads the recovery Web UI
→ local recovery controls remain available
```

Safe Mode 不读取正常 profile 的 `desktop-plugin`、第三方 bundle、依赖树或 patch layer，也不自动修改正常 profile。即使 Safe Mode 失败，launcher-owned 最低恢复面仍可显示诊断、重试和退出。

## 7. 状态权威

| 状态                | 唯一权威                                | 物化或读取者                      |
| ------------------- | --------------------------------------- | --------------------------------- |
| 活跃 Host 进程      | `host-supervisor` + the home lock       | launcher                          |
| profile 规则与事务  | `profile-manager`                       | launcher、市场 UI、Safe Mode      |
| DSH 会话和 storages | DSH providers                           | 本地及未来远程客户端              |
| Electron 窗口状态   | launcher userData                       | `shell-core`                      |
| 原生能力协议        | `desktop-contracts/<capability>`        | Host proxy 与 launcher adapter    |
| 发行版兼容范围      | machine-readable compatibility manifest | launcher、updater、诊断与文档生成 |

机器可读事实见 [`compatibility.json`](compatibility.json)。该文件由 `pnpm generate:compatibility` 生成，描述源码基线与发行制品的版本事实。

路径、备份和迁移规则见[数据布局](data-layout.md)。

## 8. 扩展规则

新增桌面能力必须采用三部分结构：

1. DSH 产品插件拥有正常 UI 和业务策略；
2. launcher adapter 只实现不能在 Host 中安全完成的操作系统机制；
3. 独立版本的 capability contract 连接两者。

以下规则不可绕过：

- 不向既有契约添加任意方法调用或 Electron 对象；
- Host capability 只认证 Host 进程，不认证调用插件；
- profile、更新、凭据和系统操作需要能力级策略与 launcher-owned 用户确认；
- secure store 不向 Host 返回原始私钥；
- 插件与 Desktop 更新是独立事务；
- remote bridge 不是授权权威；
- 需要在 Host boot 失败时工作的最低机制必须属于 launcher，但正常产品策略仍属于插件。

## 9. 未来能力与进入条件

进入实现前的共同门槛：

| 能力             | 进入实现前的门槛                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| 单 Host 多客户端 | 本地 discovery/attach、Host 所有权、客户端 principal 和协议设计                                                     |
| 更新             | Developer ID、notarization、签名信任根、last-effective policy、emergency stable source、迁移/降级规则               |
| 插件市场         | recovery bridge Safe Mode、profile generation journal、plugin package contract、受信 catalog、故障归因与 drift 流程 |
| 远程             | 固定 DSH 基线上的 principal 传播和逐方法授权 prototype、设备撤销、TLS/可信 relay 与审计设计                         |

这些门槛是 just-in-time 设计关卡，不要求当前版本提前实现未来产品能力。

## 10. 架构变更流程

改变进程边界、状态权威、信任边界、持久化格式或公共协议 major version 时，必须先通过专门的设计评审并记录变更理由与备选方案。可逆的内部实现调整记录在对应 issue/spec 和测试中，不要求单独设计文档。

开发、审查和发布流程见[开发指南](development.md)。

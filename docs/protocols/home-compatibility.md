# Home Compatibility Marker 协议

- 状态：已实现（`packages/release-compatibility` 的最小准入链）
- 适用入口：Desktop launcher（含 Safe Mode 会话）与 `dsh-native` CLI 的全部会写 home 的路径

## 1. 目标与非目标

本协议定义受支持入口在启动会写路径前的兼容性 admission：

- **只读 marker 读取 + fail-closed admission**：marker 缺失允许进入（现存 home 早于本机制）；未知 schema、损坏内容、不受支持的 dataEpoch 一律拒绝，且不产生任何 home 写入。
- **写入预约**（`reserveHomeWrite`）：受支持入口在写入前将 schema 1 marker 原子落盘。
- **非目标**：home 内逐文件格式勘察——跨产品格式准入已随 Deskwork 转向移除（`inspectHomeFormats`/`preflightHome` 已删除，policy 的 `formats[]` 恒为空）；marker 的 schemaVersion 与 dataEpoch 是仅有的准入事实。自动数据迁移同样是非目标。
- 阻止不受支持入口（裸 CLI、无 guard 旧二进制）写入仍是非目标：marker 只约束受支持入口之间的协作。

## 2. Marker 布局与格式

路径固定为 `<home>/run/compatibility.json`：

```json
{
  "schemaVersion": 1,
  "dataEpoch": 1,
  "lastWriterReleaseId": "v0.1.0-darwin-arm64-a11dfd9",
  "formats": {}
}
```

| 字段                  | 类型                             | 语义                                                                            |
| --------------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| `schemaVersion`       | `1`                              | marker 自身 schema；非 1 一律按未知处理                                         |
| `dataEpoch`           | 安全整数                         | 本项目自定义的兼容性分组（见 §4）                                               |
| `lastWriterReleaseId` | 非空字符串                       | 最后一个预约写入此 home 的发行版标识（诊断用，不构成信任）                      |
| `formats`             | 槽位名 → formatId 的 map（可空） | 历史遗留字段：最小准入写入恒空的 map；读取仍接受含条目的历史 marker，但不再比对 |

读取规则（实现：`packages/release-compatibility/src/home-admission.ts`）：

1. `ENOENT` 视为 marker 缺失，返回 null；
2. marker 是 symlink、非普通文件、不可读、或内容不是 JSON object，一律 fail closed（抛 `HomeAdmissionError`，调用方必须按拒绝处理）；
3. 字段缺失或类型不符按损坏内容处理，同样 fail closed。

写入规则（实现：`home-marker.ts` 的 `reserveHomeWrite`）：

1. 仅在持有该 home 的 lease 时执行（lease.home 必须一致）；无 lease 的透传路径从不预约；
2. fsync 临时文件 + 原子 rename + 目录 fsync（与 journals/safe-profile 同一落盘纪律）；
3. 预约发生在任何潜在新格式写入之前；预约后启动失败**不回滚 epoch**——崩溃窗口后的新格式数据必须被怀疑，而不是被当成旧数据。

## 3. Admission 判定

入口共享固定顺序（实现：`runHomeCompatibilityChain`）：

```
parse marker → schemaVersion 与 dataEpoch 检查 → reserveHomeWrite（reserve 时）
```

判定顺序：

1. marker 可解析但 `schemaVersion !== 1` → `unknown-schema`；
2. `marker.dataEpoch ∉ release.supportedDataEpochs` → `unsupported-data`（更高版本写入的数据，禁止降级打开）；
3. `marker.dataEpoch < release.dataEpoch` → `migration-required`（旧 epoch 数据不自动迁移）；
4. 其余 → `allow`。

`unknown-format` / `unreadable-format` 保留在 verdict 联合类型中供 launcher 的失败分类使用，但最小链不再产生它们。

入口对拒绝的映射：

- **Desktop**：`RecoverySessionController#admitHomeBeforeAnyWrite` 把拒绝变成非重试 `home-config` 失败（`HOME_MARKER_UNKNOWN` / `HOME_DATA_UNSUPPORTED` / `HOME_MIGRATION_REQUIRED` / `HOME_MARKER_UNREADABLE`），进入本地恢复页，撤下 Safe Mode 入口（Safe Mode 也要写 home，不得绕过）；lease 保持持有供诊断。
- **CLI**：取得 lease 之后、spawn 子进程之前判定；拒绝打印原因并以退出码 5 结束，不 spawn 任何子进程。
- **doctor**：`dsh-native doctor --unlock` 是只读诊断/清理路径，不做 admission、不写 marker。
- 无 profile 的透传路径（帮助、版本）不取 lease，但同样过只读链（不预约）；拒绝即退出码 5，不 spawn——CLI 没有绕过面。

## 4. dataEpoch 语义

- dataEpoch 是**本项目**的兼容性分组，不是 DSH 官方 schema。当前 epoch = 1，`supportedDataEpochs = [1]`，由 policy（`build/compatibility-policy.json`）与生成清单共同声明。
- epoch 只在格式证据支持的升级里提升，且提升必须伴随验证证据；不为每个 Deskwork 版本无故+1。
- `migration-required` 是显式缺口：本版本不迁移；迁移需要单独的迁移设计、停写与可验证备份。

## 5. 安全与诚实边界

- 该 marker 只保证"受支持入口之间"的协作：它不能阻止其他裸 CLI、旧无 guard 二进制或用户直接写入 home。
- marker 本身不含秘密。
- 路径校验与 lease 协议（[home-lease](home-lease.md)）仍然独立生效。
- profile 目录命名契约（`.dsh-desktop-run-*` 运行时启动根保留前缀，由 `@deskwork/desktop-contracts/profile-name` 导出）由 profile-manager 与 home-lease 的入口闸门独立执行，与本准入无关。

## 6. 演进

- schema 1 保持可读；新增字段只做 additive；`schemaVersion` 提升（2+）的 marker 对本版本按 `unknown-schema` 拒绝。
- 若未来恢复跨产品格式准入，须重启格式勘察与预检的专门设计（历史实现见 git 历史：`inspect-home.ts`/`preflight.ts`，删除于准入最小化提交）。

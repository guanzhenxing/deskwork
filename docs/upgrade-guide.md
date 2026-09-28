# 升级与回退指南

- 适用对象：Deskwork 的手动升级与回退（当前版本无自动更新器）
- 相关文档：[upstream-baseline](upstream-baseline.md)、[home-compatibility 协议](protocols/home-compatibility.md)

## 1. 手动升级流程

1. **完全退出旧版**：托盘菜单退出，或 Dock 右键退出；确认退出完成（lease 释放）再继续。
2. **核对制品与兼容性**：确认新 DMG 的 SHA-256 与 `release/artifacts.json` 记录一致（`shasum -a 256`）；查看 DMG 内嵌的 `Contents/Resources/compatibility.json`（schema 2）中的 `dataEpoch` 与 `dsh` 基线。
3. **（可选但推荐）备份 home**：`cp -R ~/.deskwork ~/.deskwork.backup-<日期>`。升级不修改 credentials/settings/会话，但备份是唯一可靠的回退保险。
4. **替换应用**：把新 `.app` 拖入 `/Applications`（或你的安装目录）覆盖旧版。
5. **启动验证**：启动后确认能读到历史会话；新建一条会话确认可写；退出并再次启动确认可恢复。
6. **保留旧 DMG**：上一版 DMG 是二进制回退候选，不要删除。

## 2. 兼容性保护如何工作

- 每个受支持入口（Desktop、Safe Mode、`dsh-native`）在写入 home 之前执行最小准入：读取兼容性 marker → 校验 schemaVersion 与 dataEpoch → 写入预约（`<home>/run/compatibility.json`）。
- 新版本能在旧数据上启动（epoch 在支持范围内）；**旧版本拒绝打开新版本写过的高 epoch 数据**（恢复页明确提示，不产生任何写入；CLI 退出码 5）。
- 损坏或未知 schema 的 marker 一律拒绝：数据保持原状，等待能处理它的版本。
- 升级不升级、不卸载、不重写用户第三方插件与 home settings；这两类内容完全留给你。

## 3. 拒绝降级时怎么办

如果旧版 DMG 启动后提示“由更高数据版本写入”（`HOME_DATA_UNSUPPORTED` / 退出码 5）：

1. **不要**删除 marker、不要手工改 `~/.deskwork/run/compatibility.json`；
2. 装回能读该数据的版本（写入它的那个版本）继续使用；
3. 只有在确认放弃数据、或已有经过验证的备份时，才考虑从零初始化。

## 4. 什么情况不能升级

- 制品 SHA 与记录不符 → 重新下载/重建，不要强行安装；
- 清单声明 `MIGRATION_REQUIRED` 场景 → 该版本不自动迁移，等迁移版本（需要单独的迁移设计）。

## 5. 升级执行流程（面向维护者）

上游出现新 tag 时，真实升级在独立候选分支 `chore/upgrade-dsh-<实际标签>` 上执行（更新 tag/commit/闭包 → 重跑全部门禁 → 打包候选），与功能分支严格隔离。放行标准是门禁全绿加安装级冒烟（`smoke:package`）；升级窗口前后在**副本 home** 上手动做一次"读历史 → 写入 → 重启 → 再读"验证，绝不读写真实数据目录。

## 6. 已知边界

- 旧 DMG 只回退二进制；它**不承诺**能读取新格式数据（靠 admission 拒绝，不靠运气）。
- **冻结旧制品的 doctor 与新版共存**：lease 进程身份使用纯进程启动时间；新版 probe 对旧格式身份串（启动时间后缀形式）兼容——旧版活持有者判 `same`，锁不会被新 doctor 删。但**冻结的旧制品反向不兼容**——旧 helper 拿新身份串整串比较会判 `different`，旧版 doctor 因此可能删除新版正在持有的活锁。后果有界且在协议层被阻止：**锁目录布局 v2**（`host.lock/.dsh-writer-sentinel` 哨兵）让一切版本的 doctor 对非空锁目录 `rmdir` 一律拒绝——旧制品的 doctor 即便误读新身份格式，也最多删掉 owner 文件而**永远删不掉 v2 活锁目录**，新入口无法取得新锁，双写在锁布局层被阻止；残留的“无 owner 锁目录”由新版 doctor 清理。**lease watchdog** 作为兜底：supervisor/CLI 在 Host/子进程运行期间周期性复核 lease（默认 2s，guard 竞争不计、连续两次非竞争失败处决己方 Host/子进程），把任何其他路径的锁丢失双写窗口压缩到约一个监视周期。lease 把守的是准入，不是 Host 自身的数据写。限制：升级窗口内不要运行旧制品的 `doctor --unlock`（或任何旧二进制）指向新版正使用的 home；此限制随旧制品淘汰自然消失。
- marker 只约束受支持入口之间的协作：裸 CLI、无 guard 的旧二进制或手工写入不受保护。
- 本地自用构建未签名/未公证：Gatekeeper 首次启动需要右键打开；公开分发预编译二进制前需先完成发行要求。公开源代码、由使用者自行构建不受此项限制。

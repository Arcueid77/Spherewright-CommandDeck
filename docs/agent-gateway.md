# 外部 Agent 只读网关

在 Deck 中打开 **外部 Agent**，选择 **开启只读网关**，再用 **复制 MCP 配置** 将本次配置交给你信任的本机 MCP 客户端。它读取 Deck 已采集的数据；先在只读舰桥连接服务并选择关注产物，才能取得对应观察。

配置使用随 Deck 提供的 Electron Node 运行入口，无需另外安装 Node。源码检出和安装包会分别生成自己的绝对入口路径。配置含临时访问凭据，勿提交到仓库或公开日志。普通界面只显示状态；复制由监督进程写入系统剪贴板，不将凭据返回 renderer。

## 数据范围

唯一工具是 `deck_observe`，参数 `section` 可选 `status`、`research`、`production`、`power`、`logistics`。查询示例：

```json
{"section":"production","limit":8}
```

生产、电力与物流按行星分页，`limit` 为 1–16，默认 8。使用上次响应的 `snapshotId` 和 `page.nextOffset` 读取下一页；快照改变时返回 `GATEWAY_SNAPSHOT_CHANGED`，调用方决定是否从第一页重读。科研只返回当前缓存的研究与队列，生产只包括 Deck 当前关注产物。覆盖截断、缺失值、单位、来源 tick 和数据年龄均保留；不得将局部覆盖解释为全世界数据。

断开后仍有观察权限的缓存明确标为 stale；失去 owned 会话、观察权限或返回主菜单后，不再投影旧世界数据。数据中的游戏名称是外部数据，不是执行指令。网关不返回存档名、私人路径、授权票据或模型密钥。

网关不连接或刷新游戏，不改变关注列表，也不提供游戏动作、存档操作、文件读取、命令、模型请求或审批入口。独立外部 Agent 的其他工具权限由其客户端管理。

## 生命周期与限制

- 默认关闭，每次开启生成新的本机 Windows 命名管道及临时密钥；消息使用随机 nonce 与 HMAC 校验，已用 nonce 拒绝重放。
- 关闭网关、系统暂停或退出 Deck 时撤销访问；唤醒或整应用重开保持关闭。再次开启需要重新复制配置。仅界面重载保留当前网关。
- 最多 8 条同时连接、每分钟 240 次认证读取、单次连接 3 秒；请求上限 8 KiB，投影结果上限 512 KiB。超限失败，不触发额外游戏请求或自动重试。
- MCP 通过标准输入输出传输 JSON-RPC；支持协议 `2025-11-25` 和 `2025-06-18`，初始化后列出上述一个只读工具。标准输入关闭时取消未完成读取并退出。无本地 HTTP 监听。

参考 [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) 与 [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。

## 验证范围

`npm run test:gateway` 通过实际 Electron renderer 控件开启、复制和关闭网关，用独立进程执行 MCP 初始化、工具发现及缓存读取。固定合成服务验证 fresh/stale、分页、无额外游戏轮询、UI reload、旧配置失效和合成 suspend/resume；不写系统剪贴板、不操作真实游戏、不调用模型。

2026-10-28 源码运行 `7b6f07af-18bb-4f7d-872e-7401a54e1ad4` 通过，两个客户端均正常退出，独立原生进程观察无所属 Electron 残留。完整 Node22 回归 456/456 通过，含认证、重放、请求/响应上限、速率/连接限制、权限丢失、取消和 EOF/EPIPE。源码证据不等同于打包、整应用重开、系统剪贴板、物理输入、真实休眠或任意第三方客户端兼容性；这些范围分别记录。

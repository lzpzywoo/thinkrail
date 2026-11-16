# ThinkRail → Muse 会话 Hub

独立 TypeScript/Bun 服务，向 Muse Pet 注册 **ThinkRail 会话与任务管理器**。默认查询运行中的 ThinkRail 主机，返回真实项目、工作区、会话状态和 TODO 任务计划。服务通过公开 WebSocket 协议读取数据，不需要导入 ThinkRail 服务端或 Pi 运行时。

## 启动

先启动 ThinkRail 和 Muse Pet，在此仓库根目录执行：

```bash
bun run examples/muse-session-manager/index.ts
```

如 ThinkRail 使用自定义端口，请在启动前设置 `THINKRAIL_WS_URL`。默认地址为 `ws://localhost:24242/ws`；ThinkRail 可能因端口占用选择其他端口，请使用实际启动地址。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `THINKRAIL_WS_URL` | `ws://localhost:24242/ws` | 真实 ThinkRail 主机 |
| `MUSE_HUB_URL` | `http://127.0.0.1:19840` | Muse 注册/心跳服务 |
| `MUSE_HUB_WS_URL` | `ws://127.0.0.1:19840/ws` | Muse 任务事件通道 |
| `MUSE_HUB_SECRET` | `muse-session-secret-2026` | 注册身份密钥；建议设置为自己生成且持久保留的值 |

App ID 为 `thinkrail.session-manager`，名称和描述包含 ThinkRail，注册关键词包括 `thinkrail`、`session`、`会话`、`任务`、`工作区`、`pi`。此前的 `com.muse.session-manager` 是另一个注册身份，升级前请停止旧服务；此服务不会注销其他身份。相同 appId 必须继续使用首次注册时的密钥。

Muse 不可用时会按固定间隔重试注册。ThinkRail 不可用、协议版本不匹配或查询超时时，查询报告失败；不会将连接失败包装为空会话列表。

## 连接故障排查

ThinkRail默认绑定`localhost`。Windows上它可能只监听IPv6 `[::1]:24242`，此时`127.0.0.1`无法连接。若之前设置过IPv4地址，请在PowerShell中改为：

```powershell
$env:THINKRAIL_WS_URL = 'ws://localhost:24242/ws'
bun run examples/muse-session-manager/index.ts
```

若ThinkRail使用其他端口或显式的`--host`，请使用其实际地址。连接错误会显示目标地址；Muse连接成功不表示ThinkRail连接也已成功。

## 在 Muse 中查询

输入 `/hub` 或 `/hub tools` 检查应用及工具，然后询问：

- “查看下 ThinkRail 目前的会话任务。”
- “ThinkRail 哪些会话还在执行，哪些在等我回答？”
- “查询这个会话的任务计划进度。”

自然语言发现依赖你运行的 Muse 版本对 name、description 和 keywords 的支持；本服务提交这些元数据，不修改 Muse 的意图识别器。

| 工具 | 默认行为 |
| --- | --- |
| `list_sessions` | 只读查询真实会话；支持 all、active、recent、running、needs_input、idle、completed、failed、cancelled、interrupted；默认返回20条，最多100条 |
| `query_session_progress` | 按真实会话ID、完整标题或唯一工作区名称查询；重名时要求提供ID |
| `send_pet_bubble` | 发送 Muse 本地宠物提醒 |
| `create_and_run_session` | **仅创建内存模拟演示**；不会执行真正的扫描、下载或数据处理 |
| `cancel_session` | **仅取消演示会话**；不会中断真实 ThinkRail Agent |

查询结果示例：

```json
{
  "source": "thinkrail",
  "sessionId": "actual-session-id",
  "projectName": "ThinkRail",
  "workspaceName": "Hub集成",
  "status": "running",
  "planProgress": { "done": 2, "total": 5, "percentage": 40 },
  "currentTasks": [{ "id": "step-id", "title": "实现接入", "status": "in_progress" }]
}
```

`planProgress` 是 TODO 完成数比例，**不代表 Agent 执行百分比**。没有 TODO 时 percentage 为 null；计划达到100%也不表示 Agent 已停止。运行状态来自 ThinkRail 的 `session.stateList`：等待输入优先，后台工作也视为运行；闲置会话不会被误报为成功。`recent` 按工作区最后活动时间排序，同工作区内没有会话级时间排序保证。返回的 total 为筛选后、截断前的数量。

## 自动反馈

服务默认每5秒观察最近最多100个真实会话的状态与任务计划变化。首次连接建立基线，后续变化通过通用 `event` 发送 Muse 本地气泡提醒。断线或读取失败后重新建立基线，不补发历史完成消息。提醒是尽力发送的本地事件，不作为云端会话结果；自然语言查询结果由对应 Hub 任务返回。

真实会话不是该服务拥有的 Hub 任务，因此不会为它们伪造 `task.progress` 或 `task.completed` 帧。服务不发送完整聊天记录、文件路径、差异或 TODO 备注；会话标题、项目/工作区名称及任务标题会包含在查询中。

## 演示与代码接入

```bash
bun run examples/muse-session-manager/index.ts --demo
```

演示流程只模拟子步骤进度。查询演示数据必须显式传 `source: "demo"`；默认查询不会混入演示数据。

从 `index.ts` 公共入口导入 `createAndStartService` 可以创建组件（该函数保留原命名，但不自动连接）。随后调用 `hubClient.start(SESSION_MANAGER_TOOLS)` 并启动 `observer.start()`；退出时先 `observer.stop()`，再 `await hubClient.stop()`。可通过 `SessionManagerConfig.observationIntervalMs` 调整观察频率。

## 验证

```bash
bun test examples/muse-session-manager
bun node_modules/typescript/bin/tsc -p examples/muse-session-manager/tsconfig.json
```

测试使用隔离 HTTP/WebSocket fixture，不读取用户真实数据或调用模型。覆盖真实协议读取、查询路由、元数据注册、状态/计划计算、查询失败、超时和提醒去重。真实 Muse/手机联调尚未在此变更中验证。

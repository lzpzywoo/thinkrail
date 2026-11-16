# 🐾 Muse 会话管理与进度实时反馈系统 (Muse Session Manager)

基于 **Muse Local Agent Hub** 协议标准构建的轻量级、全功能 TypeScript 会话管理服务。使 Muse 桌面宠物（Luna）能够发现、派发长耗时任务，并在执行过程中**实时获取子步骤进度**，在关键节点与完成时接收**桌面气泡主动提醒**。

---

## 🌟 核心特性

1. **实时双向进度反馈**：
   - 任务执行中通过 WebSocket 流式上报 `task.progress`，精准到子步骤百分比与实时日志。
   - 聚合计算整体会话完成度（0% ~ 100%），支持各步骤权重自定义。
2. **状态与进度主动查询**：
   - 注册只读工具 `query_session_progress` 和 `list_sessions`，支持在手机端或桌面端聊天随时询问 Luna：“查看刚才的数据处理进度”。
3. **桌面宠物气泡主动提醒**：
   - 任务完成或遇到异常时，通过 `event` 主动通道触发 Muse 桌面宠物头上弹出实时气泡对话框（Proactive Notification）。
4. **协作式任务中断与取消**：
   - 支持来自 Muse 的 `task.cancelled` 指令与本地 `cancel_session` 工具，基于 `AbortController` 优雅中止正在运行的流程。
5. **开箱即用与容错重连**：
   - 自动维护 HTTP 心跳（20s），断线自动指数退避重连，支持离线会话管理与调试。

---

## 🛠️ 暴露给 Muse 的工具清单

| 工具 ID | 名称 | 类别 | 风险级别 | 作用与交互场景 |
|---|---|---|---|---|
| `create_and_run_session` | 创建并执行会话任务 | action | write-safe | 派发长耗时任务（如代码巡检、数据处理、下载管道），实时推送步骤进度 |
| `query_session_progress` | 查询会话进度与详情 | query | read-only | 查询指定会话的当前百分比、当前步骤状态与各步骤执行结果 |
| `list_sessions` | 查看所有会话列表 | query | read-only | 列出活跃、执行中与已完成的所有历史会话摘要 |
| `cancel_session` | 取消或中断会话 | action | write-safe | 中断正在执行中的会话任务，释放资源 |
| `send_pet_bubble` | 桌面宠物气泡提醒 | action | write-safe | 直接让桌面的 Muse 宠物弹出指定文本的气泡框 |

---

## 🚀 快速启动

### 1. 运行会话管理服务

在终端中执行：

```bash
# 使用 Bun 直接启动
bun run examples/muse-session-manager/index.ts

# 或启动自带演示任务的 Demo 模式
bun run examples/muse-session-manager/index.ts --demo
```

### 2. 配置环境变量（可选）

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `MUSE_HUB_URL` | `http://127.0.0.1:19840` | Muse Local Agent Hub 的 HTTP 基础地址 |
| `MUSE_HUB_WS_URL` | `ws://127.0.0.1:19840/ws` | Muse Hub WebSocket 基础地址 |
| `MUSE_HUB_SECRET` | `muse-session-secret-2026` | 与 Hub 注册认证的 Secret 密钥 |

---

## 💬 在 Muse / 手机端使用示例

1. 启动 Muse Pet 后，在聊天窗口输入 `/hub`，即可看到已连接的「**会话与任务管理器**」应用及其暴露的 5 个工具。
2. **让 Luna 启动任务**：
   - 👤 用户：“*帮我启动一次代码全面质量扫描任务*”
   - 🐱 Luna 派发 `create_and_run_session`，参数 `{ name: "代码质量扫描", taskType: "code_inspection" }`。
   - 📊 服务实时推送：
     - `15% - 代码静态语法与规范检查 (Biome/ESLint) - 处理中...`
     - `40% - 类型系统与模块边界依赖审查 (TypeScript & Seams)...`
     - `75% - 运行核心单元测试与覆盖率统计...`
   - 🎉 完成后，桌面 Muse 宠物弹出气泡：“*🎉 会话「代码质量扫描」已顺利完成全部 4 个步骤！*”
3. **随时询问进度**：
   - 👤 用户：“*刚才的代码检查任务完成了吗？*”
   - 🐱 Luna 调用 `query_session_progress` 获取最新百分比并汇报给用户。

---

## 🧪 运行测试

```bash
bun test examples/muse-session-manager/session-manager.test.ts
```

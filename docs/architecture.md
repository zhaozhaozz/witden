# 架构说明

witden 的原则是**外部编排、内部执行**：平台进程负责身份、话题、权限、任务状态和模型调用；真正“动手”的操作都发生在角色自己的虚拟电脑里，由虚拟电脑内的 Computer Runner 执行。代码路径均相对 `packages/`。

## 进程与包

| 进程 / 包 | 职责 | Docker 权限 |
|---|---|---|
| `server`（`--role api`） | REST API、控制台、SSE 事件流、Runner Hub（WebSocket，默认 :8330）、执行网关、Slack/飞书 webhook、入站队列消费 | 无；通过 HTTP 请求 Manager |
| `server`（`--role worker`） | 领取任务、Agent 循环、模型调用、出站投递 | 无；经 API 的执行网关访问虚拟电脑 |
| `manager` | 唯一持有 Docker 的服务：创建/启停/删除/备份/恢复虚拟电脑、资源统计、stdio Runner 通道 | 有（只挂在它身上） |
| `runner` | 每台虚拟电脑里一个进程（非 root）：命令、终端、文件、屏幕、键鼠、浏览器、请求日志；可选的虚拟电脑内模型代理 | 无 |
| `shared` | Runner 协议、Manager 协议（类型与编解码） | — |
| `web` | React 管理控制台（noVNC 实时画面） | — |

`--role all`（默认）把 API 和 Worker 放在一个进程里，适合单机开发；数据库默认是嵌入式 PostgreSQL（PGlite），团队部署用 PostgreSQL。

## 核心对象（`server/src/db/schema.ts`）

| 对象 | 说明 |
|---|---|
| 虚拟电脑模板 `computer_templates` | 镜像、运行用户（禁止 root）、工作目录、持久化路径、凭据路径、默认资源；每次修改 `version + 1`。 |
| 虚拟电脑实例 `computer_instances` | 一个容器 + 若干命名卷；保存模板快照（`spec`）；记录 Runner 令牌哈希（每次重建容器重新签发）和 Runner 连接状态。 |
| 模型服务商 `model_providers` / 模型 `model_configs` | 服务商 = 地址、协议（OpenAI 兼容或 Anthropic）、加密密钥；一个服务商下有多个模型（从服务商的模型列表接口获取或手动填写），每个模型有自己的参数、能力检测结果和每日额度。角色、授权、用量和话题限制都指向模型。 |
| AI 角色 `roles` | `@handle`、提示词、模型、**唯一的虚拟电脑实例**、工具组、可联系角色、需审批工具。 |
| 话题 `topics` | 协作空间；`kind=dm` 为一人一角色私信。 |
| Agent 会话 `agent_sessions` | 每个“角色 × 话题”一个，保存该话题里已交付结论的摘要（`notes`）。角色在不同话题互不串上下文。 |
| 任务 `tasks` | 请求人、负责角色、**固定的虚拟电脑实例**、权限信封、信息流标签、状态、队列租约（`claimed_by`、`lease_until`）。 |
| 工具调用 `tool_calls` | 执行网关的操作日志：`dispatched → completed / failed / uncertain`，ID 同时是 Runner 侧的幂等键。 |
| 入站事件 `processed_events` | 入站队列兼去重表：先落库后确认，处理完清空正文。 |

## 一条消息如何变成工作

```
Slack webhook ─验签─► processed_events（queued，去重）─► 200 ─► processInbound（SKIP LOCKED 领取）
控制台消息 ────────────────────────────────────────────────┐            │
                                                            ▼            ▼
                         agent/dispatch：@提及 > 私信角色 > 线程里已在工作的角色 > 规则默认角色 > active 角色
                                │ services/assignment（限制取交集、deny 优先、默认取最具体）
                                │ authorize + preflight（role.use、实例、模型、话题限制）
                                ▼
                         createTask：固定 instance_id、计算 envelope、绑定 agent_session ─► pg_notify(witden_wake)
                                ▼
                         Worker.claimNext（FOR UPDATE SKIP LOCKED + 5 分钟租约 + 心跳）
                                ▼
                         TaskRunner：模型 ↔ 工具循环，每步写入 task_steps
                                │ 工具 ─► GatewayClient ─► ExecutionGateway ─► RunnerHub ─► 虚拟电脑里的 Runner
                                ▼
                         agent/output.deliver（信息流检查，必要时暂扣审批）─► 话题消息 ─► 出站队列 ─► Slack
```

事件（任务进度、消息、状态）在事务内 `pg_notify('witden_events')`，提交后才送达；SSE 接口对每个事件重新鉴权。NOTIFY 负载上限是 8000 字节（按字节算，中文每字 3 字节），超长事件会截短并标记 `truncated`，控制台收到后再取完整消息。

角色工作时，TaskRunner 在话题频道上发布不落库的 `task.live` 事件（`agent/live.ts`）：每次模型调用开始发 `thinking`；模型流式输出时按约 120 ms 一批发 `writing`（带 `offset` 和 `delta`，迟到的观看者能发现缺口）；执行工具前发 `tool`（只有工具名，不含参数）。流式文本与最终回答遵循同一条信息流规则：任务读过的材料不能在这个话题展示时（`textRestricted`），只发“思考中/正在使用工具”，不发文本。模型适配器在有人订阅文本时请求流式输出（OpenAI 兼容 `stream` + `stream_options.include_usage`，Anthropic `stream`），服务端拒绝流式（400/422）时对该模型退回普通请求。

## 执行边界

- **执行网关**（`server/src/compute/gateway.ts`）是 AI 到虚拟电脑的唯一通道。每次操作检查：操作所属工具组在任务信封内、任务仍在运行、角色仍属于任务固定的那台虚拟电脑、虚拟电脑在运行且没有人类接管、紧急停止未生效、桌面操作持有控制租约。然后写 `tool_calls` 再发往 Runner。
- 独立部署的 Worker 用 `HttpGatewayClient` 调 `POST /internal/gateway/{execute|recover}`（`WITDEN_INTERNAL_TOKEN`），自己既不连 Docker 也不连 Runner。
- **Runner Hub**（`server/src/compute/hub.ts`）：Runner 主动拨入 `ws://witden-hub:8330/runner`，`hello` 携带实例 ID 和令牌，与数据库中的哈希比对；没有网络路由的虚拟电脑（`internal`/`none` 网络）经 Manager 的 `docker exec` stdio 通道连接，帧格式相同。VNC 等虚拟电脑内的端口通过同一连接的二进制流隧道转发。
- 虚拟电脑不可用时任务进入等待，超时失败；恢复后**重放同一个工具调用**，不会换到别的虚拟电脑，也没有宿主机执行路径。

## 虚拟电脑内部（`runner/`、`images/`）

- **命令与终端**：`exec.run` 一次性执行（输出截断保留首尾）；终端会话基于 tmux，带会话 ID，可输入、读取、按键、终止整棵进程树。
- **桌面**：Xvfb + Fluxbox；截图（ImageMagick）和键鼠（xdotool）；两个只监听 localhost 的 VNC：5900 控制、5901 只读。
- **浏览器**：`desktop` 模式驱动桌面上可见的 Chromium（人能看到、能接管）；`background` 模式用无头浏览器，不占桌面。通过 CDP（playwright-core）操作，快照给出元素引用。
- **虚拟电脑里的其他程序**：平台只运行自己的智能体。人或角色可以用命令和终端在虚拟电脑里安装、运行任何程序（包括别的智能体），平台不单独管理它们；它们能做的事以这台虚拟电脑本身的边界为准。
- **模型代理（可选）**：按虚拟电脑开启（`computer_instances.model_proxy_*`）。Runner 在 `127.0.0.1:8686` 提供 OpenAI 兼容（`/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`、`/v1/responses`、`/v1/models`）和 Anthropic（`/v1/messages`）接口，把每个 HTTP 请求经自己的连接转给平台（`proxy.request` → `proxy.response`/`proxy.chunk`/`proxy.end`，流式回答保持流式）。平台（`server/src/compute/model-proxy.ts`）核对这台虚拟电脑的签发密钥（`wdm_…`）和允许的模型、检查模型启停与每日额度，再用服务商的真实地址和密钥调用，并按虚拟电脑记录用量。Runner 把虚拟电脑内的地址和签发密钥写入 `~/.config/witden/model-proxy.env`，镜像让登录和交互 shell 自动加载（`OPENAI_BASE_URL`、`OPENAI_API_KEY`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY`、`WITDEN_MODELS`）。
- **请求日志**：每个请求按 ID 记录结果，重复 ID 返回已存结果；`journal.get` 让平台在断线后查询“这个操作到底执行了没有”。
- Runner 拒绝以 root 运行；它启动的进程环境中去掉 Runner 令牌。

## 共享虚拟电脑的协调

- 命令可以并行；鼠标键盘需要**桌面控制租约**（`services/leases.ts`），按任务的一段连续运行持有，任务等待、暂停或结束即释放，也可用 `release_desktop` 主动释放。截图不需要租约。
- 人类接管（`takeover`）抢占租约并暂停这台虚拟电脑上的 AI 任务；`handback` 只能由接管者执行。实时画面观察者永远走只读 VNC，只有接管者能连控制端口，由服务端决定。接管租约只有 3 分钟，由控制台在人有操作时每分钟续期（`/takeover/keepalive`）；人离开页面、浏览器标签在后台超过 30 秒或 5 分钟没有操作时控制台主动交还，浏览器直接关掉则租约过期后由 Worker 交还（`expireTakeovers`），暂停的 AI 工作随之恢复。

## 不确定状态恢复

- 有副作用的操作在连接中断时**不盲目重试**：Worker 先经执行网关查询 Runner 的请求日志（短暂等待重连）。已完成就把真实结果交给模型；仍在执行或查不到就如实告诉模型“结果不确定”，要求先检查当前状态再决定。
- 只读操作或从未送达的操作可以安全重放。
- Worker 崩溃：租约过期后任务由其他 Worker 接手，从 `task_steps` 继续；中断的工具调用同样先查请求日志。

## 权限模型

1. **授权**：默认拒绝。`role.use`、`role.invite`、`instance.*`、`secrets.manage`、`rules.manage`、`approval.decide`、`topic.publish` 等分别授予（`security/permissions.ts`），可限定到具体资源。管理员能管理，但读不到自己未参与的私密话题和私信内容。
2. **任务信封**：`工具组 = 角色工具组 ∩ 委托方信封`；可联系角色、知识空间同样取交集；需审批工具取并集。委托只能缩小权限。
3. **信息流标签**（`security/labels.ts`）：任务读到的资料带来源标签（`topic:`、`user:`、`space:`）；输出前检查“目标受众 ⊆ 每个来源的可读者”，不满足就暂扣，交给资料所有者审批。Slack 公开频道的受众是整个工作区；成员未知或超过 30 分钟未刷新的私有会话按整个工作区处理。
4. **撤销即时生效**（`agent/revocation.ts`）：撤销授权、停用成员、移出话题后重新检查进行中的任务；紧急停止按全局/角色/实例/话题/连接/任务生效，覆盖整条委托链。

## 可靠性

- 任务队列、入站队列、出站投递都在 PostgreSQL 中，用 `FOR UPDATE SKIP LOCKED` 领取，多进程安全；唤醒走 `pg_notify('witden_wake')`，另有定时兜底。
- 入站事件先落库后确认；出站按“消息 × 目标会话”幂等，失败可见、可重试且不会重复发送。
- 事务很短：模型调用和虚拟电脑操作都在事务之外执行。

## 目录

```
packages/
  shared/    runner-protocol.ts、manager-protocol.ts
  runner/    core.ts（分发、日志）、ops/（exec、terminal、files、desktop、browser、agents、system）、transports/
  manager/   docker-manager.ts、validate.ts、http-server.ts、client.ts、main.ts
  server/    api/、agent/、compute/（hub、gateway）、integrations/、security/、services/、db/、drizzle/（迁移）
  web/       管理控制台
images/      虚拟电脑镜像：shell、desktop（从仓库根目录构建）
```

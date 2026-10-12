# witden

**一个面向团队、可自托管的开源 AI 员工协作平台。**

在 witden 里，你可以创建多台基于 Docker 的“云电脑”，为每台电脑配置多个 AI 角色。每个角色有自己的身份、职责、提示词和模型，只在自己的电脑里执行命令、读写文件、操作桌面和浏览器；它们在话题中与同事和其他角色协作，也可以通过 Slack 参与团队工作。

它的定位是“团队里的 AI 员工”，而不是某个人的私人助手：同一个角色可以为多位获授权的成员工作，但不会混用他们的私密信息。

## 架构一句话

**外部编排，内部执行。** 平台（API、Worker）负责身份、话题、权限、任务状态和模型调用；每台云电脑里运行一个 Computer Runner，负责真正的命令、终端、文件、屏幕、键鼠和浏览器操作。只有独立的 Docker Manager 持有 Docker 权限。平台只管理自己的智能体；电脑里装什么程序（包括别的智能体）由人或角色自己决定。全部使用 TypeScript（Node.js 22）实现。

```
Slack / 飞书 / 控制台 ──► API（REST、事件流、Runner Hub、执行网关）──► PostgreSQL（任务、队列、通知）
                               ▲          │ HTTP                            ▲
                     执行网关   │          ▼                                 │ 领取任务
                               │     Docker Manager ──► Docker              Worker（Agent 循环、模型调用）
                               │                         │
                               └──── WebSocket ◄── 云电脑：Computer Runner（非 root）
```

## 主要能力

- **云电脑**：可设颜色；模板（版本化）→ 多个独立实例；启动、停止、重启、重置、删除、备份、恢复、克隆（默认剔除凭据）；资源限制与实时占用；电脑内一律以非 root 用户运行。
- **Computer Runner**：命令执行、带 ID 的终端会话（进程树终止）、文件、X11 截图与键鼠（xdotool）、桌面浏览器与后台浏览器；请求按 ID 记日志，重连后可查询“上一个操作到底执行了没有”。
- **电脑内的模型访问（可选）**：按电脑开启后，电脑里的程序通过本机地址（OpenAI 兼容 / Anthropic 接口）和平台为这台电脑签发的密钥使用平台里的模型；请求经 Runner 回到平台，由平台检查密钥和允许的模型后用真实密钥转发。真实地址和密钥不进入电脑，签发的密钥离开这台电脑无效，用量按电脑记录。
- **人类视角**：noVNC 实时观看与接管同一个桌面；观察者永远连只读端口，接管会暂停这台电脑上的 AI 工作。
- **AI 角色**：名称、头像（可上传图片）、颜色、`@handle`、职责、提示词、模型和参数；工具组（命令、终端、文件、桌面、浏览器、协作、记忆、跨话题引用）。
- **徽章**：话题、消息、任务、审批等处用带颜色的徽章标出涉及的角色（头像、名称、@handle）和电脑，一眼能看出谁在哪台电脑上工作。
- **Agent 会话**：每个“角色 × 话题”一个会话，保存该话题里已交付的结论摘要；角色之间通过平台话题协作，不共享私有上下文。
- **执行边界**：AI 的所有操作经执行网关进入**任务固定的那台电脑**；电脑不可用时等待或失败，绝不回退到宿主机或其他电脑。
- **不确定状态恢复**：连接中断时不盲目重复上一步；有副作用的操作先向 Runner 查询结果，查不到就如实告诉模型“结果不确定”，由它先检查再决定。
- **权限贯穿全程**：默认拒绝的授权；委托只能缩小权限；输出前做信息流检查（私信资料不会进入群聊，除非资料所有者批准）；撤销与紧急停止即时生效；全链路审计。
- **Slack / 飞书**：一个 thread 对应一个话题；一个机器人代表多个角色；快速确认、入队处理、去重、防回环、发送失败可见可重试。飞书为实验性接入。
- **模型自带**：按“服务商 → 模型”管理。一个服务商（OpenAI 兼容接口如 vLLM、Ollama、DeepSeek，或 Anthropic 接口）对应一个地址和密钥，下面可以有多个模型，模型从服务商接口获取后勾选，也可手动填写；密钥加密存储、可更新与撤销，换地址自动清除旧密钥；每个模型可检测对话、工具调用和图像理解能力。

## 快速开始（本机，一个进程）

需要 Node.js 22+ 与 Docker。数据库默认使用嵌入式 PostgreSQL（PGlite，数据在 `./data`），无需另装。

```bash
npm ci
make images                     # 云电脑镜像：witden/computer-shell、witden/computer-desktop
npm run build                   # 编译各包与控制台
export WITDEN_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
export WITDEN_BOOTSTRAP_ADMIN_PASSWORD=change-me-please
node packages/server/dist/cli.js serve   # http://localhost:8320 ，Runner Hub 监听 :8330
```

登录后建议按顺序：

1. **模型**：添加服务商（地址、协议、密钥），从接口获取模型列表勾选或手动填写模型，再对模型点击“检测能力”。
2. **电脑**：模板页点击“导入内置模板”，再从 `dev-shell` 或 `desktop-browser` 创建实例，等待 Runner 显示“已连接”。
3. **角色**：创建角色，选择模型、电脑和工具组。
4. **管理 → 成员与授权**：给成员授予 `role.use`（可以使用哪些角色）和 `role.invite`。
5. **话题**：创建话题、邀请角色，`@角色` 开始工作。

## Docker Compose 部署

```bash
cp .env.example .env            # 填写管理员、WITDEN_SECRET_KEY、各进程间令牌、POSTGRES_PASSWORD、DOCKER_GID
make images platform
docker compose up -d            # db、manager、api、worker
```

只有 `manager` 挂载 Docker socket；`worker` 没有任何 Docker 权限，只通过 API 的执行网关访问电脑。部署前请阅读 [docs/security.md](docs/security.md)。

## 文档

- [架构说明](docs/architecture.md)：进程与包、请求如何变成工作、执行边界、可靠性
- [安全说明](docs/security.md)：平台保证与部署方责任、已知限制
- [接入 Slack](docs/slack.md)：App 清单、连接、规则与身份绑定

## 开发

```bash
npm test                 # 快速测试（模拟电脑 + 嵌入式 PostgreSQL）
make test-docker         # 另含真实 Docker、云电脑镜像和端到端测试
make lint                # biome + 各包类型检查
npm run dev -w @witden/web   # 控制台开发服务器，/api 代理到 :8320
```

## 许可证

Apache-2.0

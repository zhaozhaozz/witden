# witden

**可自托管的开源 AI 员工平台：在控制台配置 AI 员工和虚拟电脑，让它们作为机器人在 Slack、飞书、GitHub 中工作。**

witden 让你拥有一组“AI 员工”。每位 AI 员工像一位同事，有自己的身份、人设、记忆和职责，用选定的模型在分配给它的**虚拟电脑**里执行命令、读写文件、操作桌面和浏览器。

管理员在网页控制台中配置 AI 员工和虚拟电脑，也可以直接在控制台里和 AI 员工对话。AI 员工还可以作为 Slack、飞书、GitHub 的机器人工作，为那里的成员、群和仓库服务：它像一个真实的同事，同时处理多个群和多个人的会话，而不是某一个人的私人助手。控制台就像这些机器人自己的通讯软件，它们在各处的会话都汇集在这里。

## 核心概念

| 概念 | 说明 |
|---|---|
| 虚拟电脑 | 基于 Docker 的隔离环境，从模板创建，可以是命令行环境或带图形桌面和浏览器的环境。AI 员工的所有操作都只发生在虚拟电脑内。 |
| AI 员工 | 由 AI 驱动的同事，像人一样有自己的人设、记忆和职责：人设（性格、语气、工作规则和约束）写在“人设与工作方式”中，只有它自己读到；记忆见下文；职责写在“职责说明”中，成员、其他 AI 员工和话题调度据此了解可以找它做什么。另外配置名称、头像、模型、所在的虚拟电脑和工具权限。接口和配置中称为 role（例如 `/api/roles`、`role_id`）。内置的系统管理员（@admin）也是一位 AI 员工，始终存在，只在控制台中工作，负责 witden 自身的配置。 |
| 话题 | 一段会话：控制台里围绕一件事情的协作，一个 Slack 频道（其中的 thread 显示为回复）、一个飞书群聊（其中的消息串显示为回复）或一段私信，或 GitHub 上的一个 issue 或 pull request。控制台里还有私信：管理员与某位 AI 员工之间一直保留的一对一对话；以及 AI 员工对话：两位 AI 员工之间在话题之外的直接对话，管理员只能查看。 |
| 管理员与外部成员 | 能登录控制台的账号都是管理员，可以看到全部会话。Slack、飞书中未关联到管理员账号的人，可以作为外部成员使用接入的机器人代表的 AI 员工，彼此的私信相互隔离。 |
| 对话 | AI 员工在每个话题、每个私信里各有一段对话：上下文从一条消息延续到下一条，不同话题之间互不相通。AI 员工工作时收到的新消息会在它的下一步交给它；对话变长时，AI 员工把前面的内容整理成摘要继续工作。 |
| 记忆 | AI 员工需要长期保留的内容，按适用范围分为两种：话题记忆只在一个话题或私信中使用，AI 员工记忆属于 AI 员工本身、在它工作的所有地方都适用。管理员还可以在知识空间中维护团队知识供 AI 员工检索。 |
| 技能 | AI 员工做某类工作的方法，例如怎样发布版本、怎样审查这个项目的代码：由名称、说明（什么时候用）、Markdown 写成的具体做法，以及可选的脚本、模板等文件组成。名称和说明随系统提示词给出，遇到相应的工作时 AI 员工读取全文照做，技能的文件同时写入它的虚拟电脑，脚本由它在那里运行。 |
| 任务 | AI 员工单独开展的一项工作：从对话中拆出的较大工作，或委托给同一话题中其他 AI 员工的工作，有自己的上下文，完成后结果回到对话。任务记录请求人、执行过程、所用的虚拟电脑和结果，可以补充要求或取消，也可以由人或 AI 员工转交给同一话题中的其他 AI 员工。 |
| 审批 | 需要人工确认的操作，以及需要资料所有者同意才能公开的内容。 |

## 主要功能

**会话**
- 话题只需设置标题和目标：目标写明这个话题是做什么的、工作有哪些要求，话题中的每位 AI 员工和调度模型都会参考。话题和外部频道可以挂接 Webhook 或带时区的定时计划，交给指定的 AI 员工处理（外部频道中就是机器人代表的 AI 员工）。Webhook 统一在“通讯接入 → Webhook 来源”中管理地址和密钥，一个来源可以供多个话题的触发器共用，支持 JavaScript 前置过滤、原始请求历史和事件去重；AI 员工可以查询当前话题的历史请求，有权限的 AI 员工可以管理自己负责的触发器。详见[使用指南](docs/user-guide.md#28-webhook-与定时触发)。
- 协作范围由话题决定：同一话题中的 AI 员工可以互相 @、委托任务，也可以把整项任务转交给对方，不需要权限和审批，工作不会交给不在话题中的 AI 员工；人转交任务时也只能交给话题中的 AI 员工，需要时先把 AI 员工邀请进话题。Slack、飞书、GitHub 的会话可以与控制台中的话题关联：会话中机器人代表的 AI 员工用 `send_message` 把需要处理的工作交给关联的话题，由那里的 AI 员工完成后发回结果；关联只能建立在外部会话与内部话题之间，不会转发历史，也不开放对方话题的记录。已完成的独立任务可以补充要求，在原来的上下文和虚拟电脑上接着做，再交付一次结果。详见[AI 员工协作、Webhook 来源与任务续做](docs/topic-collaboration.md)。
- AI 员工之间可以在话题之外直接对话：管理员在 AI 员工设置中逐个允许“A 可以找 B”后，A 可以直接给 B 发消息，B 按自己的权限处理，回复回到 A 发消息的地方。授权只在一个方向上生效，回复不需要授权；双方只交换消息，看不到对方的话题和记录。这些对话在侧边栏的“AI 员工对话”中，管理员可以查看，不能发言。详见[使用指南](docs/user-guide.md#29-ai-员工之间的对话)。
- AI 员工可以积累技能：把发布、代码审查、使用内部工具等工作的做法写成技能，连同要用到的脚本和文件，每次工作时都看到技能的名称和说明，需要时读取全文照做，并在自己的虚拟电脑中运行技能的脚本。AI 员工可以在管理员请求的工作中自己新建和改进技能，管理员也可以在控制台中查看和修改、下载和导入技能包；复制 AI 员工时一并复制。详见[使用指南](docs/user-guide.md#46-技能)。
- 控制台汇集 AI 员工的全部会话，按来源分组：控制台里的话题与私信，Slack 频道、飞书群聊和私信，GitHub 上的 issue 和 pull request；所有管理员都可以查看，加入话题的 AI 员工可以阅读全部历史。
- 控制台话题的 AI 员工响应方式在话题顶部切换：“主动 @”（默认）只在 AI 员工被 @ 时响应；“自动”模式下，没有 @ 的消息也可以由 AI 员工处理——只有一位 AI 员工时由它判断是否需要回复，有多位 AI 员工时由调度模型决定交给哪些 AI 员工。Slack、飞书、GitHub 的会话中只有机器人代表的那一位 AI 员工工作。
- 消息支持 Markdown、图片和 Mermaid 流程图；AI 员工工作时实时显示思考状态、正在使用的工具和逐字生成的回答。
- 接入 Slack（飞书为实验性支持）：一个频道对应一个话题，和 Slack 中看到的一致，thread 中的消息显示为回复；AI 员工在提问的地方回答，也可以像人一样连续发几条消息。消息格式自动转换：Slack 转为它的格式，飞书以富文本显示 Markdown（标题、列表、表格、代码块等）。Slack、GitHub、飞书都由控制台按步骤引导设置（GitHub App 一键创建）。Slack 默认使用 Socket Mode、飞书默认使用长连接，都由 witden 主动连到平台，不需要公网地址。AI 员工还可以经 witden 受控地使用飞书的日历、文档与知识库、多维表格、电子表格、视频会议和任务，按公司和功能授权，飞书应用的凭据不交给 AI 员工。接入 GitHub 等需要公网地址时，公网只开放单独的事件端口，控制台留在内网；没有公网 IP 时，可以使用 Docker Compose 中可选的 Cloudflare Tunnel 服务。
- 接入 GitHub（GitHub App 或机器人账号）：在 issue 或 pull request 中 @ 机器人即可让 AI 员工工作，回复以评论发回；公开仓库中的内部资料需要批准才会发出。AI 员工还可以经 witden 以接入的账号或 App 的身份读代码、处理 issue 和 pull request、查看和触发 Actions，按接入和类别授权；只想让 AI 员工代替某个人操作时，可以把这个人的账号设为“只作为认证”，不当机器人使用。

**虚拟电脑**
- 版本化模板，从模板创建多个独立实例；支持启动、停止、重启、重置、删除、备份、恢复和复制，复制时默认不带账号凭据。
- 在网页中实时观看桌面；管理员可以接管鼠标和键盘，接管期间这台虚拟电脑上的 AI 工作暂停，离开或长时间不操作时自动交还。
- AI 员工执行的命令不会因等待超时而被结束：超过等待时间的命令转到后台继续运行，多条命令可以同时运行，结束时 AI 员工收到通知；完整输出保存在虚拟电脑的日志文件中。
- 可选的模型访问：虚拟电脑里的程序可以通过平台使用已配置的模型，真实的服务地址和密钥不会进入虚拟电脑。

**安全与治理**
- 能登录控制台的只有管理员；Slack、飞书中未关联的人默认不能使用 AI 员工，开启后作为外部成员只能使用接入的机器人代表的 AI 员工，并且不能登录控制台。
- 内置的系统管理员（@admin，始终存在，不能停用或另外添加）：在控制台中通过对话完成 witden 的配置（AI 员工、模型、虚拟电脑、通讯接入、知识；账号只由人管理），以提问的管理员身份操作并记入审计；它不处理 Slack、飞书、GitHub 的消息，其他 AI 员工也不能把工作交给它。
- 密钥在任何地方都读不出来：模型 API Key、通讯接入凭据、Tunnel token、虚拟电脑的模型访问密钥只能由人在控制台中填写或更换，界面和接口只显示是否已设置，系统管理员也读不到、改不了。例外是 Webhook 来源的密钥：由系统生成，管理员可以在控制台中随时复制，AI 员工仍然读不到。
- 工具权限分为“始终允许 / 询问 / 禁用”。新建的 AI 员工默认：在自己虚拟电脑里的操作和维护自己的技能始终允许，自动化管理、记忆和修改自己的职责说明需要询问。AI 员工只读取它所在话题的消息：了解其他话题只能经话题关联或与被允许的 AI 员工直接对话；私信始终只属于它的人和 AI 员工。
- AI 员工能读取哪些资料由它的权限决定（知识空间、飞书和 GitHub 工具）：有权读取的内容，AI 员工可以在它工作的任何地方使用，包括发到 Slack、飞书和 GitHub。需要限制时，收窄 AI 员工的权限，或把相应工具设为“询问”。
- AI 的操作只能进入 AI 员工所在的那台虚拟电脑，从不在服务器上直接执行；虚拟电脑不可用时工作等待或失败，不会改用其他机器。
- 紧急停止即时生效；所有关键操作记录审计。

**模型**
- 按“服务商 → 模型”管理：对话模型支持 OpenAI 兼容接口（如 vLLM、Ollama、DeepSeek）和 Anthropic 接口；模型可以从服务商获取列表后选择，也可以手动填写。
- 可检测模型的对话、工具调用和图像理解能力以及响应时间；按 AI 员工和模型设置每日 token 额度，并统计用量。
- 模型的上下文长度、思考程度等资料取自 [models.dev](https://models.dev)，在模型页一键更新：优先使用模型厂商官方的资料；服务商本身是 models.dev 收录的第三方（如 OpenRouter）时，使用这家第三方的资料。
- 添加模型服务时可以直接选择常见服务（OpenAI、Anthropic、DeepSeek、通义千问、Kimi、智谱、OpenRouter 等），只需填写 API Key；首次使用引导与模型页使用同一套界面。
- AI 员工可以设置思考程度（effort）：模型服务报告了某个模型支持的等级时（如 Anthropic、DeepSeek、OpenRouter），只列出这些等级；服务不报告时，使用模型资料（[models.dev](https://models.dev)）中列出的等级，或列出常见等级。各种接口按自己的参数发送；DeepSeek 等返回的思考内容会在后续请求中带回。
- 支持 System 1 决策模型（System One 接口）：TypeSafe Jev 和开源的 Laya。它们针对给定内容回答选择题并给出概率，响应快，推荐用作话题调度模型；也可以用普通对话模型调度，它会参考前几条消息。Laya 可以作为 Docker Compose 的可选服务一起部署。

## 系统组成

witden 采用“外部编排、内部执行”的设计：平台负责身份、话题、权限、任务和模型调用；每台虚拟电脑里运行一个执行代理（Runner），负责真正的命令、文件、屏幕、键鼠和浏览器操作；只有独立的 Docker Manager 服务能够管理容器。详见[系统架构](docs/architecture.md)。

```
Slack / 飞书 / 网页控制台
          │
          ▼
   API 服务 ───────► Docker Manager ───► Docker（虚拟电脑容器）
     │   ▲                                        │
     │   └──────────── 执行代理（Runner）连接 ◄────┘
     ▼
 PostgreSQL ◄─── Worker（运行 AI 员工、调用模型）
```

## 快速开始

使用 Docker Compose 和预先构建好的镜像启动 witden，不需要下载源码，也不需要安装 Node.js。需要一台 x86-64 Linux 主机，已安装 Docker 和 Docker Compose 插件。

**第一步：创建 `docker-compose.yml`。** 新建一个目录（例如 `witden`），在其中创建 `docker-compose.yml`，内容如下（展开后复制），与仓库中的 [`docker-compose.yml`](docker-compose.yml) 相同。

<details>
<summary>docker-compose.yml</summary>

```yaml
# Single-host deployment: PostgreSQL, the API, the worker and the Docker Manager.
# Write .env first (the README quick start shows the required settings; .env.example lists them all), then:
#   docker compose --profile images pull    # the platform and computer images, published by .github/workflows
#   docker compose up -d
# WITDEN_IMAGE_REPO / WITDEN_IMAGE_TAG choose where the images come from (default: ghcr.io/zhaozhaozz/witden,
# latest). To build them from this checkout instead, set WITDEN_IMAGE_REPO=witden and run `make images platform`.
#
# Only the manager mounts the Docker socket. The API asks it for computer lifecycle over HTTP; the worker
# has no Docker access at all and reaches computers only through the API's execution gateway. Computers
# dial back to the runner hub (port 8330) through the host gateway. Read docs/security.md before exposing
# this to a team (rootless Docker, a dedicated host or VM, or gVisor are recommended).

x-platform: &platform
  build: .
  image: ${WITDEN_IMAGE_REPO:-ghcr.io/zhaozhaozz/witden}/platform:${WITDEN_IMAGE_TAG:-latest}
  restart: unless-stopped

services:
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: witden
      POSTGRES_USER: witden
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
    volumes:
      - witden-db:/var/lib/postgresql/data
    networks: [control]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U witden -d witden"]
      interval: 5s
      retries: 20

  manager:
    <<: *platform
    command: ["node", "packages/manager/dist/main.js"]
    # Only its own settings (no platform secrets) plus the Docker socket's group: DOCKER_GID=$(stat -c %g /var/run/docker.sock)
    group_add: ["${DOCKER_GID:?set DOCKER_GID in .env}"]
    environment:
      WITDEN_MANAGER_TOKEN: ${WITDEN_MANAGER_TOKEN:?set WITDEN_MANAGER_TOKEN in .env}
      WITDEN_MANAGER_HOST: 0.0.0.0
      WITDEN_MANAGER_DATA_DIR: /data/manager
    volumes:
      - witden-manager:/data
      # The runner the computers run: installed here from this image at start, mounted read-only into every
      # computer by the manager (packages/manager/src/live-runner.ts).
      - witden-runner:/opt/witden/runner-live
      - ${DOCKER_SOCKET:-/var/run/docker.sock}:/var/run/docker.sock
    networks: [control]

  api:
    <<: *platform
    command: ["node", "packages/server/dist/cli.js", "serve", "--role", "api"]
    env_file: .env
    environment:
      WITDEN_DATABASE_URL: postgres://witden:${POSTGRES_PASSWORD}@db:5432/witden
      WITDEN_MANAGER_URL: http://manager:8340
      # fixed inside the container; WITDEN_PORT only chooses the published host port
      WITDEN_PORT: "8320"
      WITDEN_WEBHOOK_PORT: "8325"
      WITDEN_HUB_PORT: "8330"
      # Cloudflare Tunnel (the "tunnel" service below): the console writes its token here
      WITDEN_TUNNEL_TOKEN_FILE: /tunnel/token
      WITDEN_TUNNEL_METRICS_URL: http://tunnel:2000
      # the tunnel forwards to the webhook listener only, never to the console
      WITDEN_TUNNEL_ORIGIN: http://api:8325
      # the built-in templates create computers from <repo>/computer-shell:<tag> and computer-desktop
      WITDEN_IMAGE_REPO: ${WITDEN_IMAGE_REPO:-ghcr.io/zhaozhaozz/witden}
      WITDEN_IMAGE_TAG: ${WITDEN_IMAGE_TAG:-latest}
    ports:
      # Console and API: keep it on the internal network.
      - "${WITDEN_PORT:-8320}:8320"
      # Event webhooks only (Slack, GitHub, Feishu): the one port a public address may forward to. Bound to
      # loopback for a reverse proxy on this host; set WITDEN_WEBHOOK_BIND to publish it elsewhere.
      - "${WITDEN_WEBHOOK_BIND:-127.0.0.1}:8325:8325"
      # Runner hub: computers reach it as witden-hub (host gateway). Bind to the Docker bridge address to
      # keep it off other interfaces, e.g. WITDEN_HUB_BIND=172.17.0.1
      - "${WITDEN_HUB_BIND:-0.0.0.0}:8330:8330"
    volumes:
      - witden-data:/data
      - witden-tunnel:/tunnel
    depends_on:
      db: { condition: service_healthy }
      manager: { condition: service_started }
    networks: [control]

  worker:
    <<: *platform
    command: ["node", "packages/server/dist/cli.js", "serve", "--role", "worker"]
    env_file: .env
    environment:
      WITDEN_DATABASE_URL: postgres://witden:${POSTGRES_PASSWORD}@db:5432/witden
      WITDEN_API_URL_FOR_WORKER: http://api:8320
    volumes:
      - witden-data:/data
    depends_on:
      db: { condition: service_healthy }
      api: { condition: service_started }
    networks: [control]

  # Optional: the open-source Laya decision model (a System 1 model) for the topic dispatcher, on CPU.
  # Turned on by COMPOSE_PROFILES=laya in .env; with WITDEN_LAYA_URL=http://laya:8000 the platform adds it
  # under Models (and as the dispatcher when none is set). Reachable only on the control network.
  laya:
    build: { context: images/laya }
    image: ${WITDEN_IMAGE_REPO:-ghcr.io/zhaozhaozz/witden}/laya:${WITDEN_IMAGE_TAG:-latest}
    profiles: ["laya"]
    restart: unless-stopped
    environment:
      LAYA_API_KEY: ${WITDEN_LAYA_API_KEY:-}
      LAYA_MODELS: ${LAYA_MODELS:-multilingual}
      LAYA_THREADS: ${LAYA_THREADS:-4}
    volumes:
      - witden-laya-cache:/home/laya/.cache/huggingface
    networks: [control]

  # Optional Cloudflare Tunnel: a public HTTPS address for the platform (Slack, GitHub and Feishu send events
  # to it) without opening ports or managing certificates. Idle until a tunnel token is pasted in the console
  # (Connections → Slack guide → public address), which writes it to the witden-tunnel volume; it then
  # connects, and follows a replaced or removed token by itself. Reachable only on the control network.
  tunnel:
    build: { context: images/tunnel }
    image: ${WITDEN_IMAGE_REPO:-ghcr.io/zhaozhaozz/witden}/tunnel:${WITDEN_IMAGE_TAG:-latest}
    restart: unless-stopped
    volumes:
      - witden-tunnel:/etc/witden-tunnel:ro
    depends_on:
      api: { condition: service_started }
    networks: [control]

  # The computer images used by the built-in templates; never started, only pulled or built with
  # `--profile images`. The manager also pulls a missing image when it creates a computer.
  computer-shell:
    build: { context: ., dockerfile: images/shell/Dockerfile }
    image: ${WITDEN_IMAGE_REPO:-ghcr.io/zhaozhaozz/witden}/computer-shell:${WITDEN_IMAGE_TAG:-latest}
    profiles: ["images"]
  computer-desktop:
    build: { context: ., dockerfile: images/desktop/Dockerfile }
    image: ${WITDEN_IMAGE_REPO:-ghcr.io/zhaozhaozz/witden}/computer-desktop:${WITDEN_IMAGE_TAG:-latest}
    profiles: ["images"]

networks:
  control: {}

volumes:
  witden-db:
  witden-data:
  witden-manager:
  witden-runner:
  witden-laya-cache:
  witden-tunnel:
```

</details>

**第二步：创建 `.env`。** 在同一目录中创建 `.env`，内容如下。把管理员邮箱和密码改成自己的，并填写空着的五项：

```dotenv
# 首次启动时创建的管理员账号
WITDEN_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
WITDEN_BOOTSTRAP_ADMIN_PASSWORD=change-me-please
# 在内网访问控制台的地址，消息中的链接指向这里
WITDEN_PUBLIC_URL=http://localhost:8320

# 主密钥，加密模型密钥和通讯凭据：openssl rand -base64 32
WITDEN_SECRET_KEY=
# 进程之间的令牌和数据库密码，任意足够长的随机字符串：openssl rand -hex 24
WITDEN_MANAGER_TOKEN=
WITDEN_INTERNAL_TOKEN=
POSTGRES_PASSWORD=
# Docker socket 所属的组：stat -c %g /var/run/docker.sock
DOCKER_GID=
```

空着的五项也可以在这个目录中执行下面的命令一次填好。它只填写还空着的项，重复执行不会替换已有的值：

```bash
sed -i \
  -e "s|^WITDEN_SECRET_KEY=\$|WITDEN_SECRET_KEY=$(openssl rand -base64 32)|" \
  -e "s|^WITDEN_MANAGER_TOKEN=\$|WITDEN_MANAGER_TOKEN=$(openssl rand -hex 24)|" \
  -e "s|^WITDEN_INTERNAL_TOKEN=\$|WITDEN_INTERNAL_TOKEN=$(openssl rand -hex 24)|" \
  -e "s|^POSTGRES_PASSWORD=\$|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" \
  -e "s|^DOCKER_GID=\$|DOCKER_GID=$(stat -c %g /var/run/docker.sock)|" \
  .env
```

请离线保存 `WITDEN_SECRET_KEY`：丢失后，已保存的模型密钥和通讯凭据无法解密；平台启动后也不要更换它和 `POSTGRES_PASSWORD`。其他可选配置（固定镜像版本、虚拟电脑连接端口的绑定地址、Laya 调度模型等）见 [`.env.example`](.env.example) 和[部署与配置](docs/deployment.md)。

**第三步：拉取镜像并启动。** 在这个目录中执行：

```bash
docker compose --profile images pull   # 平台镜像和两个虚拟电脑镜像
docker compose up -d
```

已经克隆了仓库时，`docker-compose.yml` 就在仓库中，在仓库目录里完成第二步和第三步即可。

镜像由本项目的 GitHub Actions 构建，发布在 `ghcr.io/zhaozhaozz/witden`。升级时，按第一步更新 `docker-compose.yml`，再执行第三步（已有虚拟电脑的更新方式见[升级](docs/deployment.md#6-升级)）。

启动后访问 <http://localhost:8320>，用 `.env` 中的管理员账号登录。第一次登录时，控制台会打开“欢迎使用 witden”引导：

1. **连接模型服务**：选择 OpenAI、Anthropic、DeepSeek、通义千问、Kimi、智谱、OpenRouter 或其他兼容服务，填写 API Key。
2. **选择模型**：从服务返回的列表中选择，或直接填写模型名称。witden 会检测模型能否对话、调用工具和理解图片。
3. **开始使用**：witden 自动创建一台桌面虚拟电脑和一个在这台电脑上工作的助手（@assistant），内置的系统管理员（@admin）还没有模型时也使用这个模型，然后打开与助手的私信。

之后可以：

- 在私信中让助手查资料、操作网页、整理文档；让系统管理员按你的要求添加 AI 员工、虚拟电脑或修改配置。
- 在“设置”中手动配置模型、虚拟电脑和 AI 员工，或新建话题并邀请 AI 员工协作。
- 接入 Slack，让 AI 员工作为机器人在 Slack 中工作，参见[接入 Slack](docs/slack.md)。

固定镜像版本、从源码构建镜像、以单进程方式试用和开发，以及生产环境的端口与 HTTPS 设置，参见[部署与配置](docs/deployment.md)。

## 文档

- [使用指南](docs/user-guide.md)：会话与 AI 员工协作、虚拟电脑、账号与审批
- [部署与配置](docs/deployment.md)：部署方式、首次配置、配置项、升级与备份
- [系统架构](docs/architecture.md)：组件、执行边界、可靠性设计
- [安全说明](docs/security.md)：平台提供的保护、部署方的责任、已知限制
- [接入 Slack](docs/slack.md)：创建 Slack App、连接、选择机器人代表的 AI 员工与身份关联
- [接入 GitHub](docs/github.md)：一键创建 GitHub App 或使用机器人账号、Webhook、在 issue 和 pull request 中使用、只作为认证的账号、GitHub 工具
- [接入飞书](docs/feishu.md)（实验性）：长连接或事件地址、创建企业自建应用、权限、事件订阅与版本发布
- [AI 员工协作、Webhook 来源与任务续做](docs/topic-collaboration.md)：协作方式概览、跨话题发送、AI 员工之间的直接对话、多个话题共用的事件来源、AI 员工自己管理触发器、已完成任务的补充要求
- [参与开发](CONTRIBUTING.md)：开发环境、测试与代码约定

## 许可证

Apache-2.0


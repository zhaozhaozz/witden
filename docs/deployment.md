# 部署与配置

本文介绍 witden 的部署方式、首次配置、配置项、升级与备份。部署前请先阅读[安全说明](security.md)。

## 1. 系统要求

- Linux 主机，已安装 Docker（Docker Compose 部署还需要 Compose 插件）。
- 从源码构建需要 Node.js 22 或更高版本。
- 资源：平台本身占用较少；每台虚拟电脑按模板中的资源限制占用 CPU、内存和磁盘，桌面虚拟电脑建议至少 1 个 CPU、2 GB 内存。

## 2. 部署方式

| 方式 | 适用场景 | 数据库 |
|---|---|---|
| 单进程 | 试用、开发 | 内置的嵌入式 PostgreSQL（数据保存在 `./data`） |
| Docker Compose | 团队使用 | 独立的 PostgreSQL 容器 |

### 2.1 单进程

```bash
npm ci
make images
npm run build
export WITDEN_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
export WITDEN_BOOTSTRAP_ADMIN_PASSWORD=change-me-please
node packages/server/dist/cli.js serve
```

一个进程同时提供网页控制台、API、Worker 和 Docker 管理功能。控制台默认监听 8320 端口，事件端口为 8325（见 2.4），虚拟电脑通过 8330 端口连接平台。

### 2.2 Docker Compose

Compose 部署包含以下服务，其中 `laya` 默认不启动，`tunnel` 在填写 token 之前不做任何事：

| 服务 | 作用 | 说明 |
|---|---|---|
| `db` | PostgreSQL | 只在内部网络中可访问。 |
| `manager` | Docker Manager | 唯一挂载 Docker socket 的服务，按白名单创建和管理虚拟电脑；启动时把平台镜像中的执行代理安装到数据卷 `witden-runner`，供各虚拟电脑只读使用（见第 6 节）。 |
| `api` | 控制台、API、事件接口、虚拟电脑连接入口 | 发布 8320（控制台，只在内网使用）、8325（事件端口，默认只发布在 127.0.0.1，见 2.4）和 8330（虚拟电脑连接）端口。 |
| `worker` | 运行 AI 员工、调用模型、发送外部消息 | 没有任何 Docker 权限，只通过 API 操作虚拟电脑。 |
| `laya`（可选） | 开源的 Laya 决策模型，用作话题调度模型 | 默认不启动，见 2.3。只在内部网络中可访问，不对外发布端口。 |
| `tunnel`（可选使用） | Cloudflare Tunnel，为平台提供公网 HTTPS 地址 | 在控制台填写 tunnel token 后才连接 Cloudflare，见 2.4。只主动向外连接，不对外发布端口。 |

部署步骤：

1. 复制配置文件并填写必填项：

   ```bash
   cp .env.example .env
   ```

   - `WITDEN_SECRET_KEY`：主密钥，用于加密模型密钥和通讯凭据。可用 `docker compose run --rm api node packages/server/dist/cli.js gen-key` 生成。
   - `WITDEN_MANAGER_TOKEN`、`WITDEN_INTERNAL_TOKEN`、`POSTGRES_PASSWORD`：任意足够长的随机字符串，例如 `openssl rand -hex 24`。
   - `DOCKER_GID`：Docker socket 所属的组，`stat -c %g /var/run/docker.sock`。
   - `WITDEN_BOOTSTRAP_ADMIN_EMAIL`、`WITDEN_BOOTSTRAP_ADMIN_PASSWORD`：首次启动时创建的管理员账号。
   - `WITDEN_PUBLIC_URL`：在内网访问控制台的地址，消息中的链接指向这里。GitHub，以及使用事件地址的 Slack、飞书接入需要的公网事件地址在控制台中设置和检查，见 2.4。

2. 构建虚拟电脑镜像和平台镜像：

   ```bash
   make images platform
   ```

3. 启动：

   ```bash
   docker compose up -d
   ```

4. 访问 `WITDEN_PUBLIC_URL`，用管理员账号登录，按第 3 节完成首次配置。

生产环境建议在控制台前放置 HTTPS 反向代理（见 2.4），并把 8330 端口只绑定到 Docker 网桥地址（设置 `WITDEN_HUB_BIND`，例如 `172.17.0.1`）。

### 2.3 可选：Laya 调度模型

话题设为“自动”且有多位 AI 员工时，需要一个调度模型（见[使用指南](user-guide.md#8-话题调度)）。可以直接选用已添加的对话模型；想要更快、更便宜的调度时，推荐 System 1 模型，如果不使用 TypeSafe Jev 等外部服务，可以随 Compose 一起部署开源的 Laya 模型。它在 CPU 上运行，不需要 GPU，一次判断通常不到 1 秒。

在 `.env` 中加入：

```bash
COMPOSE_PROFILES=laya
WITDEN_LAYA_URL=http://laya:8000
WITDEN_LAYA_API_KEY=<任意足够长的随机字符串>
```

然后执行 `docker compose up -d`。首次启动时 `laya` 服务会下载约 700 MB 的模型文件，保存在数据卷 `witden-laya-cache` 中，之后启动不再下载。平台启动时会把它添加到“设置 → 模型”中（服务商“Laya”，模型 `multilingual`）；如果尚未设置调度模型，同时把它设为调度模型。这一步对同一地址只做一次：之后删除这个服务商或更换调度模型，重启后不会被恢复。

不再需要时，从 `.env` 中删除这三行，执行 `docker compose rm -sf laya` 停止并删除该服务，再在控制台中删除该服务商、重新选择调度模型。

单进程部署也可以使用 Laya：自行运行 Laya 服务（`pip install "laya[serve]"` 后执行 `laya-serve`），并把 `WITDEN_LAYA_URL` 设为它的地址，例如 `http://127.0.0.1:8000`。

### 2.4 公网事件地址

控制台不对公网开放。Slack 默认使用 Socket Mode、飞书默认使用长连接，都由 witden 主动连到平台，不需要公网地址；GitHub，以及选择“事件地址（HTTP）”的 Slack、飞书接入，需要把事件推送到一个公网地址，为此 witden 有一个单独的**事件端口**（`WITDEN_WEBHOOK_PORT`，默认 8325）。它只提供：

- 各平台的事件接口 `/api/integrations/<平台>/<接入>/events`，每个接口都校验平台的签名或令牌；
- Webhook 来源的 `POST /api/hook-sources/<来源编号>`（话题的 Webhook 触发器都经来源接收），使用来源的 Bearer 密钥、`X-Webhook-Token` 或 Standard Webhooks 签名认证，单次正文最多 1 MiB；旧版本触发器的地址 `POST /api/hooks/<编号>` 继续可用，等同于同一编号的来源。管理来源和触发器、查询历史只在控制台端口提供；
- 公网地址的检查接口 `/api/integrations/probe`；
- Slack 安装回调 `/api/integrations/slack/oauth`：把一个 Slack 应用安装到其他工作区时，Slack 把安装人的浏览器带到这里，只完成控制台中发起的安装（见[接入 Slack](slack.md#10-slack-应用与多个工作区)）；
- AI 员工头像 `/api/avatars/<文件>`：以 AI 员工身份发言时，Slack 从它的服务器下载头像。头像本来就不需要登录，文件名是内容的哈希。

其他请求一律返回 404，包括控制台页面和所有管理接口。公网地址只能转发到这个端口。消息中“在 witden 中查看”等链接仍然指向 `WITDEN_PUBLIC_URL`（控制台的内网地址），只有能访问内网的人可以打开。

公网事件地址必须满足：

- 以 `https://` 开头，证书有效（这些平台不接受自签名证书）；
- 能从公网访问，并且只转发到事件端口；
- 只包含协议和域名，不带路径。

在控制台中设置这个地址有两个入口，修改的是同一项设置，效果相同：

- **设置 → 系统管理 → 公网地址**：随时查看当前地址及其检查结果，配置 Cloudflare Tunnel 或填写自己的地址，也可以重新检查或清除已保存的地址。
- **设置引导中的“准备公网事件地址”**：接入 GitHub，或以“事件地址（HTTP）”方式接入 Slack、飞书时是引导的第一步，地址通过检查后才能进入下一步；用公网地址把 Slack 应用安装到其他工作区时，安装引导中也有这一部分。

保存后立即生效，不需要重启；没有设置或清除后，事件地址按 `WITDEN_PUBLIC_URL` 生成，只适合各平台能直接访问控制台的内部环境。清除地址不会修改已经填写在 Slack、GitHub、飞书中的事件地址。保存前，witden 会做以下检查：

1. 通过这个地址请求事件端口的检查接口，核对用主密钥派生的签名，确认请求回到的是当前这个部署的事件端口。
2. 请求这个地址的 `/api/health`，确认从这个地址打不开控制台。

转发到控制台端口、只把部分路径转发到事件端口，或者不是 HTTPS、证书无效、发生重定向、转发到别的服务时，都不能保存。服务器所在网络的 DNS 解析不到这个域名时（有些网络会丢掉域名的部分记录），witden 改用公共 DNS（通过 HTTPS 访问 `1.1.1.1`）查到的地址完成检查，页面会注明这一点；各平台使用公共 DNS，不受影响。服务器所在网络不能从内部访问自己的公网地址时（检查显示连不上、超时，或公共 DNS 中也查不到），可以确认后仍然保存。

准备公网事件地址有两种方式。

**方式一：自己的域名和反向代理。** 准备一个专用于接收事件的域名（例如 `hooks.example.com`），把它的 DNS 记录指向服务器的公网 IP，在防火墙中放行 443 端口，用反向代理提供 HTTPS 并只转发到事件端口。Compose 部署时，事件端口只发布在本机的 `127.0.0.1:8325`；反向代理在另一台机器上时，用 `WITDEN_WEBHOOK_BIND` 把它发布到那台机器能访问的网卡。

Caddy（自动申请证书）：

```
hooks.example.com {
    reverse_proxy 127.0.0.1:8325
}
```

nginx（证书可用 `certbot --nginx -d hooks.example.com` 申请）：

```nginx
server {
    listen 443 ssl;
    server_name hooks.example.com;
    ssl_certificate     /etc/letsencrypt/live/hooks.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hooks.example.com/privkey.pem;
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:8325;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

配置好反向代理后，在控制台中选择“自己的域名和反向代理”，填写地址（例如 `https://hooks.example.com`）并点击“检查并使用”。

**方式二：Cloudflare Tunnel。** Compose 中的 `tunnel` 服务（镜像 `witden/tunnel`，内含 cloudflared）主动连接 Cloudflare，不需要公网 IP、开放端口或自己管理证书；域名需要托管在 Cloudflare。它随 `docker compose up -d` 一起启动，在填写 token 之前只是等待，不需要修改 `.env` 或在服务器上执行其他命令。

1. 在 Cloudflare 控制台的 **Networking → Tunnels** 中点击 **Create a tunnel**，输入名称后创建；在安装说明中选择 Docker，复制命令中 `--token` 后面的内容（也可以复制整条命令）。不需要运行这条命令。
2. 在 witden 控制台的“设置 → 系统管理 → 公网地址”（或设置引导中的“准备公网事件地址”）中选择“Cloudflare Tunnel”，粘贴 token 并保存。witden 把 token 写入数据卷 `witden-tunnel`，`tunnel` 服务几秒内读取到它并连接 Cloudflare，页面显示连接状态。
3. 在这个 tunnel 的 **Routes** 标签中点击 **Add route → Published application**，填写子域名并选择域名，**Service URL** 填 `http://api:8325`（事件端口，不是控制台的 8320）。witden 从 tunnel 读取到这条路由后自动检查：当前还没有通过检查的公网事件地址时，检查通过即保存；已经有通过检查的地址时，不会自动替换，页面显示“检查并改用这个地址”，由你决定是否改用。指向 8320 的路由会在页面上标出，并且通不过检查。

在控制台中更换 token 后，`tunnel` 服务会自动用新 token 重新连接；点击“停用 tunnel”会删除 token 并断开连接。之后可以在 Cloudflare 中删除这个 tunnel。完全不需要这个服务时，可以执行 `docker compose rm -sf tunnel`，或在 `docker-compose.yml` 中删除它。

单进程部署可以自行运行 cloudflared（`cloudflared tunnel run --token <token>`，路由指向 `http://localhost:8325`），再在控制台中选择“自己的域名和反向代理”，填写并检查地址。

## 3. 首次配置

平台启动时会自动创建内置的系统管理员（@admin，见[使用指南](user-guide.md#43-系统管理员)）。除它之外还没有其他 AI 员工时，管理员第一次登录会进入“欢迎使用 witden”引导：连接一个模型服务（填写 API Key）、选择一个模型，witden 就会导入内置模板，创建一台桌面虚拟电脑（`desktop`，使用 `desktop-browser` 模板，需要已构建或拉取 `witden/computer-desktop` 镜像）和一个在这台电脑上工作的助手（@assistant），系统管理员还没有模型时也使用这个模型，然后打开与助手的私信。引导可以跳过；完成或跳过后不再出现。之后也可以按下面的步骤手动配置：

1. **模型**：在“设置 → 模型”中点击“添加服务商”，选择常见服务（自动填好地址和协议）或“其他服务”，填写 API Key，再在“添加模型”中从模型列表选择或填写名称；对模型点击“检测能力”。
2. **话题调度**（可选）：如果要在“自动”模式的话题中使用多位 AI 员工，需要一个调度模型：System 1 模型（TypeSafe Jev，或开源模型 Laya，推荐），或已添加的普通对话模型。启用 Compose 中的 Laya 服务（见 2.3）后，它会被自动添加并设为调度模型；否则在“设置 → 系统管理 → 话题调度”中选择（System 1 模型要先在“设置 → 模型”中添加接口协议为“System One”的服务商和模型）。详见[使用指南](user-guide.md#8-话题调度)。
3. **虚拟电脑**：在“设置 → 虚拟电脑 → 模板”中点击“导入内置模板”（命令行模板 `dev-shell` 和桌面模板 `desktop-browser`），然后从模板创建虚拟电脑，等待状态变为运行中。
4. **AI 员工**：在“设置 → AI 员工管理”中创建 AI 员工，选择模型和虚拟电脑。
5. **管理员账号**（可选）：在“设置 → 系统管理 → 账号”中添加其他管理员。能登录控制台的账号都是管理员，可以看到全部会话。
6. **通讯接入**（可选）：参见[接入 Slack](slack.md)。

## 4. 配置项

平台的配置通过环境变量设置，名称均以 `WITDEN_` 开头。

### 4.1 平台（api、worker）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WITDEN_SECRET_KEY` | — | 主密钥（必填）。丢失后已保存的密钥无法解密，请离线备份。 |
| `WITDEN_DATABASE_URL` | 嵌入式数据库 | PostgreSQL 连接地址，例如 `postgres://user:pass@db:5432/witden`。 |
| `WITDEN_DATA_DIR` | `./data` | 数据目录（嵌入式数据库、话题文件、头像）。 |
| `WITDEN_HOST` / `WITDEN_PORT` | `0.0.0.0` / `8320` | 控制台与 API 的监听地址和端口。 |
| `WITDEN_PUBLIC_URL` | `http://localhost:8320` | 在内网访问控制台的地址，消息中的链接指向这里。控制台中没有保存公网事件地址时，事件地址也按它生成（见 2.4）。 |
| `WITDEN_WEBHOOK_HOST` / `WITDEN_WEBHOOK_PORT` | 同 `WITDEN_HOST` / `8325` | 事件端口：只提供事件接口、地址检查、Slack 安装回调和 AI 员工头像，公网地址只转发到这里。设为 `0` 时不开启。 |
| `WITDEN_WEBHOOK_BIND` | `127.0.0.1` | （Compose）事件端口在宿主机上发布到的网卡地址。反向代理在其他机器上时修改。 |
| `WITDEN_TUNNEL_TOKEN_FILE` | — | Cloudflare Tunnel token 的保存位置，`tunnel` 服务从这里读取。Compose 中已设置为 `/tunnel/token`；未设置时控制台不提供 Cloudflare Tunnel 选项。 |
| `WITDEN_TUNNEL_METRICS_URL` | — | cloudflared 指标接口的地址，用于显示连接状态和读取路由。Compose 中为 `http://tunnel:2000`。 |
| `WITDEN_TUNNEL_ORIGIN` | — | tunnel 路由应指向的地址，显示在控制台中。Compose 中为 `http://api:8325`（事件端口）。 |
| `WITDEN_PROCESS_ROLE` | `all` | `all`、`api` 或 `worker`，也可用 `serve --role` 指定。 |
| `WITDEN_HUB_HOST` / `WITDEN_HUB_PORT` | `0.0.0.0` / `8330` | 虚拟电脑连接平台的监听地址和端口。 |
| `WITDEN_HUB_URL_FOR_COMPUTERS` | `ws://witden-hub:8330/runner` | 虚拟电脑内连接平台使用的地址（`witden-hub` 解析为宿主机网关）。 |
| `WITDEN_MANAGER_URL` / `WITDEN_MANAGER_TOKEN` | — | 独立部署的 Docker Manager 地址和访问令牌。 |
| `WITDEN_INTERNAL_TOKEN` | — | API 与 Worker 之间的访问令牌。 |
| `WITDEN_API_URL_FOR_WORKER` | `http://127.0.0.1:8320` | Worker 访问 API 的地址。 |
| `WITDEN_WORKER_CONCURRENCY` | `4` | 每个 Worker 进程同时运行的任务数。 |
| `WITDEN_BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` / `_NAME` | — / — / `admin` | 首次启动时创建的管理员。 |
| `WITDEN_SESSION_TTL_HOURS` | `168` | 登录会话有效期（小时）。 |
| `WITDEN_MAX_DELEGATION_DEPTH` | `3` | AI 员工之间委托的最大层数。 |
| `WITDEN_MAX_AUTO_ROUNDS` | `8` | AI 员工之间自动讨论的最大轮次（互相 @、发往关联话题的消息、直接对话、对话自己定下的跟进），对所有话题相同；任务的拆出、委托、转交和续做不计入；也是飞书接入开启“其他机器人 @ 这个机器人时，也交给 AI 员工处理”后，连续接受机器人请求的次数上限。 |
| `WITDEN_INSTANCE_WAIT_SECONDS` | `300` | 虚拟电脑不可用时任务的最长等待时间。 |
| `WITDEN_TOOL_OUTPUT_LIMIT` | `12000` | 一次工具输出交给模型的最大字符数。超过时模型读到开头和结尾，完整内容保存为 AI 员工虚拟电脑中的文件（`~/.witden/tool-output/`）；读取文件时按这个长度分页。见[使用指南](user-guide.md#41-工具权限)。 |
| `WITDEN_ALLOWED_RUNTIMES` | `runc,runsc,sysbox-runc,kata-runtime` | 模板可以选择的容器运行时。 |
| `WITDEN_MODEL_PROXY_PORT` | `8686` | 虚拟电脑内模型访问接口的端口。 |
| `WITDEN_LAYA_URL` | — | Laya 服务的地址。设置后，平台启动时把它添加为 System 1 模型（见 2.3）。 |
| `WITDEN_MODEL_CATALOG_URL` | `https://models.dev/api.json` | 模型资料（各模型的上下文长度、思考程度）的获取地址。平台第一次启动时获取一次，之后在“设置 → 模型”中点击“更新模型资料”时获取。无法访问外网时可以指向格式相同的内部镜像；设为 `off` 不获取，模型的上下文长度按服务商报告的值、在模型上填写的值或默认的 6.4 万计算。 |
| `WITDEN_LAYA_API_KEY` | — | Laya 服务的密钥。Compose 部署中 `laya` 服务也使用这个值。 |
| `WITDEN_CORS_ORIGINS` | 空 | 允许跨域访问 API 的来源，逗号分隔。 |

### 4.2 Laya 服务（Compose）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `COMPOSE_PROFILES` | 空 | 包含 `laya` 时启动 `laya` 服务。 |
| `LAYA_MODELS` | `multilingual` | 启动时加载的模型。`multilingual` 支持中文等多种语言；`english` 只适合英文。 |
| `LAYA_THREADS` | `4` | 推理使用的 CPU 线程数，不要超过物理核数。 |

### 4.3 Docker Manager

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WITDEN_MANAGER_TOKEN` | — | 调用方必须提供的访问令牌（必填，至少 16 个字符）。 |
| `WITDEN_MANAGER_HOST` / `WITDEN_MANAGER_PORT` | `127.0.0.1` / `8340` | 监听地址和端口。 |
| `WITDEN_MANAGER_DATA_DIR` | `./data/manager` | 备份和临时文件目录。 |
| `WITDEN_MANAGER_NETWORK` | `witden-computers` | 普通虚拟电脑使用的网络。 |
| `WITDEN_MANAGER_INTERNAL_NETWORK` | `witden-computers-internal` | 不允许访问外网的虚拟电脑使用的网络。 |
| `WITDEN_MANAGER_ALLOWED_RUNTIMES` | `runc,runsc,sysbox-runc,kata-runtime` | 允许的容器运行时。 |
| `WITDEN_MANAGER_LOG_LEVEL` | `info` | 日志级别。 |

## 5. 命令行

```
witden serve [--role all|api|worker] [--port N]   启动平台
witden create-admin --email E --password P [--name N]   创建管理员
witden seed-templates                              创建内置的虚拟电脑模板
witden gen-key                                     生成新的主密钥
```

在源码目录中以 `node packages/server/dist/cli.js <命令>` 运行，在 Compose 部署中以 `docker compose run --rm api node packages/server/dist/cli.js <命令>` 运行。

## 6. 升级

1. 更新代码，重新构建镜像：`make images platform`（同时构建 `witden/tunnel`；启用了 Laya 时再执行 `make laya`）。
2. 重新启动服务：`docker compose up -d`。

平台启动时会自动执行数据库迁移。升级前请先备份数据库。

**执行代理随平台更新。** 平台镜像带有一份执行代理（Runner）。Compose 部署中，Docker Manager 启动时把它安装到数据卷 `witden-runner`，并以只读方式挂载到每台虚拟电脑。虚拟电脑在 20 秒内发现新版本，执行代理在没有进行中的操作时自动重启为新版本，不需要重新构建虚拟电脑镜像，也不需要重置虚拟电脑。执行代理最多等待 10 分钟，届时仍未完成的操作被中断，平台按“结果不确定”处理（见[系统架构](architecture.md#7-可靠性)）。后台命令、终端会话和桌面上的浏览器不受影响；正在观看的实时画面需要重新连接。虚拟电脑页的“Runner 版本”一栏显示执行代理的版本：“随平台更新”表示使用平台安装的执行代理，“镜像自带”表示使用虚拟电脑镜像中的一份。

这需要虚拟电脑使用本版本或更新的虚拟电脑镜像，并在创建容器时挂载了执行代理数据卷：本版本之前创建的虚拟电脑，在第 1 步重新构建镜像之后，各重置一次（方法见下文），此后执行代理的更新自动生效。平台安装的执行代理与虚拟电脑不兼容（例如需要更新版本的 Node.js 或启动进程），或者在虚拟电脑中启动后反复立即退出时，这台虚拟电脑使用镜像自带的执行代理，直到平台安装了新的版本。单进程部署不使用执行代理数据卷，虚拟电脑始终使用镜像自带的执行代理。

已有的虚拟电脑继续运行原来的容器，虚拟电脑镜像中执行代理以外的改动（例如执行代理令牌的保护、镜像自带软件包的清单）要在重新创建容器后生效：在虚拟电脑页点击“重置”，并勾选“保留持久化目录中的数据”。重置会清除装在持久化目录以外的软件（软件清单中的软件包会在启动后重新安装）、正在运行的程序和终端，持久化目录（如 `/home/witden`）中的文件保留。旧镜像没有列出自带的软件包，因此在重置之前，平台不会在这些虚拟电脑上卸载软件包；安装不受影响。虚拟电脑页的“Runner 令牌”一栏显示“已保护”即表示生效。

后台命令同样需要新版镜像中的执行代理：重置之前，这些虚拟电脑上的命令仍按原来的方式执行，超过等待时间即被结束，AI 员工查看、停止和等待后台命令的工具会提示需要重置。重置时勾选“保留持久化目录中的数据”即可，AI 员工的文件不受影响。

## 7. 备份与恢复

| 内容 | 方法 |
|---|---|
| 数据库 | 使用 `pg_dump` 定期备份 `db` 服务中的数据库。 |
| 主密钥 | 离线保存 `WITDEN_SECRET_KEY`；没有它，备份中的模型密钥和通讯凭据无法解密。 |
| 平台数据卷 | `witden-data`（话题文件和头像），与数据库一起备份。 |
| 虚拟电脑 | 在虚拟电脑页面的“备份与复制”中创建备份，备份文件保存在 Docker Manager 的数据卷 `witden-manager` 中。 |
| 执行代理数据卷 | `witden-runner` 无需备份，丢失后 Docker Manager 启动时会从平台镜像重新安装。虚拟电脑的备份不包含它。 |
| Laya 模型文件 | 数据卷 `witden-laya-cache` 无需备份，丢失后会重新下载。 |

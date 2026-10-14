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

一个进程同时提供网页控制台、API、Worker 和 Docker 管理功能。控制台默认监听 8320 端口，虚拟电脑通过 8330 端口连接平台。

### 2.2 Docker Compose

Compose 部署包含四个服务，另有两个可选服务：

| 服务 | 作用 | 说明 |
|---|---|---|
| `db` | PostgreSQL | 只在内部网络中可访问。 |
| `manager` | Docker Manager | 唯一挂载 Docker socket 的服务，按白名单创建和管理虚拟电脑。 |
| `api` | 控制台、API、虚拟电脑连接入口 | 对外发布 8320（控制台）和 8330（虚拟电脑连接）端口。 |
| `worker` | 运行 AI 角色、调用模型、发送外部消息 | 没有任何 Docker 权限，只通过 API 操作虚拟电脑。 |
| `laya`（可选） | 开源的 Laya 决策模型，用作话题调度模型 | 默认不启动，见 2.3。只在内部网络中可访问，不对外发布端口。 |
| `tunnel`（可选） | Cloudflare Tunnel，为平台提供公网 HTTPS 地址 | 默认不启动，见 2.4。只主动连接 Cloudflare，不对外发布端口。 |

部署步骤：

1. 复制配置文件并填写必填项：

   ```bash
   cp .env.example .env
   ```

   - `WITDEN_SECRET_KEY`：主密钥，用于加密模型密钥和通讯凭据。可用 `docker compose run --rm api node packages/server/dist/cli.js gen-key` 生成。
   - `WITDEN_MANAGER_TOKEN`、`WITDEN_INTERNAL_TOKEN`、`POSTGRES_PASSWORD`：任意足够长的随机字符串，例如 `openssl rand -hex 24`。
   - `DOCKER_GID`：Docker socket 所属的组，`stat -c %g /var/run/docker.sock`。
   - `WITDEN_BOOTSTRAP_ADMIN_EMAIL`、`WITDEN_BOOTSTRAP_ADMIN_PASSWORD`：首次启动时创建的管理员账号。
   - `WITDEN_PUBLIC_URL`：访问控制台的地址，用于生成链接和事件地址。Slack、GitHub、飞书需要公网 HTTPS 地址，也可以之后在控制台中设置和检查，见 2.4。

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

话题设为“自动”且有多个角色时，需要一个 System 1 模型作为调度模型（见[使用指南](user-guide.md#8-话题调度)）。如果不使用 TypeSafe Jev 等外部服务，可以随 Compose 一起部署开源的 Laya 模型。它在 CPU 上运行，不需要 GPU，一次判断通常不到 1 秒。

在 `.env` 中加入：

```bash
COMPOSE_PROFILES=laya
WITDEN_LAYA_URL=http://laya:8000
WITDEN_LAYA_API_KEY=<任意足够长的随机字符串>
```

然后执行 `docker compose up -d`。首次启动时 `laya` 服务会下载约 700 MB 的模型文件，保存在数据卷 `witden-laya-cache` 中，之后启动不再下载。平台启动时会把它添加到“设置 → 模型”中（服务商“Laya”，模型 `multilingual`）；如果尚未设置调度模型，同时把它设为调度模型。这一步对同一地址只做一次：之后删除这个服务商或更换调度模型，重启后不会被恢复。

不再需要时，从 `.env` 中删除这三行，执行 `docker compose rm -sf laya` 停止并删除该服务，再在控制台中删除该服务商、重新选择调度模型。

单进程部署也可以使用 Laya：自行运行 Laya 服务（`pip install "laya[serve]"` 后执行 `laya-serve`），并把 `WITDEN_LAYA_URL` 设为它的地址，例如 `http://127.0.0.1:8000`。

### 2.4 公网地址

Slack、GitHub、飞书把事件推送到 witden 的公网地址，消息中“在 witden 中查看”等链接也用这个地址。它必须满足：

- 以 `https://` 开头，证书有效（这些平台不接受自签名证书）；
- 能从公网访问，并转发到 witden（Compose 部署为本机的 `WITDEN_PORT`，默认 8320）；
- 只包含协议和域名，不带路径。

公网地址默认取 `WITDEN_PUBLIC_URL`，也可以在控制台中设置：接入 Slack 时引导的第一步“准备公网地址”。控制台中保存的地址优先于 `WITDEN_PUBLIC_URL`，保存后立即生效，不需要重启。保存前，witden 会通过这个地址请求自己的检查接口 `/api/integrations/probe`，并核对用主密钥派生的签名，确认请求回到的是当前这个部署；不是 HTTPS、证书无效、域名解析不到、发生重定向或转发到别的服务时都不能保存。服务器所在网络不能从内部访问自己的公网地址时（检查显示连不上或超时），可以确认后仍然保存。

准备公网地址有两种方式。

**方式一：自己的域名和反向代理。** 把域名的 DNS 记录指向服务器的公网 IP，在防火墙中放行 443 端口，用反向代理提供 HTTPS 并转发到 witden。控制台使用 Server-Sent Events 推送实时更新、使用 WebSocket 显示远程桌面，反向代理需要支持这两者。

Caddy（自动申请证书）：

```
witden.example.com {
    reverse_proxy 127.0.0.1:8320
}
```

nginx（证书可用 `certbot --nginx -d witden.example.com` 申请）：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name witden.example.com;
    ssl_certificate     /etc/letsencrypt/live/witden.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/witden.example.com/privkey.pem;
    client_max_body_size 60m;

    location / {
        proxy_pass http://127.0.0.1:8320;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # remote desktops use WebSocket, live updates use Server-Sent Events
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

只想让外部平台访问、不对公网开放控制台时，可以只转发以 `/api/integrations/` 开头的路径：事件地址和地址检查都在这个路径下。此时消息中“在 witden 中查看”的链接在公网上打不开。

**方式二：Cloudflare Tunnel。** 由 Compose 中的可选服务 `tunnel`（cloudflared）主动连接 Cloudflare，不需要公网 IP、开放端口或自己管理证书；域名需要托管在 Cloudflare。

1. 在 `.env` 中加入 `COMPOSE_PROFILES=tunnel`（同时使用 Laya 时写成 `COMPOSE_PROFILES=laya,tunnel`），执行 `docker compose up -d`。
2. 在 Cloudflare 控制台的 **Networking → Tunnels** 中点击 **Create a tunnel**，输入名称后创建；在安装说明中选择 Docker，复制命令中 `--token` 后面的内容（也可以复制整条命令）。不需要运行这条命令。
3. 在 witden 控制台接入 Slack 的第一步选择“Cloudflare Tunnel”，粘贴 token 并保存。witden 把 token 写入数据卷 `witden-tunnel`，`tunnel` 服务读取后连接 Cloudflare（在此之前它约每分钟重试一次），页面显示连接状态。
4. 在这个 tunnel 的 **Routes** 标签中点击 **Add route → Published application**，填写子域名并选择域名，**Service URL** 填 `http://api:8320`。witden 从 tunnel 读取到这条路由后，自动检查并保存为公网地址。

更换 token 后需要执行 `docker compose restart tunnel`。不再使用时，从 `COMPOSE_PROFILES` 中去掉 `tunnel`，执行 `docker compose rm -sf tunnel`，并在 Cloudflare 中删除这个 tunnel。

单进程部署可以自行运行 cloudflared（`cloudflared tunnel run --token <token>`，路由指向 `http://localhost:8320`），再在控制台中填写并检查地址。

## 3. 首次配置

1. **模型**：在“设置 → 模型”中添加服务商（地址、协议、密钥），从服务商获取模型列表并选择，或手动填写模型名称；对模型点击“检测能力”。
2. **话题调度**（可选）：如果要在“自动”模式的话题中使用多个角色，需要一个 System 1 模型（TypeSafe Jev，或开源模型 Laya）。启用 Compose 中的 Laya 服务（见 2.3）后，它会被自动添加并设为调度模型；使用其他服务时，在“设置 → 模型”中添加接口协议为“System One”的服务商和模型，再在“设置 → 系统管理 → 话题调度”中选择它。详见[使用指南](user-guide.md#8-话题调度)。
3. **虚拟电脑**：在“设置 → 虚拟电脑 → 模板”中点击“导入内置模板”（命令行模板 `dev-shell` 和桌面模板 `desktop-browser`），然后从模板创建虚拟电脑，等待状态变为运行中。
4. **角色**：在“设置 → 角色管理”中创建角色，选择模型和虚拟电脑。
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
| `WITDEN_PUBLIC_URL` | `http://localhost:8320` | 访问控制台的地址。控制台中保存的公网地址优先，见 2.4。 |
| `WITDEN_TUNNEL_TOKEN_FILE` | — | Cloudflare Tunnel token 的保存位置，`tunnel` 服务从这里读取。Compose 中已设置为 `/tunnel/token`；未设置时控制台不提供 Cloudflare Tunnel 选项。 |
| `WITDEN_TUNNEL_METRICS_URL` | — | cloudflared 指标接口的地址，用于显示连接状态和读取路由。Compose 中为 `http://tunnel:2000`。 |
| `WITDEN_TUNNEL_ORIGIN` | — | tunnel 路由应指向的地址，显示在控制台中。Compose 中为 `http://api:8320`。 |
| `WITDEN_PROCESS_ROLE` | `all` | `all`、`api` 或 `worker`，也可用 `serve --role` 指定。 |
| `WITDEN_HUB_HOST` / `WITDEN_HUB_PORT` | `0.0.0.0` / `8330` | 虚拟电脑连接平台的监听地址和端口。 |
| `WITDEN_HUB_URL_FOR_COMPUTERS` | `ws://witden-hub:8330/runner` | 虚拟电脑内连接平台使用的地址（`witden-hub` 解析为宿主机网关）。 |
| `WITDEN_MANAGER_URL` / `WITDEN_MANAGER_TOKEN` | — | 独立部署的 Docker Manager 地址和访问令牌。 |
| `WITDEN_INTERNAL_TOKEN` | — | API 与 Worker 之间的访问令牌。 |
| `WITDEN_API_URL_FOR_WORKER` | `http://127.0.0.1:8320` | Worker 访问 API 的地址。 |
| `WITDEN_WORKER_CONCURRENCY` | `4` | 每个 Worker 进程同时运行的任务数。 |
| `WITDEN_BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` / `_NAME` | — / — / `admin` | 首次启动时创建的管理员。 |
| `WITDEN_SESSION_TTL_HOURS` | `168` | 登录会话有效期（小时）。 |
| `WITDEN_MAX_TASK_STEPS` | `60` | 单个任务的最大步数上限。 |
| `WITDEN_MAX_DELEGATION_DEPTH` | `3` | 角色之间委托的最大层数。 |
| `WITDEN_MAX_AUTO_ROUNDS` | `8` | 角色之间自动讨论的最大轮次（话题可设置更低的值）。 |
| `WITDEN_INSTANCE_WAIT_SECONDS` | `300` | 虚拟电脑不可用时任务的最长等待时间。 |
| `WITDEN_TOOL_OUTPUT_LIMIT` | `12000` | 单次工具输出交给模型的最大字符数。 |
| `WITDEN_ALLOWED_RUNTIMES` | `runc,runsc,sysbox-runc,kata-runtime` | 模板可以选择的容器运行时。 |
| `WITDEN_MODEL_PROXY_PORT` | `8686` | 虚拟电脑内模型访问接口的端口。 |
| `WITDEN_LAYA_URL` | — | Laya 服务的地址。设置后，平台启动时把它添加为 System 1 模型（见 2.3）。 |
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

1. 更新代码，重新构建镜像：`make images platform`（启用了 Laya 时再执行 `make laya`）。
2. 重新启动服务：`docker compose up -d`。

平台启动时会自动执行数据库迁移。升级前请先备份数据库。

## 7. 备份与恢复

| 内容 | 方法 |
|---|---|
| 数据库 | 使用 `pg_dump` 定期备份 `db` 服务中的数据库。 |
| 主密钥 | 离线保存 `WITDEN_SECRET_KEY`；没有它，备份中的模型密钥和通讯凭据无法解密。 |
| 平台数据卷 | `witden-data`（话题文件和头像），与数据库一起备份。 |
| 虚拟电脑 | 在虚拟电脑页面的“备份与复制”中创建备份，备份文件保存在 Docker Manager 的数据卷 `witden-manager` 中。 |
| Laya 模型文件 | 数据卷 `witden-laya-cache` 无需备份，丢失后会重新下载。 |

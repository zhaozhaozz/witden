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

Compose 部署包含四个服务：

| 服务 | 作用 | 说明 |
|---|---|---|
| `db` | PostgreSQL | 只在内部网络中可访问。 |
| `manager` | Docker Manager | 唯一挂载 Docker socket 的服务，按白名单创建和管理虚拟电脑。 |
| `api` | 控制台、API、虚拟电脑连接入口 | 对外发布 8320（控制台）和 8330（虚拟电脑连接）端口。 |
| `worker` | 运行 AI 角色、调用模型、发送外部消息 | 没有任何 Docker 权限，只通过 API 操作虚拟电脑。 |

部署步骤：

1. 复制配置文件并填写必填项：

   ```bash
   cp .env.example .env
   ```

   - `WITDEN_SECRET_KEY`：主密钥，用于加密模型密钥和通讯凭据。可用 `docker compose run --rm api node packages/server/dist/cli.js gen-key` 生成。
   - `WITDEN_MANAGER_TOKEN`、`WITDEN_INTERNAL_TOKEN`、`POSTGRES_PASSWORD`：任意足够长的随机字符串，例如 `openssl rand -hex 24`。
   - `DOCKER_GID`：Docker socket 所属的组，`stat -c %g /var/run/docker.sock`。
   - `WITDEN_BOOTSTRAP_ADMIN_EMAIL`、`WITDEN_BOOTSTRAP_ADMIN_PASSWORD`：首次启动时创建的管理员账号。
   - `WITDEN_PUBLIC_URL`：成员访问控制台的地址，用于生成链接和 Slack 事件地址。

2. 构建虚拟电脑镜像和平台镜像：

   ```bash
   make images platform
   ```

3. 启动：

   ```bash
   docker compose up -d
   ```

4. 访问 `WITDEN_PUBLIC_URL`，用管理员账号登录，按第 3 节完成首次配置。

生产环境建议在控制台前放置 HTTPS 反向代理，并把 8330 端口只绑定到 Docker 网桥地址（设置 `WITDEN_HUB_BIND`，例如 `172.17.0.1`）。

## 3. 首次配置

1. **模型**：在“设置 → 模型”中添加服务商（地址、协议、密钥），从服务商获取模型列表并选择，或手动填写模型名称；对模型点击“检测能力”。
2. **话题调度**（可选）：如果要在“自动”模式的话题中使用多个角色，在“设置 → 系统管理 → 话题调度”中选择调度模型，建议选择响应快的小模型。
3. **虚拟电脑**：在“设置 → 虚拟电脑 → 模板”中点击“导入内置模板”（命令行模板 `dev-shell` 和桌面模板 `desktop-browser`），然后从模板创建虚拟电脑，等待状态变为运行中。
4. **角色**：在“设置 → 角色管理”中创建角色，选择模型和虚拟电脑。
5. **成员与授权**：在“设置 → 系统管理”中添加成员，并授予“使用角色”“邀请角色进话题”“创建话题”等权限。
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
| `WITDEN_PUBLIC_URL` | `http://localhost:8320` | 成员访问平台的地址。 |
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
| `WITDEN_CORS_ORIGINS` | 空 | 允许跨域访问 API 的来源，逗号分隔。 |

### 4.2 Docker Manager

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

1. 更新代码，重新构建镜像：`make images platform`。
2. 重新启动服务：`docker compose up -d`。

平台启动时会自动执行数据库迁移。升级前请先备份数据库。

## 7. 备份与恢复

| 内容 | 方法 |
|---|---|
| 数据库 | 使用 `pg_dump` 定期备份 `db` 服务中的数据库。 |
| 主密钥 | 离线保存 `WITDEN_SECRET_KEY`；没有它，备份中的模型密钥和通讯凭据无法解密。 |
| 平台数据卷 | `witden-data`（话题文件和头像），与数据库一起备份。 |
| 虚拟电脑 | 在虚拟电脑页面的“备份与复制”中创建备份，备份文件保存在 Docker Manager 的数据卷 `witden-manager` 中。 |

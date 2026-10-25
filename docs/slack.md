# 接入 Slack

接入后，团队成员可以在 Slack 中 @ 机器人，把工作交给 witden 中的 AI 员工。和 Slack 中看到的一样，一个频道对应 witden 中的一个话题，其中 thread 里的消息显示为对 thread 第一条消息的回复；每段私信也是一个话题。AI 员工在提问的地方回答：直接发在频道里的问题回到频道里，thread 里的问题回到那个 thread。

配置需要 witden 管理员账号，以及 Slack 工作区的应用管理权限（或由工作区管理员批准安装应用）。

在“设置 → 通讯接入”中点击“新建接入”并选择 **Slack**，页面会按步骤引导完成设置，每一步都给出需要在 Slack 中点击的位置；已有的 Slack 接入可以在详情中点击“设置引导”继续。

witden 支持两种接入方式：

| 方式 | 说明 | 需要的凭据 |
|---|---|---|
| **Socket Mode**（默认，推荐） | witden 主动连到 Slack，通过这条连接接收消息。不需要公网地址，witden 在公网上什么都不暴露。 | Bot User OAuth Token（`xoxb-`）和 App-Level Token（`xapp-`，带 `connections:write`） |
| 事件地址（HTTP） | Slack 把消息推送到 witden 的公网事件地址。需要一个只转发到事件端口的公网 HTTPS 地址，见第 8 节。 | Bot User OAuth Token 和 Signing Secret |

下面第 1–6 节按 Socket Mode 说明；已有的接入如何切换方式见第 7 节，事件地址方式见第 8 节，Socket Mode 的常见问题见第 9 节。

## 1. 创建 Slack App

1. 在引导中填写机器人名称（在 Slack 中显示、被 @ 的名字），点击“在 Slack 中创建应用”。Slack 会打开创建页面并预先填好应用清单，其中已经打开 Socket Mode 并订阅了需要的事件；选择工作区，确认后点击 **Create**。
2. 在应用的 **Install App** 页面点击 **Install to Workspace**，再点击 **Allow**。
3. 生成 App-Level Token：在应用的 **Basic Information** 页面 → **App-Level Tokens** 中点击 **Generate Token and Scopes**，名称随意，添加 `connections:write`，点击 **Generate**，复制 `xapp-` 开头的令牌。如果创建应用时 Slack 已经弹出带 `connections:write` 的 App-Level Token，直接使用即可。

预填页面打不开时，可以打开 <https://api.slack.com/apps>，选择 **Create New App → From a manifest**，选择工作区，粘贴以下清单（引导中也可以复制同样内容的 JSON）：

```yaml
display_information:
  name: witden
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true          # 允许大家私信机器人
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: witden
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - channels:read
      - groups:read
      - im:read
      - mpim:read
      - chat:write
      - users:read
      - files:read
      - files:write            # 把 AI 员工分享的文件和截图发到 Slack
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

## 2. 填写凭据并测试连接

1. 在引导中填写接入名称和两个令牌。每个输入框上方都写明了它在 Slack 中的位置：
   - **Bot User OAuth Token**：应用的 OAuth & Permissions 页面，以 `xoxb-` 开头。
   - **App-Level Token**：上一步生成的令牌，以 `xapp-` 开头。两个令牌填反时，页面会直接提示。
2. 点击“保存并测试连接”。witden 加密保存令牌，读取工作区和机器人的信息，并用 App-Level Token 向 Slack 申请连接；通过后立即与 Slack 建立连接。测试失败时，页面会说明原因，例如 Bot Token 不正确、App-Level Token 不正确或缺少 `connections:write`。测试通过但应用缺少 `chat:write` 或 `files:write` 时，页面会提示缺少哪项权限。

连接由 witden 的 API 进程维护：Slack 每隔几个小时更换一次连接，witden 会在旧连接关闭前接好新连接；连接中断时自动重连。接入详情中的“与 Slack 的连接”显示当前状态。接入暂停时连接会断开。

## 3. 选择机器人代表的 AI 员工

一个 Slack 应用就是工作区里的一个机器人，代表 witden 中的一位 AI 员工。引导中“选择机器人代表的 AI 员工”一步为它选择这位 AI 员工：发给这个机器人的消息都交给这位 AI 员工处理，回复以机器人的名字和头像发出，不另加 AI 员工名称。需要多位 AI 员工时，为每位 AI 员工各建一个 Slack 应用，它们在 witden 中各是一个接入。

每个接入都必须选择 AI 员工。没有选择 AI 员工的接入不接收请求：@ 机器人时会收到“还没有选择代表的 AI 员工”的说明，接入详情中也会醒目提示。

Slack 中的会话只有这一位 AI 员工工作：它不会请其他 AI 员工进来协作，控制台也不能邀请或移除这些会话的成员和 AI 员工。需要其他 AI 员工处理的工作，在控制台的话题中进行。之后在接入详情中更换机器人代表的 AI 员工时，这个接入所有会话中的 AI 员工会一起换成新的 AI 员工；控制台的话题中显示谁离开、谁加入，Slack 中不会出现这类通知。

同一步还可以设置（之后可以在接入详情中点击“编辑”修改）：

| 设置 | 说明 |
|---|---|
| 允许未关联的人使用（外部成员） | 默认关闭。关闭时，Slack 用户需要关联到 witden 管理员账号后才能使用。开启后，未关联的人第一次与机器人对话时自动成为这个连接的**外部成员**，可以使用机器人代表的 AI 员工，见第 4 节。 |

## 4. 关联身份

witden 只按 **Slack 用户 ID** 识别 Slack 用户，不使用显示名称。在“设置 → 通讯接入 → 身份关联”中，把 Slack 账号关联到对应的 witden 管理员账号；关联后，这个 Slack 用户发出的请求视为该管理员的请求。

引导的最后一步“在 Slack 中试一试”会实时显示 witden 收到的消息和处理结果。管理员第一次在 Slack 中 @ 机器人时，账号还没有关联，可以直接在这一步把自己的 Slack 账号关联到自己的 witden 账号，再发一次即可。请求没有交给 AI 员工时（例如 AI 员工还没有分配电脑或模型），这里和 Slack 的 thread 中都会说明原因；接入详情的“收到的事件”中也保留这些记录。

未关联的人：

- 连接未开启“允许未关联的人使用”时，他们 @ 机器人会在 thread 中收到账号尚未关联的提示，不会创建任务。
- 开启后，他们第一次与机器人对话时自动成为这个连接的外部成员，在“系统管理 → 成员”中标为“外部成员”。外部成员：
  - 只能使用机器人代表的 AI 员工；接入改为代表另一位 AI 员工后，他们与原 AI 员工正在进行的工作立即取消；
  - 不能登录控制台，也不能设置密码；
  - 各自与机器人的私信是不同的会话，相互读不到对方的消息；但 AI 员工写入自己记忆的内容会在它工作的所有地方使用，见[使用指南](user-guide.md#5-审批与资料保护)。

## 5. 在 Slack 中使用

- 机器人所在的每个频道都记录为 witden 中的一个话题（thread 中的消息显示为回复），可以在控制台中查看；只有 @ 机器人的消息才交给 AI 员工处理。不希望记录的频道，不要邀请机器人加入。
- 在频道中 @ 机器人并说明需求，例如 `@witden 帮我看看这个构建失败`，由机器人代表的 AI 员工处理，回复直接发在频道里。在某条消息的 thread 中 @ 机器人，回复发到那个 thread。
- AI 员工可以像人一样连续发几条消息（例如先说“我看一下”，再给出结果），也可以查阅和搜索这个频道更早的消息。
- 私信机器人：整个私信是一个私密话题。AI 员工在频道中的对话读不到私信，其他话题也不能读取私信；只有 AI 员工记忆和技能在 AI 员工工作的所有地方通用（见使用指南的[记忆](user-guide.md#45-记忆)和[技能](user-guide.md#46-技能)）。
- 同一 thread 中的其他成员也可以 @ 机器人，每个人的权限分别检查。

## 6. 消息格式

witden 中的消息使用 Markdown，Slack 使用自己的格式，两者会自动转换：

- **发送到 Slack**：粗体、斜体、删除线、链接、引用和代码块转换为 Slack 的写法；标题显示为粗体行；列表使用 `•`、`◦` 或序号，任务列表使用 ☐ / ☑；表格显示为对齐的等宽文本；消息附带的文件（包括 AI 员工分享的截图）上传到 Slack，发在同一个频道或 thread 中，在 Slack 里直接查看；Mermaid 流程图在 Slack 中显示源码，并附带在 witden 中查看图形的链接。
- **从 Slack 接收**：Slack 的格式和链接转换为 Markdown；提及的 Slack 用户显示为已关联成员的名字，频道显示为 `#频道名`；Slack 的项目符号列表转换为列表；代码保持原样。消息中的文件下载到话题的文件中（需要 `files:read` 权限），没有大小限制：文件边下载边写入数据目录，较大的文件占用的是磁盘空间而不是内存。下载在 60 秒内没有收到任何数据时放弃。

上传文件需要 `files:write` 权限。没有这项权限（例如应用在 witden 加入这项权限之前创建），或工作区不允许上传这种文件时，消息改为附上指向 witden 的文件链接；这种链接只有能访问 witden 控制台并已登录的人才能打开。失败原因仅在控制台接入详情的“诊断记录”中显示，不附在外发消息中。接收附件失败同样记录在这里，不作为话题消息发送。给已有的应用补上权限：在应用的 **OAuth & Permissions** 页面 → **Scopes** → **Bot Token Scopes** 中添加 `files:write`，然后点击页面顶部提示中的 **Reinstall to Workspace**。在接入详情中点击“测试连接”可以确认权限是否齐全。

## 7. 切换接入方式

已有的接入可以在设置引导中切换方式：在接入详情中点击“设置引导”，选择另一种方式（当前方式标有“当前”）；使用事件地址的接入，详情中还有“改用 Socket Mode”的按钮。切换沿用原来的 Slack 应用，频道、私信、机器人代表的 AI 员工和已关联的账号都保持不变。

新方式的凭据先测试，通过后才保存；保存时原方式的凭据被删除。在此之前，原来的方式继续工作。

### 7.1 让原来的 Slack 应用打开 Socket Mode

在 <https://api.slack.com/apps> 中选择这个应用：

1. 左侧打开 **Socket Mode**，打开 **Enable Socket Mode**。如果应用还没有 App-Level Token，Slack 会弹出窗口引导生成：名称随意，确认 scope 中有 `connections:write`，点击 **Generate**，复制 `xapp-` 开头的令牌。
2. 左侧打开 **Event Subscriptions**：确认 **Enable Events** 已打开（Socket Mode 下不再需要 Request URL），在 **Subscribe to bot events** 中有 `app_mention`、`message.channels`、`message.groups`、`message.im`、`message.mpim`，缺的补上，点击 **Save Changes**。
3. 如果页面顶部提示重新安装应用，按提示重新安装。
4. 回到 witden 的引导，填入 App-Level Token 并测试。Bot Token 不变，可以留空。

也可以在应用的 **App Manifest** 页面把 `settings` 换成第 1 节清单中的内容，再按第 1 步生成 App-Level Token。

打开 Socket Mode 后，Slack 只通过连接发送消息，并保留原来的 Request URL 备用。在 witden 连上之前发给机器人的消息可能收不到，所以打开后请尽快完成第 4 步。

### 7.2 改回事件地址

在引导中选择“事件地址（HTTP）”：先准备公网事件地址，再在 Slack 应用的 Socket Mode 页面关闭 Enable Socket Mode，填入 Signing Secret，最后在 Event Subscriptions 中填写 Request URL。从关闭 Socket Mode 到 Slack 验证事件地址之前，发给机器人的消息会收不到。

## 8. 事件地址方式（HTTP）

在引导开头选择“事件地址（HTTP）”，引导会多出“准备公网事件地址”和“在 Slack 中订阅事件”两步，凭据改为 Bot Token 和 Signing Secret。

### 8.1 准备公网事件地址

Slack 把消息推送到 witden 的**事件地址**，即公网事件地址加上固定路径。控制台不对公网开放：公网地址只转发到 witden 的事件端口（默认 8325），这个端口只接收各平台的事件，不提供控制台。这个地址必须以 `https://` 开头、证书有效（Slack 不接受自签名证书），并且能从公网访问。

引导的第一步显示当前的公网事件地址以及它能否使用。这一步与“设置 → 系统管理 → 公网地址”修改的是同一项设置，也可以事先在那里准备好。不能使用时，按以下任一方式准备地址，详见[部署与配置](deployment.md#24-公网事件地址)：

- **Cloudflare Tunnel**（推荐，不需要公网 IP、开放端口或自己管理证书）：在 Cloudflare 中创建 tunnel，把 token 粘贴到引导中，再为 tunnel 添加一条指向 `http://api:8325`（事件端口）的路由。Docker Compose 部署中的 tunnel 服务会自动连接，witden 发现路由后自动检查并保存地址（已有通过检查的地址时，由你确认是否改用），不需要在服务器上操作。
- **自己的域名和反向代理**（nginx、Caddy 等）：把域名指向服务器，用反向代理提供 HTTPS 并只转发到事件端口，然后把地址填到引导中点击“检查并使用”。

witden 会通过这个地址访问自己的事件端口，并确认从这个地址打不开控制台，通过后才能进入下一步。检查失败时，页面会说明原因，例如不是 HTTPS、证书无效、域名解析不到、转发到了控制台或别的服务。

Slack 消息中“在 witden 中查看”等链接指向控制台的内网地址（`WITDEN_PUBLIC_URL`），只有能访问内网的人可以打开。

### 8.2 创建 Slack App 并填写凭据

1. 在引导中填写机器人名称（在 Slack 中显示、被 @ 的名字），点击“在 Slack 中创建应用”。Slack 会打开创建页面并预先填好应用清单；选择工作区，确认后点击 **Create**。
2. 在应用的 **Install App** 页面点击 **Install to Workspace**，再点击 **Allow**。
3. 安装完成后先回到 witden，不要先设置 Event Subscriptions：事件地址要等 witden 保存了 Signing Secret 后才能通过 Slack 的验证（8.3 节）。

预填页面打不开时，手动粘贴第 1 节的清单，但把 `settings` 改为不打开 Socket Mode、不订阅事件：

```yaml
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

清单不包含事件订阅：Slack 要求事件订阅带有已验证的事件地址，而事件地址要在下一步创建 witden 接入之后才能验证，见 8.3 节。

然后在引导中填写凭据：

1. 在引导中填写接入名称，以及应用的两项凭据：
   - **Bot User OAuth Token**：应用的 OAuth & Permissions 页面，以 `xoxb-` 开头。
   - **Signing Secret**：应用的 Basic Information 页面 → App Credentials，是 32 位十六进制字符。同一页面上还有 Client Secret、Verification Token 和 App-Level Token（`xapp-` 开头），都不是 Signing Secret；填入 Slack 的令牌时，witden 会直接提示。
2. 点击“保存并测试连接”。witden 加密保存凭据，并读取工作区和机器人的信息，用于拒绝来自其他工作区的事件、忽略机器人自己发出的消息。测试失败时，页面会说明原因，例如 Token 不正确或应用已被卸载。

这一步的测试只用到 Bot Token；Signing Secret 是否正确，要到下一步 Slack 验证事件地址时才能知道。

### 8.3 订阅事件

引导会显示这个接入的**事件地址**。在 Slack App 的 **Event Subscriptions** 页面：

1. 打开 **Enable Events**，在 **Request URL** 中填写事件地址，等待显示 Verified。
2. 在 **Subscribe to bot events** 中添加：`app_mention`、`message.channels`、`message.groups`、`message.im`、`message.mpim`。
3. 点击 **Save Changes**。如果 Slack 提示重新安装应用，按提示操作。

引导会实时显示 Slack 的验证结果。Slack 提示 “Your URL didn't respond with the value of the challenge parameter” 时：

- 如果引导显示“witden 收到了 Slack 的请求，但校验没有通过”，说明地址是通的，是 Signing Secret 不对。点击“重新填写 Signing Secret”填入 App Credentials 中的 Signing Secret，再在 Slack 中点击 Request URL 旁的 **Retry**。
- 如果引导显示还没有收到 Slack 的请求，说明请求没有到达 witden，回到 8.1 节检查公网事件地址。

## 9. Socket Mode 常见问题

| 现象 | 原因与处理 |
|---|---|
| 打开 Socket Mode 时 Slack 弹出一个窗口 | 这是在生成 App-Level Token。名称随意，确认 scope 中有 `connections:write`，生成后复制 `xapp-` 开头的令牌。 |
| 已经有 `xapp-` 开头的令牌 | 只要带 `connections:write` 就可以直接用。在 Basic Information → App-Level Tokens 中点开令牌能看到它的 scope。 |
| 测试提示缺少 `connections:write`，或令牌不正确 | 在 App-Level Tokens 中重新生成一个带 `connections:write` 的令牌，完整复制后再填。 |
| 连接状态显示“应用没有打开 Socket Mode” | Slack 应用的 Socket Mode 开关是关着的。打开后，witden 会在一分钟内自动连上。 |
| 已连接，但发消息没有反应 | Event Subscriptions 中 Enable Events 没打开，或 5 个事件没添加、没保存（之前用事件地址时，如果 Request URL 没验证通过，事件订阅很可能没保存成功）；页面顶部提示重新安装应用但还没有重新安装；机器人没被邀请进频道（`/invite @机器人名称`）。 |
| 切换的一两分钟里消息丢失 | 打开 Socket Mode 后 Slack 只通过连接发送消息，在 witden 连上之前发出的消息可能收不到，连上后重发即可。 |
| 两个 witden 用同一个 Slack 应用 | 多个程序同时用同一个应用的 Socket Mode 时，Slack 会把每条消息只发给其中一个连接，其他的收不到。演示环境和正式环境请各建一个 Slack 应用。同一个 witden 把应用装到多个工作区不受影响，见第 10 节。 |
| 服务器有防火墙 | Socket Mode 只需要 witden 服务器能访问 Slack（出站 443 端口），不需要公网地址，也不需要开放任何入站端口。 |

## 10. Slack 应用与多个工作区

witden 和 Slack 一样把应用和工作区分为两层：一个 **Slack 应用** 可以安装到多个工作区（例如不同的组织），每个工作区是应用下的一个接入。“通讯接入”页的列表中，Slack 应用显示在它的工作区上方；点击应用可以查看它的接入方式、事件地址、已安装的工作区，以及修改应用的令牌。

- **应用** 保存应用自己的凭据：App-Level Token（Socket Mode）或 Signing Secret（事件地址），以及安装到其他工作区要用的 Client ID 和 Client Secret。与 Slack 的连接由它的所有工作区共用：Socket Mode 下只有一条连接，所有工作区的消息都从这里进来，按工作区交给对应的接入；事件地址方式下，所有工作区的事件都发到应用的事件地址。
- **工作区接入** 保存这个工作区的机器人令牌，有自己的频道和私信、关联的账号、外部成员设置和机器人代表的 AI 员工（新安装的工作区默认与应用的第一个工作区相同，可以单独修改）。
- 删除任何一个工作区的接入，都不影响应用和它的其他工作区，包括最先接入的那个。暂停一个工作区只暂停它自己。应用在没有工作区之后才能删除（在应用详情中点击“删除应用”）。
- 用设置引导新建 Slack 接入时，witden 同时建立应用（以机器人名称命名）和第一个工作区。升级前建立的 Slack 接入会自动成为一个应用和它的工作区，Slack 中已经配置的事件地址不变。

### 10.1 安装步骤

在“设置 → 通讯接入”中点击“新建接入”，选择 **Slack** 后选择“把已有的应用安装到另一个工作区”；或者在应用的详情中点击“安装到其他工作区”。按页面中的步骤完成：

1. **选择要安装的应用。**
2. **填写应用的 Client ID 和 Client Secret。** 在 Slack 应用的 **Basic Information → App Credentials** 中复制。witden 加密保存，之后不能再查看。
3. **选择完成安装的方式。** 安装的人在 Slack 中确认后，Slack 把他的浏览器带到一个回调地址，带着一次性的安装代码（10 分钟内有效），witden 用它换取这个工作区的机器人令牌。Slack 要求回调地址使用 HTTPS，但不会自己访问它：
   - **公网地址，自动完成（推荐）：** 回调地址是公网事件地址下的 `/api/integrations/slack/oauth`。安装后 witden 自动完成，安装人看到“已安装到 Slack 工作区”的提示；其他组织的管理员也可以在自己的电脑上完成安装。这个页面只完成控制台中发起的安装，控制台仍然不对外开放。需要先准备公网事件地址（见 8.1 节）。
   - **没有公网地址：手动粘贴：** 回调地址填任意一个 HTTPS 地址，不需要能打开，默认是 `https://localhost/witden/slack-install`（指向安装人自己的电脑，安装代码不会发到别处）。安装后浏览器停在一个打不开的页面，把地址栏中的完整地址在 10 分钟内粘贴回 witden 即可。安装要由你本人，或能把这个地址交回给你的人完成。
4. **在 Slack 中添加回调地址并开放安装：** 在应用的 **OAuth & Permissions → Redirect URLs** 中添加页面显示的回调地址并点击 Save URLs；在 **Manage Distribution** 中完成检查清单，点击 **Activate Public Distribution**。开放安装不是上架 Slack Marketplace，只有拿到安装链接的人才能安装；使用 Socket Mode 的应用不能上架 Marketplace，但可以这样安装到其他工作区。
5. **安装到工作区：** 打开安装页面，在 Slack 页面右上角选择要安装到的工作区，点击 **Allow**。选择公网地址方式时，安装链接 30 分钟内有效，可以发给对方工作区的管理员。
6. **选择机器人代表的 AI 员工。**
7. **在 Slack 中试一试。**

在同一个工作区再安装一次（例如应用增加了权限）会更新这个工作区的机器人令牌，不会新建接入。不支持安装到整个 Enterprise Grid 组织，请安装到其中的工作区。

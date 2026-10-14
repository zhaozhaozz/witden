# 接入 Slack

接入后，团队成员可以在 Slack 中 @ 机器人，把工作交给 witden 中的角色。每个 Slack thread 对应 witden 中的一个话题，角色的回复会发回同一个 thread。

配置需要 witden 管理员账号，以及 Slack 工作区的应用管理权限（或由工作区管理员批准安装应用）。

在“设置 → 通讯接入”中点击“新建接入”并选择 **Slack**，页面会按步骤引导完成设置，每一步都给出需要在 Slack 中点击的位置；已有的 Slack 接入可以在详情中点击“设置引导”继续。

witden 支持两种接入方式：

| 方式 | 说明 | 需要的凭据 |
|---|---|---|
| **Socket Mode**（默认，推荐） | witden 主动连到 Slack，通过这条连接接收消息。不需要公网地址，witden 在公网上什么都不暴露。 | Bot User OAuth Token（`xoxb-`）和 App-Level Token（`xapp-`，带 `connections:write`） |
| 事件地址（HTTP） | Slack 把消息推送到 witden 的公网事件地址。需要一个只转发到事件端口的公网 HTTPS 地址，见第 7 节。 | Bot User OAuth Token 和 Signing Secret |

已有的接入可以在详情中点击“编辑”切换方式，切换时填写新方式的凭据，原方式的凭据会被删除。下面第 1–6 节按 Socket Mode 说明。

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
      - chat:write.customize   # 可选：以角色自己的名称和头像发言
      - users:read
      - files:read
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
2. 点击“保存并测试连接”。witden 加密保存令牌，读取工作区和机器人的信息，并用 App-Level Token 向 Slack 申请连接；通过后立即与 Slack 建立连接。测试失败时，页面会说明原因，例如 Bot Token 不正确、App-Level Token 不正确或缺少 `connections:write`。

连接由 witden 的 API 进程维护：Slack 每隔几个小时更换一次连接，witden 会在旧连接关闭前接好新连接；连接中断时自动重连。接入详情中的“与 Slack 的连接”显示当前状态。接入暂停时连接会断开。

## 3. 配置分配规则

来自外部会话的请求**没有匹配的分配规则时一律拒绝**。引导中“选择处理请求的角色”一步可以直接为这个接入添加一条规则：选择可以处理 Slack 请求的角色和默认角色。同一步还可以设置以下选项（之后可以在接入详情中点击“编辑”修改）：

| 设置 | 说明 |
|---|---|
| 新会话默认同步范围 | “仅 @ 机器人的 thread”（默认）、“全部 thread”或“不同步”。 |
| 允许未关联的人使用（外部成员） | 默认关闭。关闭时，Slack 用户需要关联到 witden 管理员账号后才能使用。开启后，未关联的人第一次与机器人对话时自动成为这个连接的**外部成员**，见第 4 节。 |
| 外部成员可以使用的角色 | 开启上一项后选择。外部成员只能使用这里列出的角色。 |
| 以角色自己的名称和头像发送消息 | 需要 `chat:write.customize` 权限。未开启时，回复以“角色名称 (@名称):”开头。 |

更细的规则在“设置 → 分配规则”中添加，例如：

- 匹配该连接，允许角色 `dev` 和 `test`，默认角色 `dev`；
- 匹配 #qa 频道，允许角色 `test`，默认角色 `test`。多条规则同时匹配时，允许的角色取交集，因此在 #qa 中只能使用 `test`。

在分配规则页面的“规则检查”中可以模拟一条请求，查看它会交给哪个角色以及每一步的判断依据。

## 4. 关联身份

witden 只按 **Slack 用户 ID** 识别 Slack 用户，不使用显示名称。在“设置 → 通讯接入 → 身份关联”中，把 Slack 账号关联到对应的 witden 管理员账号；关联后，这个 Slack 用户发出的请求视为该管理员的请求。

引导的最后一步“在 Slack 中试一试”会实时显示 witden 收到的消息和处理结果。管理员第一次在 Slack 中 @ 机器人时，账号还没有关联，可以直接在这一步把自己的 Slack 账号关联到自己的 witden 账号，再发一次即可。请求没有交给角色时（例如角色还没有分配电脑或模型），这里和 Slack 的 thread 中都会说明原因；接入详情的“收到的事件”中也保留这些记录。

未关联的人：

- 连接未开启“允许未关联的人使用”时，他们 @ 机器人会在 thread 中收到账号尚未关联的提示，不会创建任务。
- 开启后，他们第一次与机器人对话时自动成为这个连接的外部成员，在“系统管理 → 成员”中标为“外部成员”。外部成员：
  - 只能使用连接设置中列出的角色；从列表中移除某个角色后，他们正在等待的相关工作立即取消；
  - 不能登录控制台，也不能设置密码；
  - 各自与机器人的私信相互隔离，内容不会出现在其他人面前，除非资料所有者批准。

## 5. 在 Slack 中使用

- 在频道中 @ 机器人并说明需求，例如 `@witden 帮我看看这个构建失败`，会创建一个话题，由默认角色处理；同一 thread 中的后续消息进入同一个话题。
- 指定角色：`@witden @test 跑一下回归`，或 `@witden role:test 跑一下回归`。
- 私信机器人：整个私信是一个私密话题，其中的内容不会出现在频道中，除非资料所有者批准。
- 同一 thread 中的其他成员也可以 @ 机器人，每个人的权限分别检查。

## 6. 消息格式

witden 中的消息使用 Markdown，Slack 使用自己的格式，两者会自动转换：

- **发送到 Slack**：粗体、斜体、删除线、链接、引用和代码块转换为 Slack 的写法；标题显示为粗体行；列表使用 `•`、`◦` 或序号，任务列表使用 ☐ / ☑；表格显示为对齐的等宽文本；图片和附件显示为指向 witden 的链接（打开时需要登录 witden）；Mermaid 流程图在 Slack 中显示源码，并附带在 witden 中查看图形的链接。
- **从 Slack 接收**：Slack 的格式和链接转换为 Markdown；提及的 Slack 用户显示为已关联成员的名字，频道显示为 `#频道名`；Slack 的项目符号列表转换为列表；代码保持原样。

## 7. 改用事件地址（HTTP）

在引导开头选择“事件地址（HTTP）”，引导会多出“准备公网事件地址”和“在 Slack 中订阅事件”两步，凭据改为 Bot Token 和 Signing Secret。

### 7.1 准备公网事件地址

Slack 把消息推送到 witden 的**事件地址**，即公网事件地址加上固定路径。控制台不对公网开放：公网地址只转发到 witden 的事件端口（默认 8325），这个端口只接收各平台的事件，不提供控制台。这个地址必须以 `https://` 开头、证书有效（Slack 不接受自签名证书），并且能从公网访问。

引导的第一步显示当前的公网事件地址以及它能否使用。不能使用时，按以下任一方式准备地址，详见[部署与配置](deployment.md#24-公网事件地址)：

- **Cloudflare Tunnel**（推荐，不需要公网 IP、开放端口或自己管理证书）：在 Cloudflare 中创建 tunnel，把 token 粘贴到引导中，再为 tunnel 添加一条指向 `http://api:8325`（事件端口）的路由。Docker Compose 部署中的 tunnel 服务会自动连接，witden 发现路由后自动检查并保存地址，不需要在服务器上操作。
- **自己的域名和反向代理**（nginx、Caddy 等）：把域名指向服务器，用反向代理提供 HTTPS 并只转发到事件端口，然后把地址填到引导中点击“检查并使用”。

witden 会通过这个地址访问自己的事件端口，并确认从这个地址打不开控制台，通过后才能进入下一步。检查失败时，页面会说明原因，例如不是 HTTPS、证书无效、域名解析不到、转发到了控制台或别的服务。

Slack 消息中“在 witden 中查看”等链接指向控制台的内网地址（`WITDEN_PUBLIC_URL`），只有能访问内网的人可以打开。

### 7.2 创建 Slack App 并填写凭据

1. 在引导中填写机器人名称（在 Slack 中显示、被 @ 的名字），点击“在 Slack 中创建应用”。Slack 会打开创建页面并预先填好应用清单；选择工作区，确认后点击 **Create**。
2. 在应用的 **Install App** 页面点击 **Install to Workspace**，再点击 **Allow**。
3. 安装完成后先回到 witden，不要先设置 Event Subscriptions：事件地址要等 witden 保存了 Signing Secret 后才能通过 Slack 的验证（7.3 节）。

预填页面打不开时，手动粘贴第 1 节的清单，但把 `settings` 改为不打开 Socket Mode、不订阅事件：

```yaml
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

清单不包含事件订阅：Slack 要求事件订阅带有已验证的事件地址，而事件地址要在下一步创建 witden 接入之后才能验证，见 7.3 节。

然后在引导中填写凭据：

1. 在引导中填写接入名称，以及应用的两项凭据：
   - **Bot User OAuth Token**：应用的 OAuth & Permissions 页面，以 `xoxb-` 开头。
   - **Signing Secret**：应用的 Basic Information 页面 → App Credentials，是 32 位十六进制字符。同一页面上还有 Client Secret、Verification Token 和 App-Level Token（`xapp-` 开头），都不是 Signing Secret；填入 Slack 的令牌时，witden 会直接提示。
2. 点击“保存并测试连接”。witden 加密保存凭据，并读取工作区和机器人的信息，用于拒绝来自其他工作区的事件、忽略机器人自己发出的消息。测试失败时，页面会说明原因，例如 Token 不正确或应用已被卸载。

这一步的测试只用到 Bot Token；Signing Secret 是否正确，要到下一步 Slack 验证事件地址时才能知道。

### 7.3 订阅事件

引导会显示这个接入的**事件地址**。在 Slack App 的 **Event Subscriptions** 页面：

1. 打开 **Enable Events**，在 **Request URL** 中填写事件地址，等待显示 Verified。
2. 在 **Subscribe to bot events** 中添加：`app_mention`、`message.channels`、`message.groups`、`message.im`、`message.mpim`。
3. 点击 **Save Changes**。如果 Slack 提示重新安装应用，按提示操作。

引导会实时显示 Slack 的验证结果。Slack 提示 “Your URL didn't respond with the value of the challenge parameter” 时：

- 如果引导显示“witden 收到了 Slack 的请求，但校验没有通过”，说明地址是通的，是 Signing Secret 不对。点击“重新填写 Signing Secret”填入 App Credentials 中的 Signing Secret，再在 Slack 中点击 Request URL 旁的 **Retry**。
- 如果引导显示还没有收到 Slack 的请求，说明请求没有到达 witden，回到 7.1 节检查公网事件地址。

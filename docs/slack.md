# 接入 Slack

接入后，团队成员可以在 Slack 中 @ 机器人，把工作交给 witden 中的角色。每个 Slack thread 对应 witden 中的一个话题，角色的回复会发回同一个 thread。

配置需要同时具备 witden 的“管理通讯接入”权限和 Slack 工作区的应用管理权限。

## 1. 创建 Slack App

1. 打开 <https://api.slack.com/apps>，选择 **Create New App → From an app manifest**，选择工作区，粘贴以下清单：

   ```yaml
   display_information:
     name: witden
   features:
     bot_user:
       display_name: witden
       always_online: true
   oauth_config:
     scopes:
       bot:
         - app_mentions:read
         - channels:history
         - channels:read
         - groups:history
         - groups:read
         - im:history
         - im:read
         - mpim:history
         - mpim:read
         - chat:write
         - chat:write.customize   # 可选：以角色自己的名称和头像发言
         - users:read
         - files:read
   settings:
     org_deploy_enabled: false
     socket_mode_enabled: false
   ```

2. 把应用安装到工作区，记下 **Bot User OAuth Token**（以 `xoxb-` 开头）和 **Signing Secret**（在 Basic Information 页面）。

## 2. 在 witden 中创建连接

1. 进入“设置 → 通讯接入”，新建 Slack 连接，填写 Bot User OAuth Token 和 Signing Secret。
2. 点击“测试连接”。witden 会读取工作区和机器人的信息，用于拒绝来自其他工作区的事件，并忽略机器人自己发出的消息。
3. 复制连接详情中显示的**事件地址**。

连接的可选设置：

| 设置 | 说明 |
|---|---|
| 以角色自己的名称和头像发送消息 | 需要 `chat:write.customize` 权限。未开启时，回复以“角色名称 (@名称):”开头。 |
| 允许未关联的人使用（外部成员） | 默认关闭。关闭时，Slack 用户需要由管理员关联到 witden 成员后才能使用。开启后，未关联的人第一次与机器人对话时自动成为这个连接的**外部成员**，见第 5 节。 |
| 外部成员可以使用的角色 | 开启上一项后选择。外部成员只能使用这里列出的角色。 |
| 新会话默认同步范围 | “仅 @ 机器人的 thread”（默认）、“全部 thread”或“不同步”。 |

## 3. 订阅事件

回到 Slack App 的 **Event Subscriptions** 页面：

1. 打开 **Enable Events**，在 **Request URL** 中填写上一步复制的事件地址，等待显示 Verified。
2. 在 **Subscribe to bot events** 中添加：`app_mention`、`message.channels`、`message.groups`、`message.im`、`message.mpim`。
3. 保存。如果 Slack 提示重新安装应用，按提示操作。

## 4. 配置分配规则

来自外部会话的请求**没有匹配的分配规则时一律拒绝**。请在“设置 → 分配规则”中至少为这个连接添加一条规则，例如：

- 匹配该连接，允许角色 `dev` 和 `test`，默认角色 `dev`；
- 匹配 #qa 频道，允许角色 `test`，默认角色 `test`。多条规则同时匹配时，允许的角色取交集，因此在 #qa 中只能使用 `test`。

在分配规则页面的“规则检查”中可以模拟一条请求，查看它会交给哪个角色以及每一步的判断依据。

## 5. 关联身份

witden 只按 **Slack 用户 ID** 识别 Slack 用户，不使用显示名称。在“设置 → 通讯接入 → 身份关联”中，把 Slack 账号关联到对应的 witden 成员。

未关联的人：

- 连接未开启“允许未关联的人使用”时，他们 @ 机器人会在 thread 中收到账号尚未关联的提示，不会创建任务。
- 开启后，他们第一次与机器人对话时自动成为这个连接的外部成员，在“系统管理 → 成员”中标为“外部成员”。外部成员：
  - 只能使用连接设置中列出的角色；其他授权（包括授予所有人的）对他们不生效；
  - 不能登录控制台，也不能设置密码或成为管理员；
  - 各自与机器人的私信相互隔离，内容不会出现在其他人面前，除非资料所有者批准。

## 6. 在 Slack 中使用

- 在频道中 @ 机器人并说明需求，例如 `@witden 帮我看看这个构建失败`，会创建一个话题，由默认角色处理；同一 thread 中的后续消息进入同一个话题。
- 指定角色：`@witden @test 跑一下回归`，或 `@witden role:test 跑一下回归`。
- 私信机器人：整个私信是一个私密话题，其中的内容不会出现在频道中，除非资料所有者批准。
- 同一 thread 中的其他成员也可以 @ 机器人，每个人的权限分别检查。

## 7. 消息格式

witden 中的消息使用 Markdown，Slack 使用自己的格式，两者会自动转换：

- **发送到 Slack**：粗体、斜体、删除线、链接、引用和代码块转换为 Slack 的写法；标题显示为粗体行；列表使用 `•`、`◦` 或序号，任务列表使用 ☐ / ☑；表格显示为对齐的等宽文本；图片和附件显示为指向 witden 的链接（打开时需要登录 witden）；Mermaid 流程图在 Slack 中显示源码，并附带在 witden 中查看图形的链接。
- **从 Slack 接收**：Slack 的格式和链接转换为 Markdown；提及的 Slack 用户显示为已关联成员的名字，频道显示为 `#频道名`；Slack 的项目符号列表转换为列表；代码保持原样。

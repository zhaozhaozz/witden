# 接入 Slack

## 1. 创建 Slack App

在 <https://api.slack.com/apps> 选择 “From an app manifest”，粘贴下面的清单（把 `request_url` 换成控制台“通讯接入”页面显示的事件地址）：

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
      - chat:write.customize   # 可选：用角色名和头像发言
      - users:read
      - files:read
settings:
  event_subscriptions:
    request_url: https://witden.example.com/api/integrations/slack/<connection_id>/events
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  org_deploy_enabled: false
  socket_mode_enabled: false
```

安装到工作区后，记下 **Bot User OAuth Token**（`xoxb-…`）和 **Signing Secret**。

## 2. 在 witden 中创建连接

“通讯接入” → 新建 Slack 连接，填写 Bot Token 与 Signing Secret → “测试连接”（会读取工作区 ID 和机器人用户 ID，用于拒绝其他工作区的事件、忽略机器人自己的消息）。

可选设置：

- `custom_identity`：已授予 `chat:write.customize` 时，回复使用角色名称与头像；否则以 `*角色名 (@handle)*:` 前缀发言。
- `auto_provision_users`：首次出现的 Slack 用户自动创建成员（默认关闭，需要管理员手动绑定身份）。
- `default_sync_mode`：`mentions`（默认，只跟进 @ 过机器人的 thread）/ `all` / `off`。

## 3. 分配规则

外部会话**没有匹配规则时一律拒绝**。至少为这个连接添加一条规则，例如：

- 匹配 `connection_id = <连接>`，允许角色 `[dev, test]`，默认角色 `dev`；
- 匹配 `conversation_id = <#qa 频道>`，允许 `[test]`，默认 `test`（会与上一条取交集，因此在 #qa 中只能用 test）。

在“分配规则 → 解释”中可以模拟一条请求，查看每一步为何允许或拒绝。

## 4. 在 Slack 中使用

- 在频道里 `@witden 帮我看看这个构建失败` → 创建话题并由默认角色处理；同一 thread 的后续消息进入同一话题。
- 指定角色：`@witden @test 跑一下回归` 或 `@witden role:test 跑一下回归`。
- 私信机器人：整个私信是一个私密话题，内容不会进入频道（除非资料所有者批准）。
- 同一 thread 的其他同事也可以 @ 机器人，各自的权限分别校验。

### 消息格式

witden 里的消息是 Markdown，Slack 使用自己的 mrkdwn，两边互相转换：

- 发到 Slack：`**粗体**` → `*粗体*`，`*斜体*` → `_斜体_`，`~~删除~~` → `~删除~`，`[文字](地址)` → `<地址|文字>`（站内相对地址补全为平台地址）；标题变成粗体行；列表用 `•`、`◦` 和序号，任务列表用 ☐ / ☑；表格变成对齐的等宽代码块；代码块去掉语言标记；图片和附件变成指向 witden 的链接（🖼 / 📎，打开需要登录 witden）；Mermaid 流程图在 Slack 中显示源码，并附“在 witden 中查看”的链接。`&`、`<`、`>` 按 Slack 要求转义；粗体等标记紧挨中文时会补零宽空格，让 Slack 识别边界。
- 从 Slack 收到：`*粗体*`、`_斜体_`、`~删除~`、`<地址|文字>` 转成 Markdown；`<@U…>` 显示为已绑定成员的名字，`<#C…|频道>` 显示为 `#频道`；`•` 列表转成 Markdown 列表；代码原样保留。

## 5. 身份绑定

Slack 用户只按 **Slack 用户 ID** 识别，不看显示名称。在“管理 → 外部身份”中把 Slack 账号绑定到成员。未绑定的人 @ 机器人会收到“账号未绑定”的提示，不会创建任务。

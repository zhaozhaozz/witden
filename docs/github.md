# 接入 GitHub

接入后，角色可以作为机器人在 GitHub 仓库中工作：在 issue、pull request 或评论中 @ 机器人账号，就能把工作交给 witden 中的角色。每个 issue 或 pull request 对应 witden 中的一个会话，角色的回复以评论的形式发回同一个 issue 或 pull request。

配置需要 witden 管理员账号，以及要接入的仓库或组织的管理权限（用于添加 webhook）。

## 1. 准备机器人账号

1. 为 witden 准备一个 GitHub 账号（建议使用单独的机器账号，例如 `acme-witden`），并把它加入要接入的仓库或组织。需要回复私有仓库时，它必须对这些仓库有写权限（至少可以评论）。
2. 用这个账号创建令牌：
   - **Fine-grained token**（推荐）：选择要接入的仓库，权限设置 Issues、Pull requests 为 Read and write，Metadata 为 Read-only。
   - 或 **classic token**：勾选 `repo`（只接入公开仓库时，`public_repo` 即可）。
3. 生成一个随机字符串作为 Webhook Secret，例如 `openssl rand -hex 24`。

## 2. 在 witden 中创建连接

1. 在“设置 → 通讯接入”中新建接入，平台选择 **GitHub**，填写机器人账号的 Token 和 Webhook Secret。
2. 点击“测试连接”。witden 会读取机器人账号的用户名，用于识别 @ 和忽略机器人自己发的评论。
3. 复制连接详情中显示的**事件地址**。

连接的可选设置与 Slack 相同，见[接入 Slack](slack.md#2-在-witden-中创建连接)，包括“允许未关联的人使用（外部成员）”和“新会话默认同步范围”。

## 3. 添加 Webhook

在仓库（或组织）的 **Settings → Webhooks → Add webhook** 中：

1. **Payload URL** 填写上一步复制的事件地址。
2. **Content type** 选择 `application/json`。
3. **Secret** 填写 Webhook Secret。
4. 选择 **Let me select individual events**，勾选 **Issues**、**Issue comments** 和 **Pull requests**。
5. 保存。GitHub 会发送一次 ping，witden 返回成功即表示配置正确。

## 4. 配置分配规则与身份

- 和 Slack 一样，来自 GitHub 的请求**没有匹配的分配规则时一律拒绝**。请在“设置 → 分配规则”中为这个连接添加规则，指定允许的角色和默认角色，见[接入 Slack](slack.md#4-配置分配规则)。
- witden 按 **GitHub 用户 ID** 识别 GitHub 用户。在“设置 → 通讯接入 → 身份关联”中，把管理员自己的 GitHub 账号关联到 witden 管理员账号；其他人按连接的外部成员设置处理。

## 5. 在 GitHub 中使用

- 在 issue、pull request 的正文或评论中 @ 机器人账号并说明需求，例如 `@acme-witden 帮忙看看这个报错`，由默认角色处理。
- 指定角色：`@acme-witden role:dev 帮忙看看`。不要用 `@dev` 指定角色：在 GitHub 上它会提醒一位名为 dev 的用户。
- 同一个 issue 或 pull request 中没有 @ 机器人的评论会记录到会话中，但不会交给角色。
- 评论被编辑或删除时，witden 中对应的消息同步更新或删除。
- 角色的回复是一条评论，开头写明角色名称。

## 6. 资料保护

- **公开仓库**任何人都能看到，因此角色要在其中发布的内容如果用到了 witden 内部的资料（例如管理员与角色的私信），会先暂扣，由资料来源的管理员批准后才发出。
- **私有仓库**的读者是仓库的协作者。读取协作者列表需要机器人账号有推送权限；读不到时按最严格的方式处理（视为该连接下的所有人都能看到）。

## 7. 已知限制

- pull request 中针对代码行的评审评论（review comments）暂不同步。
- 评论中的图片和附件只以链接形式保留。
- 机器人以账号身份工作，GitHub App 形式的接入尚未支持。

# 接入 GitHub

接入后，角色可以作为机器人在 GitHub 仓库中工作：在 issue、pull request 或评论中 @ 机器人，就能把工作交给 witden 中的角色。每个 issue 或 pull request 对应 witden 中的一个会话，角色的回复以评论的形式发回同一个 issue 或 pull request。

配置需要 witden 管理员账号，以及创建 GitHub App 或添加 webhook 所需的仓库或组织管理权限。

witden 支持两种接入方式：

| 方式 | 说明 |
|---|---|
| **GitHub App**（推荐） | 回复显示为 `<应用名>[bot]`；安装到哪些仓库或组织，就能在哪里工作；平台用应用的私钥按需换取有效期 1 小时的令牌，自动续期。 |
| 机器人账号 Token | 用一个 GitHub 账号（建议单独的机器账号）的令牌，回复以这个账号的身份发出。 |

## 1. 创建 GitHub App（推荐方式）

1. 在 GitHub 的 **Settings → Developer settings → GitHub Apps → New GitHub App**（组织的应用在组织设置中创建）：
   - **GitHub App name**：例如 `acme-witden`，人们在 issue 中用 `@acme-witden` 召唤它。
   - **Homepage URL**：witden 控制台的地址。
   - **Webhook**：先保持 Active，**Webhook URL** 暂时填控制台地址（创建 witden 连接后再改为事件地址），**Webhook secret** 填一个随机字符串，例如 `openssl rand -hex 24` 的输出。
   - **Repository permissions**：Issues 和 Pull requests 为 Read and write，Metadata 为 Read-only。
   - **Subscribe to events**：Issues、Issue comment、Pull request。
2. 创建后记下 **App ID**，并在页面底部 **Generate a private key**，下载 `.pem` 文件。
3. 在应用页面的 **Install App** 中，把它安装到需要的仓库或组织。

## 2. 在 witden 中创建连接

1. 在“设置 → 通讯接入”中新建接入，平台选择 **GitHub**，接入方式选择 **GitHub App**，填写 App ID、Private key（`.pem` 文件的全部内容）和 Webhook Secret。
2. 点击“测试连接”。witden 会读取应用名称和安装数量，用应用名识别 @ 并忽略应用自己发的评论。
3. 复制连接详情中显示的**事件地址**，回到 GitHub App 的设置，把 **Webhook URL** 改为这个地址并保存。GitHub 会发送一次 ping，witden 返回成功即表示配置正确。

连接的可选设置与 Slack 相同，见[接入 Slack](slack.md#2-在-witden-中创建连接)，包括“允许未关联的人使用（外部成员）”和“新会话默认同步范围”。

## 3. 改用机器人账号 Token

不方便创建 GitHub App 时，可以使用一个 GitHub 账号的令牌：

1. 准备一个账号（建议单独的机器账号，例如 `acme-witden`），把它加入要接入的仓库或组织；回复私有仓库需要它对这些仓库有写权限。
2. 用这个账号创建令牌：**Fine-grained token**（选择要接入的仓库，Issues、Pull requests 为 Read and write，Metadata 为 Read-only），或 classic token 勾选 `repo`（只接入公开仓库时 `public_repo` 即可）。
3. 在 witden 中新建 GitHub 接入，接入方式选择 **机器人账号 Token**，填写 Token 和一个随机的 Webhook Secret，点击“测试连接”。
4. 在仓库（或组织）的 **Settings → Webhooks → Add webhook** 中：Payload URL 填事件地址，Content type 选 `application/json`，Secret 填 Webhook Secret，选择 **Let me select individual events**，勾选 Issues、Issue comments 和 Pull requests。

已有的连接可以在“编辑”中切换接入方式，切换时填写新方式的凭据，原方式的凭据会被删除。

## 4. 配置分配规则与身份

- 和 Slack 一样，来自 GitHub 的请求**没有匹配的分配规则时一律拒绝**。请在“设置 → 分配规则”中为这个连接添加规则，指定允许的角色和默认角色，见[接入 Slack](slack.md#4-配置分配规则)。
- witden 按 **GitHub 用户 ID** 识别 GitHub 用户。在“设置 → 通讯接入 → 身份关联”中，把管理员自己的 GitHub 账号关联到 witden 管理员账号；其他人按连接的外部成员设置处理。

## 5. 在 GitHub 中使用

- 在 issue、pull request 的正文或评论中 @ 应用名（或机器人账号）并说明需求，例如 `@acme-witden 帮忙看看这个报错`，由默认角色处理。
- 指定角色：`@acme-witden role:dev 帮忙看看`。不要用 `@dev` 指定角色：在 GitHub 上它会提醒一位名为 dev 的用户。
- 同一个 issue 或 pull request 中没有 @ 应用的评论会记录到会话中，但不会交给角色。
- 评论被编辑或删除时，witden 中对应的消息同步更新或删除。
- 角色的回复是一条评论，开头写明角色名称。

## 6. 资料保护

- **公开仓库**任何人都能看到，因此角色要在其中发布的内容如果用到了 witden 内部的资料（例如管理员与角色的私信），会先暂扣，由资料来源的管理员批准后才发出。
- **私有仓库**的读者是仓库的协作者。读不到协作者列表时（例如机器人账号没有推送权限）按最严格的方式处理（视为该连接下的所有人都能看到）。

## 7. 已知限制

- pull request 中针对代码行的评审评论（review comments）暂不同步。
- 评论中的图片和附件只以链接形式保留。

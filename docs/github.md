# 接入 GitHub

接入后，角色可以作为机器人在 GitHub 仓库中工作：在 issue、pull request 或评论中 @ 机器人，就能把工作交给 witden 中的角色。每个 issue 或 pull request 对应 witden 中的一个会话，角色的回复以评论的形式发回同一个 issue 或 pull request。

配置需要 witden 管理员账号，以及创建 GitHub App 或添加 webhook 所需的仓库或组织管理权限。控制台按步骤引导完成设置；中途离开后，可以在接入详情中点击“设置引导”继续。GitHub 把事件发送到 witden 的公网事件地址（只通往事件端口，不开放控制台），准备方法见[部署与配置](deployment.md#24-公网事件地址)。

witden 支持两种接入方式：

| 方式 | 说明 |
|---|---|
| **GitHub App**（推荐） | 回复显示为 `<应用名>[bot]`；安装到哪些仓库或组织，就能在哪里工作；平台用应用的私钥按需换取有效期 1 小时的令牌，自动续期。 |
| 机器人账号 Token | 用一个 GitHub 账号（建议单独的机器账号）的令牌，回复以这个账号的身份发出。 |

## 1. 用设置引导接入 GitHub App（推荐）

在“设置 → 通讯接入”中点击“新建接入”，选择 **GitHub**，接入方式选择 **GitHub App**，按页面中的 5 步完成：

1. **准备公网事件地址。** GitHub 只能把事件发到公网可以访问的 HTTPS 地址，准备方法见[部署与配置](deployment.md#24-公网事件地址)。
2. **在 GitHub 中创建 App。** 填写接入名称和 App 名称（GitHub 上所有 App 的名称都不能重复；人们在 issue 中用 `@名称` 召唤它），选择 App 属于你的个人账号还是一个组织（组织需要你是所有者或 App 管理员），点击“在 GitHub 中创建 App”。witden 会把 App 需要的设置一次交给 GitHub：Webhook URL 为这个接入的事件地址；Issues 和 Pull requests 为 Read and write，Metadata 为 Read-only；订阅 Issues、Issue comment、Pull request 事件；App 设为私有。在 GitHub 中确认创建后，GitHub 跳回 witden，witden 自动取回 App ID、私钥和 Webhook Secret 并加密保存，不需要手动复制，也不会在界面上显示。
3. **把 App 安装到仓库。** 点击“安装 App”，选择账号或组织，再选择全部仓库或部分仓库。页面每 5 秒检查一次安装情况，并显示 GitHub 发来的安装事件是否通过了签名校验。
4. **选择机器人代表的角色**，以及是否允许未关联的人使用，见[接入 Slack](slack.md#3-选择机器人代表的角色)。
5. **在 GitHub 中试一试：** 在安装了 App 的仓库中，在 issue 或 pull request 中评论 `@App 名称 你好`，页面会显示 witden 收到的消息和处理结果。

GitHub 跳回 witden 时带有一个一次性的代码（一小时内有效），以及 witden 发出时生成的校验码；校验码不一致的跳转会被忽略。跳回失败或代码过期时，App 可能已经创建好了：可以在 GitHub 的 Settings → Developer settings → GitHub Apps 中删除后重新创建，或按下一节手动填写它的凭据。

### 1.1 手动填写已有 App 的凭据

已经有 GitHub App，或浏览器无法跳回 witden 时，在第 2 步展开“手动填写凭据”：

1. 在 App 的设置中确认 Webhook URL 是这个接入的事件地址，权限和订阅的事件与上面相同。
2. 填写 **App ID**（App 设置页面中的数字）、**Private key**（在 App 设置页面底部 Private keys 中生成，下载的 `.pem` 文件的全部内容）和 **Webhook Secret**（与 App 设置中的 Webhook secret 相同，可以使用页面生成的随机值），点击“保存并测试连接”。

## 2. 改用机器人账号 Token

不方便创建 GitHub App 时，可以让一个 GitHub 账号作为机器人。在新建 GitHub 接入时选择 **机器人账号 Token**，按页面中的 6 步完成：

1. **准备公网事件地址**，与上面相同。
2. **准备机器人账号和 Token。** 建议为 witden 单独注册一个账号（例如 `acme-witden`），让它能访问要接入的仓库（私有仓库需要把它加为协作者或组织成员）。用这个账号创建 Token：**Fine-grained token**（推荐：选择仓库，Issues 和 Pull requests 为 Read and write），或勾选 `repo` 的 classic token。页面提供了两种 Token 的创建链接。
3. **填写 Token 并测试连接。** witden 读取账号名称（人们用 `@账号名` 召唤它），同时生成 Webhook Secret。
4. **在仓库中添加 Webhook。** 填写仓库（`owner/repo`）或组织名后，页面给出添加 Webhook 的链接，以及要填写的 Payload URL 和 Secret。Content type 选 `application/json`，选择 **Let me select individual events**，勾选 Issues、Issue comments 和 Pull requests。添加后 GitHub 立即发送 ping，页面显示是否通过了签名校验。保存过的 Secret 不能再查看；需要时可以在这一步生成新的 Secret，再到 GitHub 中替换。
5. **选择机器人代表的角色。**
6. **在 GitHub 中试一试。**

Token 过期后角色无法回复，请在到期前在接入的“编辑”中换上新的 Token。已有的接入可以在“编辑”中切换接入方式，切换时填写新方式的凭据，原方式的凭据会被删除。

## 3. 选择角色与关联身份

- 和 Slack 一样，一个 GitHub App（或机器人账号）就是一个机器人，代表 witden 中的一个角色：在设置引导中选择，之后也可以在接入详情中点击“编辑”修改。@ 应用的请求都交给这个角色，见[接入 Slack](slack.md#3-选择机器人代表的角色)。没有选择角色的接入不接收请求。
- witden 按 **GitHub 用户 ID** 识别 GitHub 用户。在“设置 → 通讯接入 → 身份关联”中，把管理员自己的 GitHub 账号关联到 witden 管理员账号；其他人按连接的外部成员设置处理。

## 4. 在 GitHub 中使用

- 在 issue、pull request 的正文或评论中 @ 应用名（或机器人账号）并说明需求，例如 `@acme-witden 帮忙看看这个报错`，由应用代表的角色处理。
- 应用能看到的仓库中，每个 issue 和 pull request 都会记录为 witden 中的一个会话，没有 @ 应用的评论也会记录，但只有 @ 应用的才交给角色。
- 评论被编辑或删除时，witden 中对应的消息同步更新或删除。
- 角色的回复是一条以应用（或机器人账号）身份发出的评论；这个角色请来协作的其他角色，评论开头写明角色名称。

## 5. 资料保护

- **公开仓库**任何人都能看到，因此角色要在其中发布的内容如果用到了 witden 内部的资料（例如管理员与角色的私信），会先暂扣，由资料来源的管理员批准后才发出。
- **私有仓库**的读者是仓库的协作者。读不到协作者列表时（例如机器人账号没有推送权限）按最严格的方式处理（视为该连接下的所有人都能看到）。

## 6. 已知限制

- pull request 中针对代码行的评审评论（review comments）暂不同步。
- 评论中的图片和附件只以链接形式保留。角色回复中的 Markdown 图片发到 GitHub 时改为链接（🖼），GitHub 不会替角色请求图片地址。

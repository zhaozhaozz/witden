# 接入 GitHub

接入后，AI 员工可以作为机器人在 GitHub 仓库中工作：在 issue、pull request 或评论中 @ 机器人，就能把工作交给 witden 中的 AI 员工。每个 issue 或 pull request 对应 witden 中的一个会话，AI 员工的回复以评论的形式发回同一个 issue 或 pull request。

获得授权的 AI 员工还可以使用 **GitHub 工具**：以接入的账号或 App 的身份读代码、处理 issue 和 pull request、查看和触发 Actions（见第 4 节）。只想让 AI 员工代替某个人做这些事、不需要机器人时，可以把账号接入设为**只作为认证**（见第 3 节），这时不接收消息，也不需要公网地址。

配置需要 witden 管理员账号，以及创建 GitHub App 或添加 webhook 所需的仓库或组织管理权限。控制台按步骤引导完成设置；中途离开后，可以在接入详情中点击“设置引导”继续。作为机器人时，GitHub 把事件发送到 witden 的公网事件地址（只通往事件端口，不开放控制台），准备方法见[部署与配置](deployment.md#24-公网事件地址)。

witden 支持以下接入方式：

| 方式 | 说明 |
|---|---|
| **GitHub App**（推荐） | 回复显示为 `<应用名>[bot]`；安装到哪些仓库或组织，就能在哪里工作；平台用应用的私钥按需换取有效期 1 小时的令牌，自动续期。 |
| 机器人账号 Token | 用一个 GitHub 账号（建议单独的机器账号）的令牌，回复以这个账号的身份发出。 |
| 账号 Token，只作为认证 | 不当机器人使用：不接收消息，只给获得授权的 AI 员工使用 GitHub 工具，可以是本人的账号。 |

## 1. 用设置引导接入 GitHub App（推荐）

在“设置 → 通讯接入”中点击“新建接入”，选择 **GitHub**，接入方式选择 **GitHub App**，按页面中的 5 步完成：

1. **准备公网事件地址。** GitHub 只能把事件发到公网可以访问的 HTTPS 地址，准备方法见[部署与配置](deployment.md#24-公网事件地址)。
2. **在 GitHub 中创建 App。** 填写接入名称和 App 名称（GitHub 上所有 App 的名称都不能重复；人们在 issue 中用 `@名称` 召唤它），选择 App 属于你的个人账号还是一个组织（组织需要你是所有者或 App 管理员），点击“在 GitHub 中创建 App”。witden 会把 App 需要的设置一次交给 GitHub：Webhook URL 为这个接入的事件地址；Issues 和 Pull requests 为 Read and write，Metadata 为 Read-only；订阅 Issues、Issue comment、Pull request 事件；App 设为私有。在 GitHub 中确认创建后，GitHub 跳回 witden，witden 自动取回 App ID、私钥和 Webhook Secret 并加密保存，不需要手动复制，也不会在界面上显示。
3. **把 App 安装到仓库。** 点击“安装 App”，选择账号或组织，再选择全部仓库或部分仓库。页面每 5 秒检查一次安装情况，并显示 GitHub 发来的安装事件是否通过了签名校验。
4. **选择机器人代表的 AI 员工**，以及是否允许未关联的人使用，见[接入 Slack](slack.md#3-选择机器人代表的-ai-员工)。
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
5. **选择机器人代表的 AI 员工。**
6. **在 GitHub 中试一试。**

Token 过期后 AI 员工无法回复，请在到期前在接入的“编辑”中换上新的 Token。已有的接入可以在“编辑”中切换接入方式，切换时填写新方式的凭据，原方式的凭据会被删除。

## 3. 只作为认证（不当机器人使用）

有时只是希望 AI 员工代替某个人在 GitHub 上做事，例如提 issue、开 pull request、查看 CI，而不需要一个会被 @ 的机器人。这时在新建 GitHub 接入时选择 **机器人账号 Token**，打开 **只作为认证（不当机器人使用）**，按页面中的 3 步完成：

1. **准备账号和 Token。** 可以用本人的账号（AI 员工代替本人操作，GitHub 上显示为本人），也可以用一个单独的账号。创建 Token 时只给 AI 员工要用的权限：

   | Token 权限（fine-grained） | 对应的工具类别 | 级别 |
   |---|---|---|
   | Contents | 代码与文件 | 读取为 Read-only；提交文件、新建分支为 Read and write |
   | Issues | Issue | 查看为 Read-only；新建、评论、修改为 Read and write |
   | Pull requests | Pull request | 查看为 Read-only；新建、评论、合并为 Read and write |
   | Actions | Actions | 查看运行为 Read-only；重新运行、手动触发为 Read and write |

   Repository access 只选需要的仓库；classic token 需要 `repo`（触发工作流还需要 `workflow`），能访问这个账号的所有仓库。
2. **填写 Token 并测试连接。** witden 加密保存 Token，读取账号名称；不生成 Webhook Secret。
3. **给 AI 员工授权。** 在 AI 员工的权限中为这个接入勾选需要的类别，见下一节。

这种接入不接收 GitHub 的消息（即使仓库里配置了指向它的 Webhook，事件也会被忽略），不需要公网地址、Webhook 和默认处理的 AI 员工。之后可以在接入的“编辑”中关闭这个开关，把它改为机器人，这时要填写 Webhook Secret，并选择代表的 AI 员工。

## 4. GitHub 工具

AI 员工经 witden 调用 GitHub，拿不到 Token 或 App 的私钥。所有 GitHub 接入都可以给 AI 员工授权，不论是否只作为认证。在“设置 → AI 员工管理”编辑 AI 员工，在“权限”的 **GitHub** 部分，按接入分别设置以下类别，每项可选禁用、只读、读写（写入需询问）或读写：

| 类别 | 只读 | 写入 |
|---|---|---|
| 代码与文件 | 列出能访问的仓库，读取文件和目录 | 在分支上提交文件，新建分支 |
| Issue | 查看 issue 列表、内容和评论 | 新建 issue，评论，修改标题、正文、状态、标签和负责人 |
| Pull request | 查看 pull request 列表、内容和改动的文件 | 新建 pull request，评论，合并 |
| Actions | 查看工作流运行情况 | 重新运行，手动触发工作流 |

- 每个接入（例如不同的人或组织）分别授权：允许一个接入，不会因此能用另一个接入。接入名后面注明以哪个账号或 App 的身份操作。
- AI 员工能做的不会超过这个账号或 App 在 GitHub 上的权限，也不会超过 Token 的权限。GitHub 拒绝时，AI 员工会看到原因（例如 Token 缺少权限、组织还没有批准 Token）。
- “写入需询问”时，每次写入前由有审批权限的人在控制台批准。审批只在控制台进行。
- 删除接入时，AI 员工对它的授权一并删除。

## 5. 选择 AI 员工与关联身份

- 和 Slack 一样，一个 GitHub App（或机器人账号）就是一个机器人。设置引导中选择的是这个接入**默认处理的 AI 员工**，之后也可以在接入详情中点击“编辑”修改：@ 应用的请求默认都交给这位 AI 员工，见[接入 Slack](slack.md#3-选择机器人代表的-ai-员工)。没有选择时，跟随默认的 issue 和 pull request 不接收请求。
- 单个 issue 或 pull request 可以改由另一位 AI 员工处理（例如让负责检视的 AI 员工处理某个 pull request）：在控制台中打开这个会话，在右侧栏“设置”中选择“处理的 AI 员工”（见[使用指南](user-guide.md#26-右侧栏)）。回复仍以应用（或机器人账号）的身份发出。更换默认处理的 AI 员工时，跟随默认的会话一起换成新的 AI 员工，另选了 AI 员工的会话保持不变；会话换成另一位 AI 员工时，原来的 AI 员工在那里进行中的工作立即停止，通知只显示在控制台。
- witden 按 **GitHub 用户 ID** 识别 GitHub 用户。在“设置 → 通讯接入 → 身份关联”中，把管理员自己的 GitHub 账号关联到 witden 管理员账号；其他人按连接的外部成员设置处理。

## 6. 在 GitHub 中使用

- 在 issue、pull request 的正文或评论中 @ 应用名（或机器人账号）并说明需求，例如 `@acme-witden 帮忙看看这个报错`，由处理这个 issue 或 pull request 的 AI 员工处理。
- 应用能看到的仓库中，每个 issue 和 pull request 都会记录为 witden 中的一个会话，没有 @ 应用的评论也会记录，但只有 @ 应用的才交给 AI 员工。
- 评论被编辑或删除时，witden 中对应的消息同步更新或删除。
- AI 员工的回复是一条以应用（或机器人账号）身份发出的评论。每个 issue 和 pull request 中只有处理它的一位 AI 员工工作，不会请其他 AI 员工进来协作。

## 7. 资料保护

- AI 员工能读到哪些资料，由它的权限决定：GitHub 工具（按接入和类别授权，以及接入的账号或应用能访问的仓库）、知识空间等。有权读取的内容，AI 员工可以在它工作的任何地方使用，包括在公开仓库中评论、发到 Slack 频道或飞书。
- **公开仓库**中的评论任何人都能看到。不希望某些资料出现在这里时，不要让代表这个仓库的 AI 员工拥有读取这些资料的权限，或把相应的写入设为“询问”，每次由管理员确认。

## 8. 已知限制

- pull request 中针对代码行的评审评论（review comments）暂不同步。
- 评论中的图片和附件只以链接形式保留。AI 员工回复中的 Markdown 图片发到 GitHub 时改为链接（🖼），GitHub 不会替 AI 员工请求图片地址。

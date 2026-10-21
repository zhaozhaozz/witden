# 参与开发

本文面向为 witden 贡献代码的开发者，说明开发环境、测试方法、代码约定和必须保持的设计约束。

## 1. 开发环境

- Node.js 22 或更高版本（npm workspaces）；运行涉及 Docker 的测试需要 Docker。
- `npm ci` 安装依赖；`npm run build` 编译全部包和网页控制台（`server` 依赖 `shared` 和 `manager` 的编译产物）。
- `npm run dev -w @witden/web` 启动控制台开发服务器，`/api` 请求代理到本机 8320 端口。

| 包 | 内容 |
|---|---|
| `packages/shared` | 执行代理协议和 Docker Manager 协议（类型与编解码） |
| `packages/runner` | 虚拟电脑内的执行代理（打包为单个文件放入虚拟电脑镜像） |
| `packages/manager` | Docker Manager（库、HTTP 服务、客户端） |
| `packages/server` | 平台：API、Worker、执行网关、通讯接入、权限、数据库与迁移 |
| `packages/web` | 网页控制台（React） |
| `images/` | 虚拟电脑镜像（命令行、桌面），从仓库根目录构建 |

## 2. 测试与检查

| 命令 | 内容 |
|---|---|
| `npm test` | 快速测试：使用模拟的虚拟电脑（实现真实的执行代理协议）和内存中的嵌入式 PostgreSQL。 |
| `npm run test:web` | Chromium 浏览器回归：对真实控制台页面模拟 API 与事件流，检查流式更新、图表保留、滚动位置、消息发送和窄屏布局；不连接业务数据。首次运行前用 `npx playwright install chromium` 准备浏览器，也可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定已有 Chromium。 |
| `make test-docker` | 先构建虚拟电脑镜像，再运行包含真实 Docker 的测试，包括平台 → Docker Manager → 虚拟电脑 → 执行代理的端到端测试。 |
| `make lint` | biome 检查（行宽 120）和各包的类型检查。 |

- 修改 `packages/server/src/db/schema.ts` 后，在 `packages/server` 目录运行 `npx drizzle-kit generate --name <说明>` 生成迁移，与代码一起提交。迁移在平台启动时自动执行。
- 测试和临时文件写在仓库内的 `.tmp/` 目录（已加入忽略列表），不要写到系统临时目录。

## 3. 代码约定

- 使用嵌入式 PostgreSQL（PGlite）时，事务内只能使用事务句柄；在事务中直接或间接使用全局数据库连接会导致单连接数据库死锁。需要长时间运行或调用外部服务的接口，不要放在事务中处理。
- 模型调用、执行代理操作和对外 HTTP 请求都必须在数据库事务之外进行。
- REST 接口对外使用 snake_case 字段名，内部使用 camelCase，由接口层统一转换并隐藏密钥字段。
- React 的 `useEffect` 使用块体写法，不返回清理函数以外的值。

## 4. 必须保持的设计约束

修改以下相关模块时，请同时补充或更新 `packages/server/test/` 中的对应测试。

1. **执行边界**：AI 工具只能通过执行网关访问虚拟电脑，并且只能访问任务固定的那一台。不要新增在平台服务器上执行操作的路径，也不要在虚拟电脑不可用时改用其他机器。新的执行代理操作必须归入某个工具类别。
2. **Docker 权限只在 Docker Manager**：API 只能请求白名单内的操作；Worker 不得持有 Docker 或执行代理的连接。Docker Manager 的所有入参都经过校验，未知字段一律拒绝。
3. **非 root、无 Docker socket**：虚拟电脑不能以 root 运行，不能挂载宿主机路径或 Docker socket；执行代理拒绝以 root 运行。镜像中不放 sudo，容器始终带 `no-new-privileges`。Docker Manager 以 root 执行的命令只有固定的几条（安装、卸载软件包，清除凭据），一律经 `/usr/bin/env -i` 以清空的环境运行，参数只能是经过校验的名称或路径；新增这类命令时同样处理。真实的模型服务地址和密钥不得进入虚拟电脑，虚拟电脑内的模型访问只能经过执行代理的模型代理，使用平台为这台虚拟电脑签发的密钥。
4. **不盲目重试**：有副作用的操作结果不确定时，先查询执行代理的操作记录，再如实告诉模型，不要自动重做。
5. **权限由系统执行**：新工具必须归入某个工具类别，由服务器按任务的工具范围检查；新接口必须显式检查调用者（控制台账号都是管理员，外部成员只能使用其通讯接入的机器人代表的角色）。
6. **只有有效的 @ 触发工作**：控制台中的 @ 以提交的结构化列表为准；角色之间只能通过专门的工具相互 @，不得根据回答正文中的文字触发其他角色。同一话题内的 @（`message_role`）、委托（`delegate_task`）和转交（`transfer_task`）不属于任何权限组、不需要审批，只能指向已在话题中的角色，不邀请新角色。只有在外部会话本身中工作时（信封的 `external_topic`，`createTask` 按话题设置）不提供这三个工具；由外部会话转来、在内部话题中处理的工作（`outside`）照常提供。系统管理员的工作不提供 `transfer_task`。
7. **权限即资料边界**：角色能读取什么只由它的权限决定（工具类别、知识空间、按接入授权的飞书和 GitHub 工具、读取其他话题），读到的内容不追踪来源，可以在角色工作的任何地方使用。新的资料来源必须挂在一个可以按角色授权的权限上，不要按提问人另做判断。
8. **审计不保存正文**：审计记录“谁、在哪、对什么、做了什么、结果如何”，不保存消息或记忆的正文；通讯同步的临时入站事件处理完成后清除正文。Webhook 原始请求是保留至手动清理的业务历史，保存在 `webhook_receipts`（更早版本的记录在 `trigger_events.request`），不能复制到审计、通知或外部消息；认证请求头必须遮盖。
9. **幂等**：入站事件先保存后确认，并按消息去重；出站按“消息 × 目标频道”去重；执行代理按请求编号去重。重试不能导致任务重复执行或消息重复发送。
10. **密钥读不出来**：模型密钥、通讯凭据、Tunnel token、虚拟电脑的模型访问密钥等任何密钥都不能出现在接口响应或界面上（只返回是否已设置；Webhook 来源的密钥是唯一例外，见约束 18）。新增密钥字段时同时加入 `api/http.ts` 的 `SECRET_FIELDS` 和 `services/config-access.ts` 的 `SECRET_KEYS`。
11. **系统管理员内置且唯一，只走配置接口**：它由平台创建（`services/system-admin.ts` 的 `ensureSystemAdmin`，数据库有唯一约束），接口不能新建、停用、复制它，也不能把其他角色设为系统管理员。它的工具（`read_config`、`change_config`）在 API 进程中以提问人的身份调用控制台接口（`services/config-access.ts`），只能访问其中列出的配置接口。新增配置接口时按需加入这份清单并补充测试；账号与身份关联只由人管理；消息、文件、任务、审批、虚拟电脑内执行和接管不属于配置。这些都不要加入。
12. **执行代理令牌只给执行代理**：虚拟电脑内所有程序都以同一个用户运行，令牌靠进程不可查看来保护。witden 镜像中持有令牌的进程（经 `sh` 再 `exec` 的 tini、`witden-init`、执行代理）都从 `/opt/witden/bin` 下只可执行的程序启动；其他服务由 `witden-init` 启动，不带令牌；执行代理不把令牌传给它启动的程序，也不从用户可写的目录加载代码。Docker Manager 对带 `witden.init=protected` 标签的镜像不使用 Docker 的 init，管理通道不传令牌。修改镜像入口、`witden-init` 或执行代理的启动方式后，运行 `make test-docker`，其中检查虚拟电脑内没有进程能读到令牌。

13. **一个角色在一个话题里只有一段对话**：消息、任务结果和跟进提醒都进入会话的待读列表（`agent/conversation.ts`），由这段对话唯一未结束的那一轮读取（数据库部分唯一索引 `ux_tasks_open_conversation`），不要为同一角色和话题另起并行的运行。待读列表与“这一轮是否结束”必须在同一把行锁下判断，同时锁这一轮和会话时先锁这一轮。
14. **对话的提示开头保持不变**：系统提示词和工具列表中不放随消息变化的内容（时间、提问人、参与者列表等随新消息给出），工具的说明不随某一批消息变化；新内容只追加在上下文末尾。压缩时只替换对话部分，系统提示词和工具说明照常重新生成。修改上下文的组装方式时，更新 `test/conversation.test.ts` 中的前缀检查。
15. **协作范围由话题决定，工作不离开话题**：`dispatch.ts` 的 `planDelegation` 是委托去向的唯一判断处：只能委托给当前话题中的角色，不看角色权限、不需要审批，外部会话中不能委托。委托不得把角色加入任何话题，也不得把工作放到其他话题或私信。没有委托话题外角色的权限组；角色之间在话题外的直接对话只交换消息，见约束 21。话题关联只能建立在外部会话与内部话题之间：`services/topic-links.ts` 的 `addTopicLink` 建立时检查，`sendLinkedMessage` 发送时再检查；控制台私信算内部话题，与机器人的外部私聊算外部会话。跨话题投递只由 `send_message` 的结构化目标（`topic_id`）触发，不根据正文中的 `@` 新增授权，也不开放对方话题的历史。外部会话的角色查看关联内部话题的工作只经 `services/linked-status.ts` 的 `linkedTopicStatus`（工具 `linked_topic_status`，只在 `external_topic` 的工作中提供）：只返回工作状态，不返回消息正文、执行记录和文件（本会话自己发去的请求除外，只给摘录）；角色对话的标题、进度和状态原因来自聊天，一律不返回，只有由本会话发去的请求开始的对话附上该请求的摘录；关联的是私信时只返回本会话发去的请求；不列出系统管理员角色的工作；摘录先 `redact` 再截取，避免截断的密钥不再被识别。发往内部话题的消息进入接收角色在那里的对话；发往外部会话的只经出站队列发布，不在本地再运行角色。经调度的关联消息总会交给一个角色。删除关联时（包括迁移删除的关联），接收方还没读到的关联消息作废，由它开始的独立任务随之结束（`linkedRequestRefusal`，委托出去的任务继承 `topic_routes`）；对话本身照常继续。
16. **来源是服务端的元数据**：原始请求人、来源话题与消息、自动轮次和任务引用由服务器记录，模型不能指定。角色拆出或续做的任务沿用本轮的请求人，不取模型指向的那条消息的作者；跨话题转发、话题内的 @、委托和转交、任务结果和跟进提醒的回送以及续做，都不能去掉外部成员、外部会话或自动事件带来的限制（`services/collaboration-policy.ts` 的 `sourceLimits` / `withSourceLimits` 随待读项传递，委托和拆出的任务经 `buildEnvelope` 继承，转交的任务经 `agent/task-handoff.ts` 的 `CARRIED` 保留），每一跳都计入自动轮次上限。
17. **独立任务的续做**：只能续做本对话用 `start_task` 拆出的任务（控制台中由人补充要求）。补充要求先锁任务行再写入输入队列，在执行的步骤之间读取；发布最终回答前检查是否有未读的输入。每次交付按“任务 × 版本”记录和送回对话，之前的交付不被覆盖；重新开始时按角色当前的模型和提示词，虚拟电脑不变。
18. **Webhook 来源**：Webhook 触发器只能通过来源接收，触发器本身没有密钥。来源的密钥由服务端生成，采用 Standard Webhooks 的 `whsec_<标准 base64>` 格式（不能用 base64url，签名方会拒绝）。请求头中的密钥以 `token_hash` 校验；Standard Webhooks 签名（`webhook-*` / `svix-*`）需要密钥原文，用 `secret_encrypted` 解密后校验，只有哈希的来源只能用请求头密钥。签名覆盖正文，接收时 `onRequest` 只做到请求头能确认的程度（来源存在且有加密副本、时间戳在 5 分钟内），`acceptSourceWebhook` 再对保存的原始字节校验签名。除校验签名外，密钥原文只有控制台账号经 `GET /api/webhook-sources/:id/secret` 读取（记审计，不在系统管理员角色可用的接口清单中）；这是约束 10 的唯一例外，列表等其他响应不返回密钥。原始请求只在 `webhook_receipts` 保存一份，各话题的触发事件引用它；接收按来源去重，处理按触发器分别进行。清空话题的触发历史时，不再被引用的回执一并删除。角色不能读取或更换密钥。`/api/hooks/:id` 只为迁移 0040 转换的来源保留旧地址。相关测试在 `test/triggers.test.ts`、`test/topic-collaboration.test.ts`。
19. **转交是同一个任务换执行者**（`agent/task-handoff.ts`）：只有没有执行、也没有待处理事项的任务才能转交（`TRANSFERABLE`；还要求没有未决的审批、未结束的委托，以及仍被 Worker 持有的领取）。转交时按接手角色重建工具范围（`buildEnvelope`，委托出来的任务仍以委托方为上限），只保留来源带来的限制，原角色的审批不带过去。接手角色的上下文从交接说明开始（`assignment.handoff_context_from_seq`，见 `agent/transcript.ts`），之前的步骤只留在任务记录里。角色停用后，它的独立任务不取消，由 runner 的检查转为 `waiting_role`，等待转交或重新启用；`stillAllowed` 不能因为执行角色停用而取消独立任务。私信只有一个角色，私信中的任务不能转交。任务和对话都不能由人暂停，暂停只来自紧急停止和接管，之后由人“继续”。人和对话（`transferStartedTask`，只限它开始的任务）转交时不得放宽上述状态要求，也不得为执行中的任务加延迟交接。只有执行任务的角色可以在运行中转交自己的任务：`requestHandover` 在工具调用时完成全部检查，只记下请求（`assignment.handover_request`，不含交接说明），runner 随即结束这一轮；Worker 在运行结束、释放领取之前调用 `finishHandover`，只有任务仍在这次领取下执行、仍属于发起的角色时才重新检查并换手，否则（取消、紧急停止等）作废请求并告知原角色；Worker 中途退出时，下一次运行开始即结束（`handoverDue`），由 Worker 补上换手。交接说明只写进简报（`finishHandover` 从工具调用的参数中读取），不存入 `assignment`。未读的补充要求留在 `task_inputs`，由接手的角色读到。角色转交不邀请角色，每次计入自动轮次（`maxAutoRounds`），以角色身份审计。相关测试在 `test/task-handoff.test.ts` 和 `test/role-handoff.test.ts`。
20. **话题只配置标题和目标**：话题的设置只有 `title` 和 `goal`（最多 16000 个字符，`services/topics.ts` 的 `parseGoal`）；响应方式只在话题顶部切换，归档和清理数据是操作而不是设置。目标完整进入角色的系统提示词（`agent/context.ts` 的 `## Topic goal`），调度模型只读开头 `DISPATCH_GOAL_CHARS` 个字符：System 1 放在问题说明里，state 仍只有这条消息。自动轮次上限只有全局的 `WITDEN_MAX_AUTO_ROUNDS`，模型由角色决定；不要为话题另加工作说明、轮次或模型限制之类的设置。相关测试在 `test/response-mode.test.ts`、`test/triggers.test.ts`。
21. **AI 员工之间的直接对话只凭逐个授权、只交换消息**（`agent/contacts.ts`）：角色只能主动联系 `roles.allowed_contacts` 中的角色（单向；不含自己，不含系统管理员，系统管理员自己的列表为空，由 `services/roles.ts` 校验），`contact_role` 在调用时按角色当前的列表再检查一次，不属于权限组、不需要审批，外部会话中（`external_topic`）和系统管理员的工作中不提供；是否提供取决于信封的 `contacts`（由角色配置决定），可以联系的角色列在系统提示词中，两者都只随角色配置变化，不随消息变化（约束 14）。对话发生在只有这两个角色的 `kind = "pair"` 话题中（每对一个，`getOrCreatePairTopic` 用事务级 advisory lock 保证）：没有成员，控制台不能发言、邀请、关联、建触发器或修改设置，其中的任务不能转交，`read_topic` 读不到；在那里工作时（信封的 `pair_topic`）不提供 `message_role`、`delegate_task`、`transfer_task` 和 `ask_human`，`task-handoff.ts` 的 `checkTask` 拒绝转交其中的任务（人和角色都一样）。消息的来处（`ContactRoute`）只随接收方的待读项保存在服务器，不给接收方看；接收方一轮结束时（`settle`）把这一轮最后发出的内容送回来处：发送方的对话，或作为 `task_inputs` 送回仍在进行的独立任务，都不在时送到发送方在 pair 话题中的对话；没有回答就结束的轮次（`afterEnd`）也要告诉发送方。发送方输入的限制经 `sourceLimits` 带给接收方（不带 `topic_routes`），回复带回接收方的限制；每次发送用 `assertNextRound` 计入自动轮次，回复与任务结果一样计入轮次。相关测试在 `test/role-conversations.test.ts`。

## 5. 文档

- `README.md` 和 `docs/` 是面向最终用户和管理员的正式文档。用户能感知的功能、配置、部署方式或安全边界发生变化时，请同步更新。
- 文档使用正式、完整的书面语，说明功能是什么、如何使用、有哪些限制；不记录开发过程或讨论经过。

## 6. 提交

- 提交信息使用英文祈使句，正文说明动机和影响。
- 提交前运行 `make lint` 和 `npm test`；涉及虚拟电脑、执行代理或 Docker Manager 时，再运行 `make test-docker`。


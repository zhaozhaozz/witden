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
- `.github/workflows/docker.yml` 在 pull request 中构建全部镜像（平台、两个虚拟电脑、tunnel、laya）但不发布；合并到 main 或推送 `v*` 标签时发布到 `ghcr.io/<owner>/witden/<镜像>`，即 `docker-compose.yml` 默认拉取的镜像。新增镜像时，同时加入工作流的矩阵和 `docker-compose.yml`，镜像名在两处保持一致；内置模板的虚拟电脑镜像由 `WITDEN_IMAGE_REPO`、`WITDEN_IMAGE_TAG` 拼出（`services/templates.ts`）。README 快速开始逐字贴出 `docker-compose.yml` 的内容，并列出 Compose 必填的配置项，供用户不下载文件直接复制；修改 `docker-compose.yml` 或必填项时同步更新 README，`packages/server/test/readme-quickstart.test.ts` 会检查两者一致。

## 3. 代码约定

- 使用嵌入式 PostgreSQL（PGlite）时，事务内只能使用事务句柄；在事务中直接或间接使用全局数据库连接会导致单连接数据库死锁。需要长时间运行或调用外部服务的接口，不要放在事务中处理。
- 模型调用、执行代理操作和对外 HTTP 请求都必须在数据库事务之外进行。
- REST 接口对外使用 snake_case 字段名，内部使用 camelCase，由接口层统一转换并隐藏密钥字段。
- React 的 `useEffect` 使用块体写法，不返回清理函数以外的值。

## 4. 必须保持的设计约束

修改以下相关模块时，请同时补充或更新 `packages/server/test/` 中的对应测试。

1. **执行边界**：AI 工具只能通过执行网关访问虚拟电脑，并且只能访问任务固定的那一台。不要新增在平台服务器上执行操作的路径，也不要在虚拟电脑不可用时改用其他机器。新的执行代理操作必须归入某个工具类别。
2. **Docker 权限只在 Docker Manager**：API 只能请求白名单内的操作；Worker 不得持有 Docker 或执行代理的连接。Docker Manager 的所有入参都经过校验，未知字段一律拒绝。
3. **非 root、无 Docker socket**：虚拟电脑不能以 root 运行，不能挂载宿主机路径或 Docker socket；除自己的数据卷外，只以只读方式（并带 `NoCopy`）挂载执行代理数据卷（`RUNNER_LIVE_DIR`，见 `packages/manager/src/live-runner.ts`），其中只放执行代理程序，不放任何虚拟电脑的数据；执行代理拒绝以 root 运行。镜像中不放 sudo，容器始终带 `no-new-privileges`。Docker Manager 以 root 执行的命令只有固定的几条（安装、卸载软件包，清除凭据，以及在它自己的容器中安装执行代理），一律经 `/usr/bin/env -i` 以清空的环境运行，参数只能是经过校验的名称或路径；新增这类命令时同样处理。真实的模型服务地址和密钥不得进入虚拟电脑，虚拟电脑内的模型访问只能经过执行代理的模型代理，使用平台为这台虚拟电脑签发的密钥。
4. **不盲目重试**：有副作用的操作结果不确定时，先查询执行代理的操作记录，再如实告诉模型，不要自动重做。
5. **权限由系统执行**：新工具必须归入某个工具类别，由服务器按任务的工具范围检查；新接口必须显式检查调用者（控制台账号都是管理员，外部成员只能使用其通讯接入的角色，以及在该接入的会话中处理那个会话的角色，`security/permissions.ts` 的 `mayUseRoleIn`）。
6. **只有有效的 @ 触发工作**：控制台中的 @ 以提交的结构化列表为准；角色之间只能通过专门的工具相互 @，不得根据回答正文中的文字触发其他角色。同一话题内的 @（`message_role`）、委托（`delegate_task`）和转交（`transfer_task`）不属于任何权限组、不需要审批，只能指向已在话题中的角色，不邀请新角色。只有在外部会话本身中工作时（信封的 `external_topic`，`createTask` 按话题设置）不提供 `delegate_task` 和 `transfer_task`，`message_role` 在那里只能带 `topic_id` 去 @ 它参与的另一个话题中的角色（`agent/tools.ts` 的 `messageRole` 拒绝在外部会话本身中 @）；由外部会话的消息在内部话题中引出的工作（`outside`）照常提供。系统管理员的工作不提供 `transfer_task`。
7. **权限即资料边界**：角色能读取什么只由它的权限决定（工具类别、知识空间、按接入授权的飞书和 GitHub 工具），读到的内容不追踪来源，可以在角色工作的任何地方使用。新的资料来源必须挂在一个可以按角色授权的权限上，不要按提问人另做判断。话题的消息不是这样的资料来源，而由参与关系决定（约束 15）：角色读取当前话题和它参与的群组话题（`my_topics`、`topic_history` 的 `topic_id`、`topic_status`），`read_webhook_history` 只限当前话题；不要加按权限读取其他话题的工具或权限组。私信和 pair 话题不能从其他话题读写；此外，其他话题的内容只经直接对话（`contact_role`，约束 21）到达角色。
8. **审计不保存正文**：审计记录“谁、在哪、对什么、做了什么、结果如何”，不保存消息或记忆的正文；通讯同步的临时入站事件处理完成后清除正文。Webhook 原始请求是保留至手动清理的业务历史，保存在 `webhook_receipts`（更早版本的记录在 `trigger_events.request`），不能复制到审计、通知或外部消息；认证请求头必须遮盖。
9. **幂等**：入站事件先保存后确认，并按消息去重；出站按“消息 × 目标频道”去重；执行代理按请求编号去重。重试不能导致任务重复执行或消息重复发送。
10. **密钥读不出来**：模型密钥、通讯凭据、Tunnel token、虚拟电脑的模型访问密钥等任何密钥都不能出现在接口响应或界面上（只返回是否已设置；Webhook 来源的密钥是唯一例外，见约束 18）。新增密钥字段时同时加入 `api/http.ts` 的 `SECRET_FIELDS` 和 `services/config-access.ts` 的 `SECRET_KEYS`。
11. **系统管理员内置且唯一，只走配置接口**：它由平台创建（`services/system-admin.ts` 的 `ensureSystemAdmin`，数据库有唯一约束），接口不能新建、停用、复制它，也不能把其他角色设为系统管理员。它的工具（`read_config`、`change_config`）在 API 进程中以提问人的身份调用控制台接口（`services/config-access.ts`），只能访问其中列出的配置接口。新增配置接口时按需加入这份清单并补充测试；账号与身份关联只由人管理；消息、文件、任务、审批、虚拟电脑内执行和接管不属于配置。这些都不要加入。
12. **执行代理令牌只给执行代理**：虚拟电脑内所有程序都以同一个用户运行，令牌靠进程不可查看来保护。witden 镜像中持有令牌的进程（经 `sh` 再 `exec` 的 tini、`witden-init`、执行代理）都从 `/opt/witden/bin` 下只可执行的程序启动；其他服务由 `witden-init` 启动，不带令牌；执行代理不把令牌传给它启动的程序，也不从用户可写的目录加载代码。`witden-init` 每次启动执行代理时，在镜像自带的一份和执行代理数据卷中的一份之间选择（`packages/runner/src/live.ts`），后者必须全部属于 root、其他用户不可写，两者都从同一个只可执行的 node、以同一个 `runnerEnv` 启动；启动进程与执行代理之间的约定（启动参数、环境变量、`UPDATE_SIGNAL`、`RESTART_NOW`）变化时提高 `INIT_PROTOCOL`。Docker Manager 对带 `witden.init=protected` 标签的镜像不使用 Docker 的 init，管理通道不传令牌。修改镜像入口、`witden-init` 或执行代理的启动方式后，运行 `make test-docker`，其中检查虚拟电脑内没有进程能读到令牌。

13. **一个角色在一个话题里只有一段对话**：消息、任务结果和跟进提醒都进入会话的待读列表（`agent/conversation.ts`），由这段对话唯一未结束的那一轮读取（数据库部分唯一索引 `ux_tasks_open_conversation`），不要为同一角色和话题另起并行的运行。待读列表与“这一轮是否结束”必须在同一把行锁下判断，同时锁这一轮和会话时先锁这一轮。
14. **对话的提示开头保持不变**：系统提示词和工具列表中不放随消息变化的内容（时间、提问人、参与者列表等随新消息给出），工具的说明不随某一批消息变化；新内容只追加在上下文末尾。压缩时只替换对话部分，系统提示词和工具说明照常重新生成。修改上下文的组装方式时，更新 `test/conversation.test.ts` 中的前缀检查。
15. **协作范围由参与的话题决定，工作不离开话题**：`dispatch.ts` 的 `planDelegation` 是委托去向的唯一判断处：只能委托给当前话题中的角色，不看角色权限、不需要审批，外部会话中不能委托。委托不得把角色加入任何话题，也不得把工作放到其他话题或私信。没有委托话题外角色的权限组；角色之间在话题外的直接对话只交换消息，见约束 21。话题之间没有关联：角色能跨话题读取和发言的范围，只是它当前参与、未归档的 `kind = "group"` 话题（`services/member-topics.ts` 的 `memberTopic` / `memberTopics`；外部会话中只算 `externalRoleId` 指向的处理角色，约束 26），每次调用时检查，不写进系统提示词（`my_topics` 是工具，约束 14）；私信（`dm`）、pair 话题和归档的话题一律拒绝，系统管理员没有这些工具（`toolsFor`），调用也被拒绝（`memberTopic`、`postInTopic`）。跨话题发送只由 `send_message` / `message_role` 的结构化 `topic_id` 触发（`agent/topic-messaging.ts` 的 `postInTopic`），不根据正文中的 `@` 新增授权，也不让任何人或角色加入话题：消息以发送角色的身份发在目标话题（`source = "topic"`，`external_ref.topic_delivery` 记录来源）；在控制台话题中只有 `message_role` 指定的、参与那里的角色收到（待读项带 `answer_to`），其他角色和调度模型都不处理，被 @ 的角色一轮结束时（`settle`）由 `answerAskers` 把它在那里最后发出的内容送入发起角色在同一话题中的对话；发往外部会话的只经出站队列发布，不在本地运行角色，`integrations/delivery.ts` 在发布前确认发送角色仍参与那个会话。在 pair 话题中工作时不向其他话题发送。由跨话题消息开始的独立任务（委托出去的任务继承 `topic_routes`）在每一步由 `crossTopicRefusal` 复查：发送角色仍参与来源和目标话题、请求人仍在原来的话题、两个话题都未归档、接入仍处于启用状态；对话本身照常继续。`topic_status`（`services/topic-status.ts`）不列出系统管理员角色的工作，摘录先 `redact` 再截取，避免截断的密钥不再被识别。相关测试在 `test/topic-collaboration.test.ts`。
16. **来源是服务端的元数据**：原始请求人、来源话题与消息、自动轮次和任务引用由服务器记录，模型不能指定。角色拆出或续做的任务沿用本轮的请求人，不取模型指向的那条消息的作者；跨话题的发言和 @、话题内的 @、委托和转交、任务结果、跟进提醒和跨话题回答的回送以及续做，都不能去掉外部成员、外部会话或自动事件带来的限制（`services/collaboration-policy.ts` 的 `sourceLimits` / `withSourceLimits` 随待读项传递，委托和拆出的任务经 `buildEnvelope` 继承，转交的任务经 `agent/task-handoff.ts` 的 `CARRIED` 保留），每一跳都计入自动轮次上限。
17. **独立任务的续做**：只能续做本对话用 `start_task` 拆出的任务（控制台中由人补充要求）。补充要求先锁任务行再写入输入队列，在执行的步骤之间读取；发布最终回答前检查是否有未读的输入。每次交付按“任务 × 版本”记录和送回对话，之前的交付不被覆盖；重新开始时按角色当前的模型和提示词，虚拟电脑不变。
18. **Webhook 来源**：Webhook 触发器只能通过来源接收，触发器本身没有密钥。来源的密钥由服务端生成，采用 Standard Webhooks 的 `whsec_<标准 base64>` 格式（不能用 base64url，签名方会拒绝）。请求头中的密钥以 `token_hash` 校验；Standard Webhooks 签名（`webhook-*` / `svix-*`）需要密钥原文，用 `secret_encrypted` 解密后校验，只有哈希的来源只能用请求头密钥。签名覆盖正文，接收时 `onRequest` 只做到请求头能确认的程度（来源存在且有加密副本、时间戳在 5 分钟内），`acceptSourceWebhook` 再对保存的原始字节校验签名。除校验签名外，密钥原文只有控制台账号经 `GET /api/webhook-sources/:id/secret` 读取（记审计，不在系统管理员角色可用的接口清单中）；这是约束 10 的唯一例外，列表等其他响应不返回密钥。原始请求只在 `webhook_receipts` 保存一份，各话题的触发事件引用它；接收按来源去重，处理按触发器分别进行。清空话题的触发历史时，不再被引用的回执一并删除。角色不能读取或更换密钥。`/api/hooks/:id` 只为迁移 0040 转换的来源保留旧地址。相关测试在 `test/triggers.test.ts`、`test/topic-collaboration.test.ts`。
19. **转交是同一个任务换执行者**（`agent/task-handoff.ts`）：只有没有执行、也没有待处理事项的任务才能转交（`TRANSFERABLE`；还要求没有未决的审批、未结束的委托，以及仍被 Worker 持有的领取）。转交时按接手角色重建工具范围（`buildEnvelope`，委托出来的任务仍以委托方为上限），只保留来源带来的限制，原角色的审批不带过去。接手角色的上下文从交接说明开始（`assignment.handoff_context_from_seq`，见 `agent/transcript.ts`），之前的步骤只留在任务记录里。角色停用后，它的独立任务不取消，由 runner 的检查转为 `waiting_role`，等待转交给同一话题中的角色或重新启用；`stillAllowed` 不能因为执行角色停用而取消独立任务。私信只有一个角色，私信中的任务不能转交。任务和对话都不能由人暂停，暂停只来自紧急停止和接管，之后由人“继续”。人和对话（`transferStartedTask`，只限它开始的任务）转交时不得放宽上述状态要求，也不得为执行中的任务加延迟交接。只有执行任务的角色可以在运行中转交自己的任务：`requestHandover` 在工具调用时完成全部检查，只记下请求（`assignment.handover_request`，不含交接说明），runner 随即结束这一轮；Worker 在运行结束、释放领取之前调用 `finishHandover`，只有任务仍在这次领取下执行、仍属于发起的角色时才重新检查并换手，否则（取消、紧急停止等）作废请求并告知原角色；Worker 中途退出时，下一次运行开始即结束（`handoverDue`），由 Worker 补上换手。交接说明只写进简报（`finishHandover` 从工具调用的参数中读取），不存入 `assignment`。未读的补充要求留在 `task_inputs`，由接手的角色读到。人和角色都只能转交给已在任务所在话题中、已启用的角色（`prepare` 检查，两者一样）：转交不邀请角色，人需要先在话题中邀请；外部会话中只有处理它的角色（约束 26），没有可以接手的角色。控制台的转交窗口只列出话题中可以接手的角色（`pages/tasks/taskParts.tsx`）。任务（拆出、委托、转交、续做）不计入自动轮次（`maxAutoRounds`），沿用开始时的轮次；角色转交以角色身份审计。相关测试在 `test/task-handoff.test.ts` 和 `test/role-handoff.test.ts`。
20. **话题只配置标题和目标**：话题的设置只有 `title` 和 `goal`（最多 16000 个字符，`services/topics.ts` 的 `parseGoal`）；响应方式只在话题顶部切换，归档和清理数据是操作而不是设置。目标完整进入角色的系统提示词（`agent/context.ts` 的 `## Topic goal`），调度模型只读开头 `DISPATCH_GOAL_CHARS` 个字符：System 1 放在问题说明里，state 仍只有这条消息。自动轮次上限只有全局的 `WITDEN_MAX_AUTO_ROUNDS`，模型由角色决定；不要为话题另加工作说明、轮次或模型限制之类的设置。相关测试在 `test/response-mode.test.ts`、`test/triggers.test.ts`。
21. **AI 员工之间的直接对话只凭逐个授权、只交换消息**（`agent/contacts.ts`）：角色只能主动联系 `roles.allowed_contacts` 中的角色（单向；不含自己，不含系统管理员，系统管理员自己的列表为空，由 `services/roles.ts` 校验），`contact_role` 在调用时按角色当前的列表再检查一次，不属于权限组、不需要审批，外部会话中（`external_topic`）和系统管理员的工作中不提供；是否提供取决于信封的 `contacts`（由角色配置决定），可以联系的角色列在系统提示词中，两者都只随角色配置变化，不随消息变化（约束 14）。对话发生在只有这两个角色的 `kind = "pair"` 话题中（每对一个，`getOrCreatePairTopic` 用事务级 advisory lock 保证）：没有成员，控制台不能发言、邀请、建触发器或修改设置，其中的任务不能转交，其他话题不能读写它；在那里工作时（信封的 `pair_topic`）不提供 `message_role`、`delegate_task`、`transfer_task` 和 `ask_human`，也不向其他话题发送（`postInTopic`），`task-handoff.ts` 的 `checkTask` 拒绝转交其中的任务（人和角色都一样）。消息的来处（`ContactRoute`）只随接收方的待读项保存在服务器，不给接收方看；接收方一轮结束时（`settle`）把这一轮最后发出的内容送回来处：发送方的对话，或作为 `task_inputs` 送回仍在进行的独立任务，都不在时送到发送方在 pair 话题中的对话；没有回答就结束的轮次（`afterEnd`）也要告诉发送方。在 pair 话题中加锁的顺序是：这一轮（或任务）→ pair 话题的行 → 会话（`lockPair`；在那里发消息时 `saveMessage` 也先更新话题行），两个角色同时回答对方时依次等待而不会死锁。发送方输入的限制经 `sourceLimits` 带给接收方（不带 `topic_routes`），回复带回接收方的限制；每次发送用 `assertNextRound` 计入自动轮次，回复与任务结果一样计入轮次。相关测试在 `test/role-conversations.test.ts`。
22. **工作只受 token、取消和紧急停止约束，工具输出只截取一次**：运行没有步数上限（`taskBudget` 只有 `max_tokens`），不要再加步数或轮内次数之类的上限。工具结果交给模型时只在 `agent/tool-output.ts` 的 `boundOutput` 按 `WITDEN_TOOL_OUTPUT_LIMIT` 截取：超过时完整内容（先 `redact`）以 `<工具调用编号>:output` 的调用编号经 `file.write` 写入 `~/.witden/tool-output/`，模型读到开头、结尾和注明；没有虚拟电脑或没有 `files` 权限时只截取并说明原因。它不抛错，要在事务外调用。可能较长的新工具结果都经它返回，不要在工具里或执行代理一侧另做截断（浏览器快照只在执行代理中给元素编号时有一处数量上限，正文只有远高于真实页面的防护上限）；`read_file` 自己按行分页，不经 `boundOutput`，否则读取保存的文件又会生成新文件。相关测试在 `test/tool-output.test.ts`、`test/work-limits.test.ts`。
23. **命令不因等待超时而结束，结束只通知一次**（`agent/commands.ts`，执行代理的 `ops/commands.ts`）：`run_command` 的 `timeout_seconds` 只是前台等待的时间，到时仍在运行的命令转到后台。不要加入因超时、连接中断、执行代理重启、任务或对话结束而停止后台命令或终端会话的逻辑，也不要自动删除它们的记录或日志：只有角色自己（`command_stop`、`terminal_control`）、管理员或虚拟电脑停止、重置能结束它们。执行代理把命令放在独立的会话中运行，输出写入日志文件、退出码由包装的 shell 写入状态文件，重启后从文件接管；停止命令时只向命令的进程发信号，不向包装的 shell 发。平台在发出 `command.start` 之前写入 `background_commands`（结束事件可能先于启动的应答到达）。结束只通知一次，在启动它的任务行锁、再命令行锁之下设置 `notified_at`：对话进入收件箱（`kind: "command"`），进行中的任务在下一步读到（`consumeCommandNotices`），定时等待中（`waiting_timer`，含 `command_wait`）的任务被唤醒，已结束的任务交给它汇报的对话或记入日志；在前台等到结果、由 `command_stop` 或 `command_status` 看到结束的命令标记为已告知，不再通知；前台等待被放弃（Worker 中断）的命令过了 `foreground_until` 后补发通知。执行代理（重新）连接时由 API 进程用 `command.list` 核对仍在运行的命令；执行代理是不可信的，只接受本虚拟电脑命令的结束事件。启动结果不确定时先查执行代理的操作记录（`recover`），不要再次启动。命令输出是约束 22 的例外：完整输出已在命令的日志文件中，执行代理按 `toolOutputLimit` 返回一段摘录，服务端不再经 `boundOutput`，也不再截取；`terminal_read` 则经 `boundOutput` 返回，执行代理一侧只有远高于所读行数的防护上限。执行代理在 `info.tools` 中没有 `command`（`COMMAND_TOOL`）时，`run_command` 仍用 `exec.run`（超时结束），其他命令工具提示需要重置虚拟电脑。相关测试在 `test/background-commands.test.ts` 和 `packages/runner/test/commands.test.ts`。
24. **任务进展是任务上的记录**（`agent/task-updates.ts`）：`post_progress` 在任务中记到当前任务，带 `task_id` 时记到同一话题中的另一项独立任务；对话不带 `task_id` 时只更新本轮显示的进展，不写记录。记录存在 `task_updates`（正文先脱敏，最长 4000 字），最新一条同时写入 `tasks.progress`；不发到话题，不交给正在执行的角色，只在任务详情（随任务内容的可见性）和转交简报（最近 10 条）中出现。不要为它另开跨话题的途径。相关测试在 `test/task-updates.test.ts`。
25. **技能只由控制台账号请求的工作修改，是带文件的完整一份**（`services/role-skills.ts`、`agent/skill-dirs.ts`）：技能是 AI 员工某类工作的做法，按 AI 员工保存在 `role_skills`，可以带文件（`role_skill_files`：相对路径、大小、sha256、可执行标记、最后修改人；内容在平台数据目录，每个版本用新的存储键）。文件路径一律经 `skillFilePath` 检查：相对、`/` 分隔（`\` 视为 `/`），没有空的部分、`.`、`..` 和控制字符，顶层的 `SKILL.md` 保留给内容；同一技能中一个路径不能既是文件又是目录。文件内容不在数据库事务中：变更经 `SkillBlobs` 在提交前写入新内容，提交后才删除被替换的内容，失败时删除新写入的内容，数据库中的行永远不指向不存在的内容；会删除内容的接口不持有请求事务（`authedNoTx` 加 `blobs.run(() => transaction(...))`）。系统提示词只列出名称、说明和文件个数（`agent/context.ts` 的 `## Your skills`，按名称排序，没有技能时不出现），只随技能及其文件的增删改变化（约束 14）；全文由 `read_skill` 读取，经 `boundOutput` 返回，并附文件列表。`read_skill` 经 `putSkillDirectory` 把技能写入 AI 员工自己的虚拟电脑：先 `file.remove` 删除 `~/.witden/skills/<名称>`，再用带 `mode` 的 `file.write` 写入 `SKILL.md`（`skillMarkdown`：front matter 写名称和说明，然后是内容）和每个文件；这些操作以工具调用编号加 `:skill` 经执行网关，需要信封中有 `files`、执行代理的 `info.tools` 中有 `FILE_TREE_TOOL`，否则只说明原因，仍返回内容和文件列表，从不抛错；带 `file` 参数时只返回一个文本文件。`save_skill` 带 `directory` 时先检查拒绝，再经 `file.tree`（跳过符号链接和 `.git`）和 `file.read` 读取目录，含已知格式密钥的文件拒绝，`SKILL.md` 由 `parseSkillMarkdown` 解析（只取 front matter 的 `name`、`description`），技能的文件整体换成目录中的文件；不带 `directory` 时文件不变。`read_skill` 不属于任何权限组，除系统管理员外始终提供，工具列表不因有没有技能而变化。`save_skill`（按名称新建或整体替换）和 `delete_skill` 属于 `skills` 组，新建的 AI 员工默认允许，只能修改调用者自己的技能；写入前由 `roleSkillRefusal` 检查，与 AI 员工记忆共用 `forConsoleAccount`：只有控制台账号请求、信封中没有 `automation_event` 和 `untrusted_input` 的工作可以修改，这两个工具的 `refusal` 让被拒绝的调用不进入审批。系统管理员没有技能（`ORDINARY_ROLE_GROUPS`；`services/roles.ts` 拒绝把 `skills` 给它，接口拒绝为它新建技能，配置接口也不能修改系统管理员角色的技能）。每次新建、修改和删除（包括文件的增删改）都以人或 AI 员工的身份记审计，只记技能名称、文件路径和文件个数；删除技能时清空说明和内容并删除全部文件。复制 AI 员工时复制技能和文件（`copySkills`，文件内容复制到新的存储键），AI 员工记忆不复制；删除 AI 员工时技能随之删除。不要为技能或文件另加个数和总大小上限：每个文件沿用上传上限 `MAX_UPLOAD_BYTES`（`services/files.ts`），请求沿用 60 MB。相关测试在 `test/role-skills.test.ts` 和 `packages/runner/test/files.test.ts`。
26. **外部会话只有一个角色：处理它的角色**（`integrations/links.ts` 的 `externalHandler`、`externalRoleId`）：关联了 Slack、飞书、GitHub 会话的话题中只有一个角色工作，即话题的 `handler_role_id`；为空（默认）时跟随接入的 `settings.role_id`。话题关联了多个接入的会话时，默认取最早关联的会话所属的接入（`externalContext` 按 `created_at`、`id` 取第一条，与控制台显示的 `channelsOf` 一致）。入站分派（`integrations/inbound.ts`）、分派检查（`contextForTopic` 给 `assignment.ts` 的 `handlerRoleId`）、`inviteRole`、`stillAllowed`、外部会话的触发器（`services/triggers.ts` 投递时取当前处理角色，不用快照中的角色）、任务转交和外部成员的使用权限（`mayUseRoleIn`）都经这里判断，不要再直接读接入的 `settings.role_id`。对外始终以机器人的身份发言，消息前不加角色名称。处理角色只由控制台账号经 `PATCH /api/topics/:id` 的 `handler_role_id` 修改（`services/connection-role.ts` 的 `setTopicHandler`）：只限外部会话（包括外部私聊），目标须是已启用、不是系统管理员的角色，`null` 恢复跟随默认。接入的角色变化时，`rebindConnectionTopics` 只重绑跟随默认的话题，另选了角色的话题保持不变（审计中的 `kept`）；跟随默认、关联了多个接入的话题保留各接入的角色（工作的只有最早关联的那个）。两种变化都经 `bindTopic`：其他角色移出，新角色加入（通知带 `mirror: false`，只留在控制台），话题的触发器改为新角色，随后 `recheckActiveTasks` 取消被移出角色在那里的工作；分别审计 `topic.handler_role`（`from`、`to`、`chosen` 和计数）与 `connection.role_change`。控制台不能直接邀请或移除外部会话的成员（`api/topics.ts` 的 `refuseExternalMembers`）。相关测试在 `test/slack.test.ts`、`test/feishu.test.ts`、`test/triggers.test.ts`。

## 5. 文档

- `README.md` 和 `docs/` 是面向最终用户和管理员的正式文档。用户能感知的功能、配置、部署方式或安全边界发生变化时，请同步更新。
- 文档使用正式、完整的书面语，说明功能是什么、如何使用、有哪些限制；不记录开发过程或讨论经过。

## 6. 提交

- 提交信息使用英文祈使句，正文说明动机和影响。
- 提交前运行 `make lint` 和 `npm test`；涉及虚拟电脑、执行代理或 Docker Manager 时，再运行 `make test-docker`。


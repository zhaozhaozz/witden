# 参与开发

## 环境与常用命令

- Node.js 22+（npm workspaces）；端到端测试需要 Docker。
- `npm ci` 安装依赖；`npm run build` 编译全部包与控制台（`server` 依赖 `shared`、`manager` 的 `dist`）。
- `npm test` 跑快速测试：模拟电脑（`packages/server/test/support/fake-computer.ts`，说真实的 Runner 协议）+ 内存 PGlite。
- `make test-docker` 先构建云电脑镜像，再跑包含真实 Docker 的测试（`WITDEN_DOCKER_TESTS=1`），包括平台 → Manager → 电脑 → Runner 的端到端测试。
- `make lint` 运行 biome 与各包类型检查（行宽 120）。
- 改了 `packages/server/src/db/schema.ts` 后，在 `packages/server` 下运行 `npx drizzle-kit generate --name <描述>` 生成迁移并一起提交。
- 测试与临时文件写在仓库内 `.tmp/`（已忽略），不要写到 `/tmp`。

## 注意事项

- 在 PGlite 上，事务内只能用事务句柄（`tx`）。在 `transaction()` 或 `authed()` 处理函数里调用全局 `db()`（包括间接调用）会让单连接数据库死锁。需要长时间操作或对外调用的接口用 `authedNoTx`。
- 模型调用、Runner 操作、对外 HTTP 都放在事务之外。
- REST 接口对外保持 snake_case（`api/http.ts` 的 `body()` / `row()` 负责转换并隐藏密钥字段）。

## 必须保持的不变量

修改以下模块时，请同时补充或更新对应测试（`packages/server/test/` 下的 `agent-flow`、`isolation`、`computers`、`slack`、`core`）：

1. **执行边界**：AI 工具只能通过执行网关（`compute/gateway.ts`）访问电脑，且只访问任务固定的实例。不要新增在平台宿主机上执行的代码路径，也不要在实例不可用时“换一台”。新的 Runner 操作必须在 `opGroup` 中归入某个工具组。
2. **Docker 权限只在 Manager**：API 只通过 `ManagerApi` 请求白名单操作；Worker 不得持有 Docker 或 Runner 连接。Manager 的入参全部经 `validate.ts` 校验（未知字段拒绝）。
3. **非 root 与无 socket**：电脑不能以 root 运行、不能挂宿主机路径或 Docker socket；Runner 拒绝 root。
4. **不盲目重试**：有副作用的操作结果不确定时，先查 Runner 请求日志，再如实告诉模型；不要自动重放。
5. **权限由系统执行**：新工具必须归入某个工具组（`agent/tools.ts`），由运行器按任务信封检查；新接口必须显式检查权限（默认拒绝）。
6. **信息流**：任何由角色产生、会被其他人看到的内容（消息、文件、进度、预览、外部同步）都要经过 `security/labels.ts` 的 `checkFlow`；工具读取新来源的数据时要返回对应标签。
7. **审计不存正文**：审计记录“谁、在哪、做了什么”，不保存消息或记忆的正文；入站队列处理完清空正文；密钥在任何输出前都要脱敏。
8. **幂等**：入站事件先落库后确认并按消息去重，出站按“消息 × 目标会话”去重；Runner 请求按 ID 去重。重试不能重复执行任务或重复发送。

## 提交

- 提交信息使用英文祈使句，正文说明动机与影响。
- 提交前运行 `make lint` 与 `npm test`；涉及电脑、Runner、Manager 时再跑 `make test-docker`。

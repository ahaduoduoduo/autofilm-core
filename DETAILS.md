# Repository details

Updated: 2026-07-28

## 根目录

- `package.json`：npm workspace 命令。
- `tsconfig.base.json`：共享 TypeScript 严格配置。
- `Dockerfile`：构建共享类型、React 前端和 Fastify 后端的单镜像。
- `compose.yaml`：Core 与可选 Adapter/搜索服务。
- `compose.full.yaml`：从相邻 fork 源码构建整个媒体系统。
- `.env.example`、`.env.full.example`：单服务和完整编排参数模板。

## `packages/contracts`

- `src/index.ts`：前后端共享枚举、管理对象和 WeClaw
  `2026-07-01` Native Message Service 类型。

## `apps/server/src`

- `index.ts`：进程入口，启动任务进度、Outbox 和清理定时器。
- `app.ts`：组装数据库、服务、路由和静态前端。
- `config.ts`：环境变量校验和数据目录。
- `bootstrap.ts`：可选环境变量所有者与首个 AI 供应方初始化。
- `app-context.ts`：应用依赖类型。

### `ai`

- `types.ts`：渠道和供应方无关的消息、工具与响应类型。
- `client.ts`：按协议选择 Adapter。
- `openai-responses.ts`：Responses 请求与函数调用映射。
- `openai-chat.ts`：Chat Completions 兼容映射。
- `anthropic.ts`：Anthropic Messages 映射。
- `gemini.ts`：Gemini GenerateContent 映射。
- `http.ts`：AI HTTP 错误和超时处理。

### `agent`

- `service.ts`：持久化会话、模型调用、工具迭代和管理员扫码工具。
- `tools.ts`：TMDB、Jackett、OpenList、Jellyfin、任务和时间工具。
- `prompt.ts`：下载确认、远端路径和凭据安全规则。

### `api`

- `auth.ts`、`auth-routes.ts`：Cookie 会话、首次初始化和登录。
- `admin-routes.ts`：管理界面 API、服务测试和 OpenList 扫码代理。
- `native-routes.ts`：WeClaw 事件认证、去重、身份审批和 Agent 回复。

### `db`

- `database.ts`：SQLite WAL 和顺序迁移。
- `user-store.ts`：成员、会话和外部身份。
- `config-store.ts`：AI、模型、渠道和媒体服务配置。
- `conversation-store.ts`：会话消息和 Native 事件去重。
- `task-store.ts`：任务生命周期。
- `outbox-store.ts`：主动聊天通知和指数退避。
- `media-store.ts`：短期、限次读取的二维码媒体。

### `integrations`、`tasks`、`channels`

- `integrations/openlist.ts`：离线下载、内存任务状态、调度器和扫码会话。
- `integrations/jellyfin.ts`：媒体搜索和 `RemoteRefresh`。
- `integrations/jackett.ts`、`tmdb.ts`：发布版本和影片目录。
- `tasks/progress-worker.ts`：每 15 秒读取 OpenList 内存任务状态。
- `channels/outbound.ts`：向 Native Adapter 发送主动消息。

## `apps/web/src`

- `App.tsx`：认证状态和轻量浏览器路由。
- `components/Shell.tsx`：响应式侧栏、主题和用户菜单。
- `components/Ui.tsx`、`Toast.tsx`：可复用管理组件。
- `pages/AuthPage.tsx`：初始化与登录。
- `pages/DashboardPage.tsx`：运行概况。
- `pages/AiPage.tsx`：供应方、模型和连接测试。
- `pages/MembersPage.tsx`：成员和外部身份审批。
- `pages/ChannelsPage.tsx`：Native Adapter 和 WeClaw 配置示例。
- `pages/ServicesPage.tsx`：媒体服务和 115 扫码登录。
- `pages/TasksPage.tsx`：任务进度。
- `pages/PlaygroundPage.tsx`：管理员 Agent 测试。
- `styles/`：按设计令牌、布局、组件和页面拆分的样式。

复杂流程分别记录在 `docs/architecture.md`、`docs/ai-providers.md`、
`docs/native-adapters.md`、`docs/openlist-jellyfin.md` 和
`docs/security.md`。

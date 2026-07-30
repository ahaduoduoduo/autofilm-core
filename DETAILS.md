# Repository details

Updated: 2026-07-30

## 根目录

- `package.json`：npm workspace 命令。
- `tsconfig.base.json`：共享 TypeScript 严格配置。
- `Dockerfile`：构建共享类型、React 前端和 Fastify 后端的单镜像。
- `Dockerfile.telegram`：构建独立 Telegram Adapter 镜像。
- `compose.yaml`：从 GHCR 运行 Core 与可选 Adapter/搜索服务。
- `compose.full.yaml`：从 GHCR 运行完整媒体系统；数据目录通过环境变量指定，
  可接管现有 OpenList/Jellyfin 持久化目录。
- `compose.build.yaml`：仅在开发时加入相邻 fork 的本地构建上下文。
- `.github/workflows/build-images.yml`：在 GitHub Actions 构建并发布五类 GHCR
  镜像，Jellyfin 同时提供公共版和个人版标签。
- `.env.example`、`.env.full.example`：单服务和完整编排参数模板。
- `docs/system-repositories.md`：六个源码仓库、上游、分支和修改边界。
- `docs/communication.md`：容器通信、认证方式和用户交互流程。

## `packages/contracts`

- `src/index.ts`：前后端共享枚举、管理对象和 WeClaw
  `2026-07-01` Native Message Service 类型。

## `apps/server/src`

- `index.ts`：进程入口，启动任务进度、OpenList 鉴权、追更、Outbox 和清理定时器。
- `app.ts`：组装数据库、服务、路由和静态前端。
- `config.ts`：环境变量校验和数据目录。
- `bootstrap.ts`：可选环境变量所有者与首个 AI 供应方初始化。
- `app-context.ts`：应用依赖类型。

### `ai`

- `types.ts`：渠道和供应方无关的消息、图片、工具与响应类型。
- `client.ts`：按协议选择 Adapter。
- `openai-responses.ts`：Responses 请求与函数调用映射。
- `openai-chat.ts`：Chat Completions 兼容映射。
- `anthropic.ts`：Anthropic Messages 映射。
- `gemini.ts`：Gemini GenerateContent 映射。
- `http.ts`：AI HTTP 错误和超时处理。

### `agent`

- `service.ts`：持久化会话、按会话顺序执行顶层请求、并行工具迭代、TMDB 封面
  媒体生成、只读追更检查和管理员扫码工具。
- `conversation-queue.ts`：同一会话按提交顺序执行，不同会话互不等待。
- `catalog-poster.ts`：从本次 TMDB 搜索结果和最终回复中确定唯一条目，不猜测
  存在歧义的封面。
- `media-destination.ts`：使用媒体库根目录、TMDB 英文名和季号生成电影、单季及
  多季合集下载目录，并返回正确的 Jellyfin 刷新目标与 TMDB ID。
- `tool-executor.ts`：并行执行同轮工具并按原调用顺序返回结果。
- `tools.ts`、`tool-types.ts`：工具组合入口和共享依赖。
- `toolsets/`：基础目录、下载/OpenList、字幕、Jellyfin 和追更工具。
- `toolsets/subtitle-placement.ts`：用文件 UUID 生成不可变字幕映射计划，校验摘要、
  重复使用和 Jellyfin 目标，并处理部分失败重试。
- `prompt.ts`：可迁移的旧版 Agent 行为、当前远端媒体规则，以及各独立 AI
  上下文的默认提示词和版本。

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
- `media-store.ts`：短期、限次读取的二维码和影片封面媒体。
- `watchlist-store.ts`：按成员隔离的追更和分集状态。
- `prompt-store.ts`：提示词初始化、读取、自定义和恢复默认值；系统升级只替换
  未自定义的旧版本。
- `conversation-store.ts`：持久化聊天消息并按数据库插入序号读取；最近 80 条记录
  命中请求中间位置时，向前扩展到该次用户请求起点，避免拆分工具调用与结果。

### `integrations`、`tasks`、`channels`

- `integrations/openlist.ts`：通过受限 `/api/autofilm` API 处理离线下载、
  内存任务状态、调度器和扫码会话，并读取电影/电视剧媒体库根目录配置。
- `integrations/jellyfin.ts`：使用 Jellyfin 12 标准鉴权处理媒体搜索、
  `RemoteRefresh`、字幕读取、上传和删除。
- `integrations/jackett.ts`：完整结果按文件大小降序、每页 20 条及短期查询缓存。
- `integrations/tmdb.ts`：影片目录，同时兼容 Read Access Token 与 v3 API Key，
  并提供季、分集日期和受限大小的封面读取。
- `integrations/subhd.ts`：识别关联影片页并返回完整字幕列表、评论回复，以及按任务
  隔离且可并发执行的下载会话；统一限制请求开始间隔。
- `integrations/cookie-jar.ts`：管理单个 SubHD 下载会话的响应 Cookie，不在任务间
  共享状态。
- `integrations/weclaw-registration.ts`：读取同一 Compose 的 WeClaw 配置与登录账号，
  自动建立 Core 渠道记录且不向浏览器返回令牌。
- `tasks/progress-worker.ts`：每 2 秒读取 OpenList 内存任务状态，处理 115
  短时失败、远端任务删除和备用资源等待；只把 OpenList `StateSucceeded` 认定为
  完成，`StateCanceled` 和 `StateFailed` 分别映射为取消和失败。超时后只发送
  备用资源选择提示，不自动提交。
  完成后优先使用云端最终结果路径精确刷新 Jellyfin，且该路径必须位于任务目标
  目录内；旧接口没有结果路径时才使用原有刷新目标，并保存重试状态。
- `tasks/download-completion-worker.ts`：按同一次下载请求的工作流 ID 等待所有
  OpenList 任务成功且 Jellyfin 导入完成，然后恢复原聊天会话。只执行此前已经约定
  的可选字幕操作；没有字幕计划时直接报告视频入库结果。
- `tasks/openlist-auth-worker.ts`：每分钟读取 OpenList 本地的 115 风控状态，不访问
  115；发现新的 HTTP 405 标记时向每个已配置渠道中的 owner/admin 身份发送通知，
  同一次标记不重复发送。
- `tasks/watchlist-worker.ts`：按间隔读取 TMDB 并调用只读 Agent 检查追更条件。
- `channels/outbound.ts`：向 Native Adapter 发送主动消息；Adapter 因缺少当前会话
  令牌返回 409 时延后投递，不消耗失败次数。
- `channels/agent-messages.ts`：把 Agent 最终文本中的 Core 临时媒体 URL 提取为
  Native 图片消息，并保留其余文字。

### `ai`

- `ai/history.ts`：在所有 AI 协议共用的规范消息层修复工具历史；移除孤立和重复
  结果，为进程中断后缺失的结果生成可恢复错误。
- `ai/client.ts`：为四种协议统一应用历史修复；供应方仍返回工具历史不一致错误时，
  使用系统提示和当前用户请求自动重试一次。

### `subtitles`

- `captcha-recognizer.ts`：独立视觉模型上下文和固定 OCR 提示词。
- `download-service.ts`：每个下载独立执行最多五次自动验证码处理；人工验证码不占用
  全局等待状态。
- `extract.ts`：7z/unzip/unrar 多级解压、UTF-8/UTF-16/GB18030 编码归一化和
  字幕格式限制。
- `cleaner.ts`：每个文本字幕使用独立 AI 请求分析全部事件，不做正则预筛选。
- `ass-style.ts`：旧版 ASS 样式分析、行内标签和黑边特效坐标处理。
- `hints.ts`：从解压相对路径推断集号、语言和 Jellyfin 语言标签。
- `workspace-store.ts`：一个任务累计多个字幕包、文件和验证码的成员级临时工作区；
  文件只使用 UUID，并保存不可变放置计划和逐项执行状态。
- `references.ts`：为 Jellyfin 外挂字幕生成摘要引用，并在删除或替换前解析当前流。
- `types.ts`：字幕搜索、验证码、提取文件、放置计划和临时工作区类型。

## `apps/web/src`

- `App.tsx`：认证状态和轻量浏览器路由。
- `components/Shell.tsx`：旧版风格的顶部栏、动画横向标签导航、页面切换和用户信息。
- `components/Ui.tsx`、`Toast.tsx`：可复用管理组件。
- `pages/AuthPage.tsx`：初始化与登录。
- `pages/DashboardPage.tsx`：运行概况。
- `pages/AiPage.tsx`：供应方、模型和连接测试。
- `pages/MembersPage.tsx`：成员和外部身份审批。
- `pages/ChannelsPage.tsx`：WeClaw 自动识别状态、Telegram 一步连接和其他
  Native Adapter 高级配置。
- `pages/ServicesPage.tsx`：媒体服务和 115 扫码登录。
- `pages/TasksPage.tsx`：任务进度。
- `pages/WatchlistsPage.tsx`：管理员查看和删除追更项。
- `pages/PromptsPage.tsx`：查看、编辑和恢复五类数据库提示词。
- `pages/PlaygroundPage.tsx`：管理员 Agent 测试。
- `styles/`：按中性设计令牌、顶部布局、基础组件和业务页面拆分的样式。

## `apps/telegram-adapter/src`

- `index.ts`：独立容器入口和退出处理。
- `config.ts`：进程参数、独立数据卷配置、环境变量兼容初始化和运行配置校验。
- `telegram.ts`：Telegram Bot API、消息发送和会话标识转换。
- `adapter.ts`：内部初始化接口、long polling、Native 入站事件和
  `/v1/messages` 出站服务。

系统仓库关系和通信方式分别记录在 `docs/system-repositories.md`、
`docs/communication.md`。复杂流程分别记录在 `docs/architecture.md`、`docs/ai-providers.md`、
`docs/prompts.md`、`docs/native-adapters.md`、`docs/openlist-jellyfin.md` 和
`docs/security.md`；字幕与追更见 `docs/subtitles-watchlists.md`，管理界面规范见
`docs/admin-ui.md`；115 重试和 Telegram 分别见
`docs/instant-offline-retry.md`、`docs/telegram-adapter.md`；自动下载目录见
`docs/media-download-paths.md`。

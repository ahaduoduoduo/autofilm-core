# Repository details

Updated: 2026-08-15

## 根目录

- `package.json`：npm workspace 命令。
- `tsconfig.base.json`：共享 TypeScript 严格配置。
- `Dockerfile`：在 GitHub Actions 中运行服务端测试，再构建共享类型、React
  前端和 Fastify 后端的单镜像。
- `Dockerfile.telegram`：构建独立 Telegram Adapter 镜像。
- `compose.yaml`：从 GHCR 运行 Core 与可选 Adapter/搜索服务。
- `compose.full.yaml`：从 GHCR 运行完整媒体系统；数据目录通过环境变量指定，
  可接管现有 OpenList/Jellyfin 持久化目录。备份系统由独立仓库部署。
- `compose.homeassistant.yaml`：以原容器名、host 网络和独立数据根目录重建
  Home Assistant。
- `compose.build.yaml`：历史调试参考；当前项目禁止使用它生成本地部署镜像。
- `.github/workflows/build-images.yml`：在 GitHub Actions 构建并发布五类 GHCR
  镜像，Jellyfin 同时提供公共版和个人版标签。
- `.env.example`、`.env.full.example`：单服务和完整编排参数模板。
- `docs/system-repositories.md`：六个源码仓库、上游、分支和修改边界。
- `docs/communication.md`：容器通信、认证方式和用户交互流程。
- `docs/persistence-layout.md`：生产容器的一级持久化根目录、容器路径和备份入口。

## `packages/contracts`

- `src/index.ts`：前后端共享枚举、管理对象和 WeClaw
  `2026-07-01` Native Message Service 类型。

## `apps/server/src`

- `index.ts`：进程入口，启动 Native 请求、任务进度、OpenList 鉴权、追更、Outbox
  和清理定时器。
- `app.ts`：组装数据库、服务、路由和静态前端。
- `config.ts`：环境变量校验和数据目录。
- `bootstrap.ts`：可选环境变量所有者与首个 AI 供应方初始化。
- `app-context.ts`：应用依赖类型。

### `ai`

- `types.ts`：渠道和供应方无关的消息、图片、工具与响应类型。
- `client.ts`：按协议选择 Adapter，并组合历史协议恢复与统一自动重试包装。
- `openai-responses.ts`：Responses 请求与函数调用映射。
- `openai-chat.ts`：Chat Completions 兼容映射。
- `anthropic.ts`：Anthropic Messages 映射。
- `gemini.ts`：Gemini GenerateContent 映射。
- `http.ts`：AI HTTP 错误、`Retry-After` 和可重试状态分类。
- `retry.ts`：临时供应方错误最多重试 3 次，使用响应头或带抖动的指数退避。
- `token-budget.ts`：跨协议 Token 保守估算、模型上下文策略和工具结果视图限制。

### `agent`

- `service.ts`：持久化会话、按会话顺序执行顶层请求、并行工具迭代、Token 阈值检查、
  TMDB 封面媒体生成、只读追更检查和管理员扫码工具。
- `runtime-context.ts`：每次主模型调用重新组合数据库系统提示词、当前时间和成员长期
  记忆。
- `context-compactor.ts`：单分块直接将旧检查点与移出近期 Token 尾部的消息合并；
  超大前缀使用最多 3 个并发的可恢复临时分块摘要，最后生成唯一正式检查点。
- `conversation-transcript.ts`：为分块上下文压缩生成受限会话片段。
- `conversation-queue.ts`：同一会话按提交顺序执行，不同会话互不等待。
- `catalog-poster.ts`：从本次 TMDB 搜索结果和最终回复中确定唯一条目，不猜测
  存在歧义的封面。
- `media-destination.ts`：使用媒体库根目录、TMDB 英文名和季号生成电影、单季及
  多季合集下载目录，并返回正确的 Jellyfin 刷新目标与 TMDB ID。
- `media-inventory.ts`：把 Jellyfin Movie 和 MediaSource 展开为实际版本，排除
  BoxSet 虚拟合集，统一识别裁切画面的 720p/1080p/1440p/2160p，并生成确定或
  疑似重复电影组。
- `tool-executor.ts`：并行执行同轮工具并按原调用顺序返回结果。
- `tools.ts`、`tool-types.ts`：工具组合入口和共享依赖。
- `toolsets/`：基础目录、下载/OpenList、字幕、Jellyfin 和追更工具。
- `toolsets/media-upgrades.ts`：为一个或多个现有 Jellyfin 条目创建稳定升级项，
  并发搜索候选、标记并拒绝相同发布资源、提交隔离下载、查询状态和执行确认后的
  旧版本恢复。
- `toolsets/media-upgrade-checks.ts`：一次接收大量 Jellyfin 电影版本并创建后台检查
  任务；读取结果时只分页返回存在目标分辨率资源的条目。
- `toolsets/user-memories.ts`：当前成员长期记忆的读取、新增、修改和明确删除工具。
- `toolsets/subtitle-placement.ts`：用文件 UUID 生成不可变字幕映射计划，校验摘要、
  重复使用和 Jellyfin 目标，并处理部分失败重试。
- `toolsets/subtitle-placement-executor.ts`：以最多 8 个工作协程并发执行字幕清理、
  流式上传和可选旧字幕删除；每个映射独立记录完成或失败状态。
- `toolsets/subtitle-processing.ts`：把用户观看后选中的一条或多条 OpenList 外挂字幕
  导入同一个工作区，批量执行大陆用词转换，按项重试并新增 `chs` 字幕；不返回字幕
  正文，也不删除源字幕。
- `prompt.ts`：可迁移的旧版 Agent 行为、当前远端媒体规则，以及各独立 AI
  上下文的默认提示词和版本。

### `api`

- `auth.ts`、`auth-routes.ts`：Cookie 会话、首次初始化和登录。
- `admin-routes.ts`：管理界面 API、服务测试和 OpenList 扫码代理。
- `native-routes.ts`：WeClaw 事件认证、去重和身份审批；有主动回传配置的成员请求写入
  后台队列并立即返回 `202`，缺少回传配置时保留同步兼容行为。

### `db`

- `database.ts`：SQLite WAL 和顺序迁移。
- `user-store.ts`：成员、会话和外部身份。
- `config-store.ts`：AI、模型、渠道和媒体服务配置。
- `conversation-store.ts`：保留全部原始消息，计算近期 Token 边界，并读取或写入唯一
  滚动压缩检查点；缓存不进入主模型视图的临时分块草稿，并在正式检查点保存或会话
  重置时删除；同时处理 Native 事件去重。
- `conversation-compaction.ts`：压缩检查点数据类型和替代消息格式。
- `task-store.ts`：任务生命周期。
- `media-upgrade-store.ts`：升级批次、逐条状态、候选、下载任务、替换路径、备份和
  恢复信息；对 Agent 返回的升级选择 ID 由工具层绑定升级项，内部候选 ID 不与普通
  Jackett 搜索共用。
- `agent/toolsets/media-upgrade-results.ts`：生成紧凑升级任务结果、媒体流摘要和绑定升级
  项的选择 ID；不向模型返回完整 Jellyfin 轨道或内部 Jackett 下载地址。
- `media-upgrade-check-store.ts`：批量画质检查任务、逐片状态、命中样例、统计和聊天
  通知状态；支持 Core 重启后继续未完成项目。
- `user-memory-store.ts`：按成员隔离的长期偏好、限制、资料和备注；生成受长度限制的
  系统上下文，不属于会话重置范围。
- `outbox-store.ts`：主动聊天通知和指数退避。
- `native-request-store.ts`：按 Native `event_id` 持久化待执行的消息与会话重置请求，
  原子领取任务，记录完成、失败和服务重启中断状态。
- `media-store.ts`：短期、限次读取的二维码和影片封面媒体。
- `watchlist-store.ts`：按成员隔离的追更和分集状态。
- `prompt-store.ts`：提示词初始化、读取、自定义和恢复默认值；系统升级只替换
  未自定义的旧版本。
- `conversation_compactions` 每个会话只保存一个滚动检查点。未压缩时模型读取全部
  原始消息；压缩后读取检查点与截止序号之后的近期原始消息。数据库迁移会删除旧主题
  表和额外用户原话字段。`conversation_compaction_chunks` 只保存未完成压缩的可恢复
  临时草稿，不进入主模型历史；正式检查点保存、会话重置或过期清理时删除。

### `integrations`、`tasks`、`channels`

- `integrations/openlist.ts`：通过受限 `/api/autofilm` API 处理离线下载、
  内存任务状态、受大小限制的字幕对象读取、精确对象移动、调度器和扫码会话，并读取
  电影/电视剧媒体库根目录配置。
- `integrations/openlist-path.ts`：在 `openlist:///` Jellyfin URI 与 OpenList 绝对路径
  之间进行严格转换。
- `integrations/jellyfin.ts`：使用 Jellyfin 12 标准鉴权处理媒体搜索、
  Movie/MediaSource 分页清单、BoxSet 成员媒体详情、`RemoteRefresh`、Movie/Episode
  精确删除、字幕读取
  和删除；所有字幕格式均以
  保留原始长度的二进制请求上传到 AutoFilm 流式端点，不生成 Base64 副本；
  请求体使用 Node 读取流，不复制大型图形字幕；资源升级使用 Inspect、Preview、
  Apply 和 Rollback 接口，并兼容 Jellyfin 两种 JSON 字段命名。
- `integrations/jackett.ts`：完整结果按文件大小降序、每页 20 条及短期查询缓存；
  对 Agent 隐藏 Jackett URL，选定候选后在最多 6 个并发槽中读取 torrent 并生成
  v1 magnet。
- `integrations/torrent-magnet.ts`：限制 torrent 响应大小、解析 bencode 原始
  `info` 字典、计算 SHA-1 infohash、保留 tracker，并拒绝115不支持的纯 v2 torrent。
- `integrations/tmdb.ts`：影片目录，同时兼容 Read Access Token 与 v3 API Key，
  并提供电影、剧集、季、单集的评分与简介、季集日期和受限大小的封面读取。
- `integrations/subhd.ts`：识别关联影片页并返回完整字幕列表、评论回复，以及按任务
  隔离且可并发执行的下载会话；统一限制请求开始间隔。
- `integrations/cookie-jar.ts`：管理单个 SubHD 下载会话的响应 Cookie，不在任务间
  共享状态。
- `integrations/weclaw-registration.ts`：读取同一 Compose 的 WeClaw 配置与登录账号，
  自动建立 Core 渠道记录且不向浏览器返回令牌。
- `tasks/progress-worker.ts`：每 2 秒读取 OpenList 内存任务状态，区分 OpenList
  本地排队与 115 provider 已接受状态，处理短时失败、远端任务删除和备用资源等待；
  只把 OpenList `StateSucceeded` 认定为完成，`StateCanceled` 和 `StateFailed`
  分别映射为取消和失败。超时后只发送
  备用资源选择提示，不自动提交。
  完成后优先使用云端最终结果路径精确刷新 Jellyfin，且该路径必须位于任务目标
  目录内；旧接口没有结果路径时才使用原有刷新目标，并保存重试状态。
- `tasks/openlist-provider-submission.ts`：下载工具等待 OpenList 返回 provider task ID；
  60 秒内未提交或出现明确失败时取消 OpenList 任务，并向 Agent 返回提交失败。
- `tasks/download-candidates.ts`：读取新旧任务的下载候选；新任务使用结构化
  candidateId、Jackett 标题和 magnet，Agent 读取任务时删除历史 Jackett URL、
  API Key、magnet 和尝试记录中的原始 URL。
- `tasks/completion-continuation.ts`：创建并校验下载完成后的持久化会话续接信息。
- `tasks/download-completion-worker.ts`：普通下载按工作流 ID 等待所有 OpenList 任务
  成功且 Jellyfin 导入完成；媒体升级按条目等待原 Jellyfin Item 替换完成。终态随后
  恢复原聊天会话，只执行此前已经约定的可选字幕等操作。
- `tasks/media-upgrade-worker.ts`：最多并行处理 4 个已下载升级项；逐项识别视频、
  拒绝分辨率下降、更新原 Jellyfin Item ID、自动检查条目路径和视频流，再移动旧文件
  并写入终态。带有会话续接信息的新任务由下载完成 Worker 调用 Agent；历史任务仍使用
  独立结果通知。
- `tasks/media-upgrade-files.ts`：视频流检查和可恢复的精确移动公共函数；能继续旧版
  改名后未移动的唯一中间文件，并复用相同发布判断；历史路径
  不存在时执行一层、唯一且受大小限制的分隔符差异匹配。
- `tasks/media-upgrade-check-worker.ts`：每批领取 8 个待检查电影，以标题和年份查询
  Jackett；只保存目标分辨率命中结果，完成后恢复原聊天并发送分页结果通知。
- `tasks/openlist-auth-worker.ts`：每分钟读取 OpenList 本地的 115 鉴权状态，不访问
  115；发现 HTTP 405 或凭据缺失状态时创建一个扫码会话，将同一张二维码向每个已配置
  渠道中的 owner/admin 身份发送，并在有效期内读取扫码状态以完成 Cookie 更新；
  同一次鉴权状态不重复发送。
- `tasks/watchlist-worker.ts`：按间隔读取 TMDB 并调用只读 Agent 检查追更条件。
- `tasks/native-request-worker.ts`：有限并发执行已接收的 Native 请求；同一会话由 Agent
  现有队列保持顺序，最终回复和状态更新在同一数据库事务中写入 Outbox。重启中断的
  请求只通知失败，不自动重放可能产生副作用的工具操作。
- `channels/outbound.ts`：向 Native Adapter 发送主动消息；Adapter 因缺少当前会话
  令牌返回 409 时延后投递，不消耗失败次数。
- `channels/agent-messages.ts`：把 Agent 最终文本中的 Core 临时媒体 URL 提取为
  Native 图片消息，并保留其余文字。

批量画质检查和成员长期记忆的状态边界见
`docs/bulk-upgrade-checks-and-user-memory.md`。

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
- `subtitle-document.ts`：ASS/SSA/SRT/VTT 的共享事件模型与序列化器；广告操作可删除
  完整事件，大陆用词操作只能替换解析出的中文汉字段，英文、标签、时间轴、标点、
  空格和换行不在可写范围内。
- `processor.ts`：顺序执行 `remove_ads`、`mainland_wording` 和 `ass_style` 的统一字幕
  操作入口，供下载放置、现有字幕处理和样式工具复用。
- `cleaner.ts`：通过共享字幕文档，对每个下载文本字幕使用独立 AI 请求分析全部事件；
  不做正则预筛选，请求失败时保留原字幕。
- `mainland-rewriter.ts`：每个现有字幕使用一次独立的完整文件请求，只接受有变化的事件
  ID、中文片段 ID 和纯汉字替换内容；不继承主对话、系统提示词、成员记忆或其他文件。
- `ass-style.ts`：旧版 ASS 样式分析、行内标签和黑边特效坐标处理。
- `hints.ts`：从解压相对路径推断集号、语言和 Jellyfin 语言标签；短语言代码只按
  完整文件名标记识别，避免作品名称中的普通字符被误判为语言。
- `workspace-store.ts`：一个任务累计多个 SubHD 字幕包、OpenList 现有字幕、验证码和
  逐项处理状态的成员级临时工作区；文件只使用 UUID，并保存不可变放置计划和处理
  结果；摘要按固定大小分块计算，SUP/PGS 可直接打开文件读取流。
- `references.ts`：为 Jellyfin 外挂字幕生成摘要引用，并在删除或替换前解析当前流。
- `types.ts`：字幕搜索、验证码、提取文件、来源类型、放置计划、处理项和临时工作区类型。

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
- `pages/PromptsPage.tsx`：查看、编辑和恢复七类数据库提示词。
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
`docs/prompts.md`、`docs/context-management.md`、`docs/native-adapters.md`、`docs/openlist-jellyfin.md` 和
`docs/security.md`；字幕与追更见 `docs/subtitles-watchlists.md`，管理界面规范见
`docs/admin-ui.md`；115 重试和 Telegram 分别见
`docs/instant-offline-retry.md`、`docs/telegram-adapter.md`；自动下载目录见
`docs/media-download-paths.md`；现有媒体升级见 `docs/media-upgrades.md`。

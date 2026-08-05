# System repositories and upstreams

Updated: 2026-08-06

AutoFilm 媒体系统由六个相邻源码仓库组成。`autofilm-core` 是业务入口和
Docker Compose 编排仓库，其余五个仓库保持独立 fork，便于继续跟踪上游更新。

## 仓库关系

| 目录 | GitHub 仓库 | 上游 | 当前功能分支 | 职责 |
| --- | --- | --- | --- | --- |
| `autofilm-core` | `ahaduoduoduo/autofilm-core` | 新建项目，无上游 | `agent/initial-core` | Agent、成员、AI、任务、管理界面和 Compose |
| `autofilm-openlist` | `ahaduoduoduo/autofilm-openlist` | `OpenListTeam/OpenList` | `feature/autofilm-remote-media` | 网盘文件、115、离线任务和 Jellyfin 专用路径接口 |
| `autofilm-openlist-frontend` | `ahaduoduoduo/autofilm-openlist-frontend` | `OpenListTeam/OpenList-Frontend` | `feature/autofilm-remote-media` | 115 风控/扫码界面和手动扫描菜单 |
| `autofilm-jellyfin` | `ahaduoduoduo/autofilm-jellyfin` | `jellyfin/jellyfin` | `master` | 远端媒体、播放、字幕、删除和资源替换 |
| `autofilm-jellyfin-web` | `ahaduoduoduo/autofilm-jellyfin-web` | `jellyfin/jellyfin-web` | `codex/autofilm-integrated-web` | OpenList 媒体库选择和远端目录扫描 |
| `autofilm-weclaw` | `ahaduoduoduo/weclaw` | `fastclaw-ai/weclaw` | `agent/generic-native-services` | 通用微信 Adapter、多 Agent 和联系人权限 |

OpenList、Jellyfin 和 Jellyfin Web fork 会保留上游创建的维护分支；上表只列出
AutoFilm 当前使用和继续开发的分支。Jellyfin 前后端的
`codex/personal-legacy-compat` 保留为迁移历史分支，不再作为开发或部署基线。

## 修改边界

### AutoFilm Core

Core 不 fork 旧 AutoFilm，而是重新实现仍有价值的业务能力：

- 多成员、角色、外部聊天身份审批与权限。
- AI 供应方和协议分离，支持 OpenAI Responses、Chat Completions、
  Anthropic Messages 和 Gemini GenerateContent。
- 数据库提示词、完整会话记录、Token 预算、本地上下文压缩和 Agent 工具调用。
- TMDB、Jackett、SubHD、OpenList、Jellyfin 的业务组合。
- 115 离线下载短时失败判断、备用资源人工选择、Jellyfin 导入及完成通知。
- 并行字幕下载、独立验证码会话、临时 workspace、AI 广告清理和批量字幕放置。
- 独立 Telegram Adapter 与 WeClaw Native Message Service。
- 固定深色管理界面和完整源码 Compose。

旧版软链接、rclone、Nginx 地址改写、定时目录同步和精准扫描插件不属于 Core。

### OpenList 后端与前端

后端增加：

- 只接受路径的受限 `/api/autofilm` 服务接口，不向 Core/Jellyfin 暴露
  Storage ID 或 Object ID。
- 文件读取、目录列举、上传、删除、目录创建、离线下载与内存任务状态。
- 115 每账户限速、扫码更新 Cookie、真实 HTTP 405 风控标记和恢复。
- 显式“扫描到 Jellyfin”操作及远端媒体库根目录校验。

前端增加：

- 115 Storage 页面显示被动风控状态并直接完成扫码。
- 文件夹右键菜单增加“扫描到 Jellyfin”。
- 执行前检查目录是否属于 Jellyfin 已配置的 OpenList 媒体库。

OpenList 不持久化文件变更事件，也不因普通上传、移动、重命名或删除自动修改
Jellyfin。

### Jellyfin 后端与前端

后端公共分支增加：

- `openlist:///` 媒体库路径、目录浏览和远端刷新。
- 远端媒体直接播放；Jellyfin 返回签名地址并跳转到 OpenList。
- 本地和远端外挂字幕的统一读取、上传、替换和删除。
- 本地 SUP/PGS Range 响应与远端字幕跳转。
- 删除远端条目时先删除 OpenList 文件，再删除 Jellyfin 数据库条目。
- 中文及其他非 ASCII 字符重定向地址处理。
- 不处理 OpenList 文件事件。

个人分支额外增加：

- 旧 Jellyfin 数据库路径迁移预览和执行。
- 旧软链接字幕反查、首次读取后延迟上传 OpenList。
- 旧字幕两边都不存在时删除失效的 Jellyfin 字幕记录。

Jellyfin Web 公共分支增加本地/OpenList 媒体库类型选择和远端目录浏览；个人分支
额外提供路径迁移界面。公开发行时可只构建公共分支。

### WeClaw

WeClaw 的修改不是 AutoFilm 专用微信补丁：

- 微信账号与 Native Agent 分离。
- 一个 WeClaw 实例可配置多个 Agent。
- 按联系人设置允许使用的 Agent。
- 双向服务令牌、结构化文本/图片消息和会话重置。
- 内置账号、二维码、联系人、Agent 和 Native Service 管理界面。

AutoFilm 只是一个 Native Agent。其他服务可以实现相同 HTTP 契约后接入。

## 外部服务

以下服务不是本项目 fork：

- TMDB：影片、季和分集元数据。
- Jackett：聚合 BT 索引器并返回完整搜索结果。
- FlareSolverr：由需要它的 Jackett 索引器调用，Core 不直接调用。
- SubHD：字幕搜索、详情和下载来源。
- 115：由 OpenList 驱动访问，Cookie 不进入 Core。
- AI 供应方：按配置的协议和地址调用；New API 只是可选兼容供应方。

## 上游更新原则

1. 新功能只在公开 Jellyfin 前后端分支开发；个人迁移分支只保留历史代码。
2. 合并上游前先比较上游是否已经提供同等能力，避免长期保留重复补丁。
3. OpenList 和 Jellyfin 之间只共享路径与受限服务令牌，不建立网盘对象 ID 映射。
4. Core 负责明确的业务操作，不恢复目录常驻同步。
5. Compose 构建固定使用当前仓库分支；升级上游后必须重新执行单元测试、镜像构建和
   真实播放/字幕验证。

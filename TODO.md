# AutoFilm Core development status

Updated: 2026-07-28

## 已完成（2026-07-28）

- [x] 建立独立 `ahaduoduoduo/autofilm-core` 仓库和 npm workspace。
- [x] 实现 SQLite 数据库、首次所有者初始化、会话认证和角色模型。
- [x] 实现 AI 供应方/协议分离和四种协议 Adapter。
- [x] 将 Responses 设为默认新协议，同时保留 Chat Completions。
- [x] 实现 TMDB、Jackett、OpenList、Jellyfin 基础 Agent 工具。
- [x] 实现 Native Message Service 入站认证、事件去重和成员默认拒绝。
- [x] 实现离线任务进度读取、持久化和带重试的聊天通知 Outbox。
- [x] 实现 OpenList 115 扫码登录界面和管理员聊天二维码发送工具。
- [x] 实现 AI、成员、身份、渠道、媒体服务、任务和 Agent 测试界面。
- [x] 提供 Core 单服务 Compose 和相邻源码完整 Compose。
- [x] 补充协议、架构、安全、部署和媒体交互文档。
- [x] 添加认证、协议 Adapter、Native 事件和任务进度测试。

## 未完成（记录于 2026-07-28）

- [ ] 将旧 Agent 的追更数据迁移为按成员隔离的 Core 追更表和定时任务。
- [ ] 将 SubHD 搜索、验证码、字幕清理和 OpenList 字幕上传改造成持久化任务。
- [ ] 补充 Jellyfin 海报选择、单集列表和详细媒体流工具。
- [ ] 为 Telegram 提供独立 Native Adapter 参考实现；Core 不内置 Telegram Bot。
- [ ] 增加 OpenList 凭据失效事件，使二维码无需管理员先发起对话即可主动发送。
- [ ] 增加管理操作审计事件查询界面。
- [ ] 增加 Playwright 前端端到端测试。
- [ ] 建立 GHCR 多架构镜像发布流程。
- [ ] 明确公开发布许可证。

## 已明确删除的旧职责

- [x] 软链接创建和维护。
- [x] rclone 挂载与重新挂载。
- [x] Nginx 视频和 SUP 字幕改写。
- [x] 定时目录同步与精准扫描插件调用。
- [x] 本地媒体目录删除工具。
- [x] Codex 登录作为 AI 供应方。

# Restic 异地备份

更新时间：2026-08-09

## 架构

Backrest 容器内置官方 Restic。Restic 使用 OpenList 的原生 REST 接口，把加密、分块、
去重后的仓库对象直接写入 115；运行路径不使用 WebDAV、S3 或 rclone。

```text
只读源目录 -> Backrest / Restic -> OpenList /restic/synology/ -> 115
```

OpenList 与 Backrest 镜像均由各自 GitHub Actions 的单一 `linux/amd64` 任务构建，
生产 Compose 使用提交哈希标签固定版本。

## 数据范围

Backrest 首页使用大号容量数字、分隔式指标、编号内容目录和背景曲线组织备份状态，
首先按计划显示“将备份”和“将跳过”，并可直接进入内容编辑。计划编辑器将已部署的
挂载目录转换为 Docker 服务、Home Assistant、DSM 证书、群晖恢复资料和 Time Machine
开关；日志缓存、Git 历史、旧传输缓存、Backrest 运行目录及在线数据库原文件分别显示。
原始 Restic 路径和 glob 规则位于“高级路径与规则”。手机端使用设备真实 viewport；
导航与内容编辑均覆盖完整视口，主要内容开关不显示技术路径。

自动计划 `nas-config` 包含：

- `/volume1/docker` 整个根目录中的 Compose、服务配置和持久化数据；
- `/volume1/web` 整个根目录中的 Web 项目、配置和数据；
- `/volume1/@appconf` 与 `/volume1/@appdata` 中的 DSM 套件配置，排除日志和 VMM
  活动 etcd 数据；
- DSM 证书目录；
- 每次备份前生成的 DSM、Docker、Backrest 和应用数据库恢复资料。

Docker 和 Web 使用根目录备份。以后在这两个目录下新增服务或项目，会自然进入下一次
备份，不需要增加服务名称、前端开关或 Restic 路径。在线数据库仍通过备份前一致副本
处理，避免读取写入过程中的数据库文件。`BACKUP_DOCKER_ROOT` 与 `BACKUP_WEB_ROOT`
可修改这两个根目录；容器内使用相同绝对路径，因此 Backrest 界面显示的就是宿主机路径。

Backrest 的快照前置命令通过 `/staging/control/requests` 请求主机刷新恢复资料；DSM
主机每分钟执行 `scripts/service-restic-staging-request.sh`，完成后写入对应结果文件，
Backrest 收到成功结果才开始扫描。定时备份和界面手动备份使用同一流程。
`scripts/configure-backrest.sh` 可重复应用仓库、认证、排除规则和两个计划。

计划排除日志、缓存、临时目录、`node_modules`、Git 对象、Jellyfin 缓存、旧传输缓存，
以及 macOS、DSM、Windows 生成的资源分叉、索引、缩略图和回收站目录。这些系统元数据
规则同时应用于 `nas-config` 与 `time-machine`。

OpenList、AutoFilm、Jellyfin、Subhub、LocalProxy、NAS Gateway Manager、AutoAccount、
Home Assistant 和 Backrest 的在线 SQLite 文件不直接读取，改为备份前通过 SQLite
在线备份 API 生成并校验的一致副本。Home Assistant 的 Recorder 历史、统计和日志簿
数据因此可以恢复；Backrest 的操作历史和任务记录也保存在恢复资料中。Jellyfin 只排除
正在使用的数据库及 WAL/SHM/Journal，`.bk`、`.old` 和迁移前副本继续作为普通文件备份。

恢复资料位于 `/staging/recovery`：

- `dsm/`：`dsm-config.dss`、版本、套件、用户/组、共享目录、ACL、网络、SMB、证书、
  反向代理、防火墙、计划任务、套件存储占用、VMM 状态和恢复顺序；
- `docker/`：容器完整 inspect、镜像 digest、网络、卷、原项目渲染 Compose、全部容器
  生成 Compose、无 Compose 容器生成 Compose 和跨 NAS 根目录变量；
- `databases/`：各应用、Home Assistant 和 Backrest 的一致 SQLite 副本、稳定恢复路径、
  校验结果及 `RESTORE.md`；
- `backrest/`：仓库和计划配置、会话签名密钥。配置文件包含仓库密码，只存在于加密
  Restic 仓库中。

`time-machine` 是独立手动计划。当前共享目录约 1.4 TB，且所在卷可用空间不足以长期
保留新的 Btrfs 快照，因此部署阶段不自动执行。它仍以本地 Time Machine 硬盘作为日常
恢复来源，115 仓库只承担异地灾难恢复。

## 流量与维护

OpenList 网关默认限制为 4 MiB/s、80 GiB/日、1500 GiB/月。计量位置是 115 OSS
实际上传读取器；秒传不计入外网上传量，重试按真实重传量计入。

达到上限时当前 Restic 任务失败退出，已上传对象继续有效。下一次任务扫描当前文件树，
复用已经进入仓库的分块，只上传仍缺失的内容。维护策略为每周结构检查、按日/月/年
保留历史；大范围数据读取和 prune 不与日常备份同时执行。

### Restic 元数据缓存

Backrest 将 Restic 缓存固定在容器内 `/cache`，并持久化到主机目录
`/volume1/docker/backrest/cache`。Restic 打开仓库时仍需
列出远端 `index/` 目录，但已有索引从本地缓存读取，只下载新增或本地缺失的索引文件；
容器更新和重建不会再次读取全部历史索引。

缓存不属于备份数据，也不包含恢复仓库所需的唯一信息，可以从 115 仓库重新生成。
`nas-config` 已排除整个 Backrest 运行目录，因此不会把缓存再次写入 Restic 仓库。
迁移或灾难恢复时可以一并复制该目录以减少首次读取；没有缓存的新主机首次打开仓库
仍需读取历史索引，必须在 115 请求频率受控时单独建立缓存。

仪表板每个计划提供“立即备份”。失败后再次点击会创建一次新的增量任务；仓库中已经
提交的数据继续复用，不会从上次进度字节位置续传未提交的临时对象。
重试成功后，年度备份日历按“当天已有可用备份”显示普通成功状态；任务卡片的 30 天
状态条显示绿色并增加橙色外圈，保留当天曾失败后恢复的信息。操作历史仍保留每次失败
与成功记录。手机端长错误通知限制在浏览器视口内，内容换行并可纵向滚动。

## 恢复

Backrest 可按快照浏览目录、搜索历史版本，并恢复单个文件或目录。跨 NAS 恢复时先恢复
Compose、环境文件、证书和持久化目录，再根据目标系统路径修改挂载。群晖目标同时使用
`dsm-config.dss` 与 AI 可读重建资料；飞牛等 Linux NAS 使用 Docker 生成 Compose、
路径变量和 DSM 事实清单迁移可复用的服务配置。

Restic 仓库密码当前复用 AutoFilm 的主密钥，OpenList REST 接口也由该密钥认证。
灾难恢复必须在 NAS 之外保存 `.env` 中的 `AUTOFILM_MASTER_KEY`；只有 115 仓库本身
无法还原该密钥。

## 入口

- Backrest：`http://10.0.1.7:9898`
- OpenList Restic：容器网络内 `http://openlist:5244/restic/synology/`
- Restic 可执行文件：Backrest 容器内 `/bin/restic`

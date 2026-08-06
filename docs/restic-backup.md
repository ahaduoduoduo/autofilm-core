# Restic 异地备份

更新时间：2026-08-06

## 架构

Backrest 容器内置官方 Restic。Restic 使用 OpenList 的原生 REST 接口，把加密、分块、
去重后的仓库对象直接写入 115；运行路径不使用 WebDAV、S3 或 rclone。

```text
只读源目录 -> Backrest / Restic -> OpenList /restic/synology/ -> 115
```

OpenList 与 Backrest 镜像均由各自 GitHub Actions 的单一 `linux/amd64` 任务构建，
生产 Compose 使用提交哈希标签固定版本。

## 数据范围

自动计划 `nas-config` 包含：

- `/volume1/docker` 中的 Compose、服务配置和持久化数据；
- `/volume1/web/HA` 中的 Home Assistant 配置；
- DSM 证书目录；
- 部署时导出的 DSM 配置与 OpenList SQLite 一致性副本。

主机端可执行 `scripts/prepare-restic-staging.sh` 刷新恢复材料；Backrest 的自动计划
在每次快照前重新生成 OpenList SQLite 副本。
`scripts/configure-backrest.sh` 可重复应用仓库、认证、排除规则和两个计划。

计划排除日志、缓存、临时目录、`node_modules`、Git 对象、Jellyfin 缓存、旧 rclone
缓存和 Home Assistant 运行日志。OpenList 的在线 SQLite 文件不直接读取，由计划前置
命令生成一致性副本。

`time-machine` 是独立手动计划。当前共享目录约 1.4 TB，且所在卷可用空间不足以长期
保留新的 Btrfs 快照，因此部署阶段不自动执行。它仍以本地 Time Machine 硬盘作为日常
恢复来源，115 仓库只承担异地灾难恢复。

## 流量与维护

OpenList 网关默认限制为 4 MiB/s、80 GiB/日、1500 GiB/月。计量位置是 115 OSS
实际上传读取器；秒传不计入外网上传量，重试按真实重传量计入。

达到上限时当前 Restic 任务失败退出，已上传对象继续有效。下一次任务扫描当前文件树，
复用已经进入仓库的分块，只上传仍缺失的内容。维护策略为每周结构检查、按日/月/年
保留历史；大范围数据读取和 prune 不与日常备份同时执行。

## 恢复

Backrest 可按快照浏览目录、搜索历史版本，并恢复单个文件或目录。跨 NAS 恢复时先恢复
Compose、环境文件、证书和持久化目录，再根据目标系统路径修改挂载。DSM 配置导出用于
恢复到另一台群晖；Docker 目录和恢复说明用于飞牛等 Linux NAS。

Restic 仓库密码当前复用 AutoFilm 的主密钥，OpenList REST 接口也由该密钥认证。
灾难恢复必须在 NAS 之外保存 `.env` 中的 `AUTOFILM_MASTER_KEY`；只有 115 仓库本身
无法还原该密钥。

## 入口

- Backrest：`http://10.0.1.7:9898`
- OpenList Restic：容器网络内 `http://openlist:5244/restic/synology/`
- Restic 可执行文件：Backrest 容器内 `/bin/restic`

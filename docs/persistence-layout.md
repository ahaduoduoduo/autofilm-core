# Docker 持久化目录

更新时间：2026-08-09

生产群晖使用一个服务一个一级根目录：

```text
/volume1/docker/<service>/
```

服务内部仍可按用途保留 `data`、`config`、`cache` 等子目录。源代码仓库、Docker
named volume、DSM Web 目录和容器运行数据不再互相嵌套。

## AutoFilm 服务

| 服务 | 宿主机目录 | 容器目录 |
| --- | --- | --- |
| AutoFilm Core | `/volume1/docker/autofilm-core` | `/data` |
| WeClaw | `/volume1/docker/weclaw` | `/root/.weclaw` |
| Telegram Adapter | `/volume1/docker/telegram-data` | `/data` |
| Home Assistant | `/volume1/docker/homeassistant` | `/config` |

Telegram Adapter 使用普通 bind mount，不再依赖 Docker named volume。Home Assistant
由 `compose.homeassistant.yaml` 保存完整运行定义，继续使用 host 网络、`always` 重启
策略和 `homeassistant` 容器名。

## 其他运行服务

OpenList、Jellyfin、Jackett、Subhub、Danmu API、NAS Gateway Manager、LocalProxy、
Xbox Speedup 和 Chijie 已经位于各自的 `/volume1/docker/<service>` 根目录。Live Proxy
代码仍位于 `/volume1/web/live`，频道运行数据位于 `/volume1/docker/live-proxy`。

媒体目录属于业务数据，不视为容器自身持久化目录。NAS 异地备份、Btrfs 快照、Time
Machine 和系统恢复资料由独立的 `ahaduoduoduo/nas-backup` 项目管理。

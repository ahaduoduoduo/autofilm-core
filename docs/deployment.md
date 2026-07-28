# Deployment

Updated: 2026-07-28

## 目录和权限

Core 容器以 UID `10001` 运行，`/data` 必须可写。数据目录包含 SQLite
数据库及 WAL 文件。

生成主密钥：

```bash
openssl rand -base64 32
```

OpenList/Jellyfin 服务令牌分别生成，不能复用：

```bash
openssl rand -base64 32
openssl rand -base64 32
```

## 单服务

`compose.yaml` 默认只要求 Core。WeClaw、Jackett 和 FlareSolverr
使用 Compose profile，适合连接已有 Jellyfin/OpenList。

```bash
docker compose up -d --build
docker compose --profile wechat --profile search up -d
```

## 完整源码构建

`compose.full.yaml` 使用相邻 fork 目录。Jellyfin 构建通过
`additional_contexts.autofilm_web` 编译修改版前端。

```bash
docker compose -f compose.full.yaml \
  --profile wechat \
  --profile search \
  up -d --build
```

默认端口：

- Core：`3100`
- OpenList：`15244`
- Jellyfin：`18096`

绑定域名后修改 `AUTOFILM_PUBLIC_URL` 和 `OPENLIST_PUBLIC_URL`。
Jellyfin 返回给播放客户端的是后者，所以必须是 Infuse 能访问的地址。

## 备份

停止 Core 后备份 `data/core`。在线备份应使用 SQLite backup API，
不要只复制主数据库文件而遗漏 WAL。

OpenList 和 Jellyfin 数据目录独立备份。Core 数据库不替代它们。

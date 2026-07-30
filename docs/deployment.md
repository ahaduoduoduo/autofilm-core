# Deployment

Updated: 2026-07-30

## 目录和权限

Core 容器以 UID `10001` 运行，`/data` 必须可写。数据目录包含 SQLite
数据库、WAL 文件和字幕临时目录。镜像包含 `p7zip-full`，用于解压
ZIP、RAR 和 7z 字幕包。

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

`compose.yaml` 默认启动 Core 和未配置的 Telegram Adapter。WeClaw、Jackett 和 FlareSolverr
使用 Compose profile，适合连接已有 Jellyfin/OpenList。

```bash
docker compose up -d --build
docker compose --profile wechat --profile search up -d
```

WeClaw 数据保存在 `weclaw/` 并挂载为容器内的 `/root/.weclaw`。容器使用
`start --foreground`；首次启动没有微信凭据时，会在容器日志中显示扫码地址并
等待登录。

同一目录以只读方式挂载到 Core 的 `/weclaw`。Core 每五秒读取本地账号文件；
扫码成功后会自动使用实际 Bot ID 和现有双向令牌建立渠道记录。令牌不经过浏览器，
管理界面不需要填写容器地址或复制 JSON。Core 只加入容器内的 root 补充组，
用于读取 WeClaw 保存为 `0640` 的配置文件；服务进程仍以非 root 用户运行。

Telegram 容器只在内部网络监听 `18012`，不映射宿主机端口。Bot Token
在管理界面填写，并保存在独立 `telegram-data` 数据卷。无界面部署仍可使用
`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CORE_TOKEN` 和
`TELEGRAM_OUTBOUND_TOKEN` 环境变量。

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

同一 Compose 网络内的服务调用使用 Docker DNS，不填写群晖局域网 IP：

- Core → OpenList：`http://openlist:5244`
- Core → Jellyfin：`http://jellyfin:8096`
- Core → Jackett：`http://jackett:9117`
- Core → WeClaw：`http://weclaw:18011`
- Core → Telegram Adapter：`http://telegram-adapter:18012`

宿主机 IP 或域名只用于浏览器、Infuse 等容器外客户端可访问的公开地址。
健康检查中的 `127.0.0.1` 是容器检查自身，不属于容器间通信。

绑定域名后修改 `AUTOFILM_PUBLIC_URL` 和 `OPENLIST_PUBLIC_URL`。
Jellyfin 返回给播放客户端的是后者，所以必须是 Infuse 能访问的地址。

## 备份

停止 Core 后备份 `data/core`。在线备份应使用 SQLite backup API，
不要只复制主数据库文件而遗漏 WAL。

OpenList 和 Jellyfin 数据目录独立备份。Core 数据库不替代它们。
`data/tmp/subtitles` 不需要备份。

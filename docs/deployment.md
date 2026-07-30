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

### 现有数据目录

完整编排不会假定固定的群晖目录。以下变量用于接管现有 OpenList/Jellyfin 数据：

- `OPENLIST_DATA_DIR`：OpenList 持久化目录，挂载到 `/opt/openlist/data`。
- `JELLYFIN_CONFIG_DIR`：Jellyfin 配置和数据库目录，挂载到 `/config`。
- `JELLYFIN_CACHE_DIR`：Jellyfin 缓存目录，挂载到 `/cache`。
- `JELLYFIN_MEDIA_DIR`：旧本地媒体根目录，挂载到 `/movie`。
- `JELLYFIN_LEGACY_SUBTITLE_DIR`：旧软链接树，按只读方式挂载到
  `/legacy-subtitles`，只用于字幕首次读取时的延迟迁移。

`JELLYFIN_MEDIA_DIR` 保留本地媒体库和未迁移记录的读取能力。
`JELLYFIN_LEGACY_SUBTITLE_DIR` 不参与视频播放，也不是独立整理出的字幕目录；
它就是旧视频软链接与外挂字幕原来共同所在的目录。

### 接管已有部署

在本机 `.env` 中填写现有数据目录、宿主机端口和公开地址。`.env` 不进入版本库，
避免公开个人域名、目录和服务凭据。已有 Jackett 和 FlareSolverr 可以继续作为
外部服务使用，此时不启用完整编排中的 `search` profile。

旧 AList 数据目录由 UID `1001` 的 OpenList 进程写入。接管旧目录时需要保证该
UID 拥有读写权限。Jellyfin 旧数据库首次由 v12 启动时会执行数据库升级，
应等待升级完成后再访问媒体库。

路径迁移会将旧媒体条目、外挂字幕和媒体库根目录改为 `openlist:///`。迁移后应再次
执行预检，结果必须为 0 个待处理项。旧外挂字幕不会批量上传，首次播放字幕时先从
`/legacy-subtitles` 返回，再由单并发后台任务上传到 OpenList；后续请求直接返回
OpenList 302 地址。

## 备份

停止 Core 后备份 `data`。在线备份应使用 SQLite backup API，
不要只复制主数据库文件而遗漏 WAL。

OpenList 和 Jellyfin 数据目录独立备份。Core 数据库不替代它们。
`data/tmp/subtitles` 不需要备份。

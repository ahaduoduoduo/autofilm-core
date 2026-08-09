# Deployment

Updated: 2026-08-09

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
docker compose pull
docker compose up -d
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
在管理界面填写，并保存在 `TELEGRAM_DATA_DIR` 指定的 bind mount。无界面部署仍可使用
`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CORE_TOKEN` 和
`TELEGRAM_OUTBOUND_TOKEN` 环境变量。

## GitHub Actions 和 GHCR

`.github/workflows/build-images.yml` 使用仓库 `GITHUB_TOKEN` 登录 GHCR，
不需要保存个人访问令牌。工作流发布：

| 镜像 | 标签 | 来源 |
| --- | --- | --- |
| `ghcr.io/ahaduoduoduo/autofilm-core` | `latest`、`build-N` | Core 当前工作流提交 |
| `ghcr.io/ahaduoduoduo/autofilm-telegram-adapter` | `latest`、`build-N` | Core 当前工作流提交 |
| `ghcr.io/ahaduoduoduo/autofilm-openlist` | `latest`、`build-N` | OpenList 后端和前端指定分支 |
| `ghcr.io/ahaduoduoduo/autofilm-jellyfin` | `latest`、`public-build-N` | Jellyfin 公共分支 |
| `ghcr.io/ahaduoduoduo/autofilm-jellyfin` | `personal`、`personal-build-N` | Jellyfin 个人迁移分支 |
| `ghcr.io/ahaduoduoduo/weclaw` | `latest`、`build-N` | WeClaw 指定分支 |

推送 Core 的应用、Dockerfile 或工作流变更时，Actions 自动构建 Core 和 Telegram。
其他镜像使用 Actions 页面的 `Build container images` 手动任务，可选择组件和每个
fork 的 ref。选择 `all` 会并行构建全部镜像，包括 Jellyfin 公共版和个人版。

命令行触发完整构建：

```bash
gh workflow run build-images.yml \
  --repo ahaduoduoduo/autofilm-core \
  --ref main \
  -f component=all
```

工作流当前发布 `linux/amd64`，与本项目群晖部署一致。镜像由公开仓库 Actions
创建并关联到仓库，保持公开拉取权限。

完整系统镜像只在 GitHub Actions 构建。群晖生产主机只执行 `docker compose pull`
和 `docker compose up -d`，不运行完整系统的 `docker compose build`，避免编译过程
占用媒体服务所需的 CPU、内存和存储空间。

## 完整系统部署

`compose.full.yaml` 默认只拉取 GHCR 镜像。正式部署不需要另外五个源码仓库：

```text
autofilm-core/
├── compose.full.yaml
├── .env
├── data/
└── weclaw/
```

首次部署：

```bash
cd autofilm-suite/autofilm-core
cp .env.full.example .env
# 填写随机令牌、公开地址和持久化目录
docker compose -f compose.full.yaml config
docker compose -f compose.full.yaml \
  --profile wechat \
  pull
docker compose -f compose.full.yaml \
  --profile wechat \
  up -d
docker compose -f compose.full.yaml ps
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

### Compose 服务和 profile

| 服务 | 默认状态 | 宿主机端口 | 数据 |
| --- | --- | --- | --- |
| `autofilm-core` | 启动 | `AUTOFILM_PORT` → `3100` | `AUTOFILM_CORE_DATA_DIR` |
| `openlist` | 启动 | `OPENLIST_PORT` → `5244` | `OPENLIST_DATA_DIR` |
| `jellyfin` | 启动 | `JELLYFIN_PORT` → `8096` | Jellyfin 配置、缓存和媒体目录 |
| `telegram-adapter` | 启动 | 不发布 | `TELEGRAM_DATA_DIR` |
| `weclaw` | `wechat` profile | `WECLAW_PORT` → `18011` | `WECLAW_DATA_DIR` |
| `jackett` | `search` profile | 默认不发布 | `JACKETT_CONFIG_DIR` |
| `flaresolverr` | `search` profile | 默认不发布 | 无业务数据库 |

已有 Jackett/FlareSolverr 时不启用 `search` profile，在 Core 管理界面配置现有
Jackett 地址。FlareSolverr 仍由 Jackett 自己使用。

### 主要环境变量

| 变量 | 含义 |
| --- | --- |
| `AUTOFILM_PUBLIC_URL` | 浏览器和 Adapter 可访问的 Core 地址 |
| `OPENLIST_PUBLIC_URL` | Infuse 可访问的 OpenList 地址，用于 Jellyfin 302 |
| `AUTOFILM_MASTER_KEY` | Core 数据库中敏感配置的加密主密钥 |
| `OPENLIST_JELLYFIN_TOKEN` | OpenList 与 Jellyfin 受限服务令牌 |
| `JELLYFIN_API_KEY` | Core/OpenList 调用 Jellyfin 的 API Key |
| `AUTOFILM_CORE_DATA_DIR` | Core 数据库、WAL 和运行数据目录 |
| `BACKREST_ROOT_DIR` | Backrest 的 data、config、cache 和 staging 根目录 |
| `WECLAW_DATA_DIR` | WeClaw 登录状态和配置目录 |
| `TELEGRAM_DATA_DIR` | Telegram Adapter 的 Bot 配置和 Update offset 目录 |
| `HOMEASSISTANT_DATA_DIR` | Home Assistant 配置和持久化数据目录 |
| `OPENLIST_DATA_DIR` | OpenList 持久化目录 |
| `JELLYFIN_CONFIG_DIR` | Jellyfin 配置和数据库目录 |
| `JELLYFIN_CACHE_DIR` | Jellyfin 缓存目录 |
| `JELLYFIN_MEDIA_DIR` | 本地媒体根目录 |
| `JACKETT_CONFIG_DIR` | Jackett 配置目录 |

`.env`、数据库、Cookie、扫码状态和真实服务密钥不能加入 Git。

### 镜像变量

生产标签可通过 `.env` 替换为某次不可变构建标签或 digest：

| 变量 | 默认值 |
| --- | --- |
| `AUTOFILM_CORE_IMAGE` | `ghcr.io/ahaduoduoduo/autofilm-core:latest` |
| `AUTOFILM_TELEGRAM_IMAGE` | `ghcr.io/ahaduoduoduo/autofilm-telegram-adapter:latest` |
| `AUTOFILM_OPENLIST_IMAGE` | `ghcr.io/ahaduoduoduo/autofilm-openlist-restic:sha-52dc6110e0c9b4e9b2de8347a5aa602bf701e388` |
| `AUTOFILM_JELLYFIN_IMAGE` | `ghcr.io/ahaduoduoduo/autofilm-jellyfin:latest` |
| `AUTOFILM_WECLAW_IMAGE` | `ghcr.io/ahaduoduoduo/weclaw:latest` |

完整编排默认使用公共分支镜像。`personal` 标签只保留用于历史数据库迁移，不再用于
当前正式部署。

## 本地开发检查

正式部署不执行本地镜像编译。开发阶段只运行当前组件的类型检查、单元测试或目标构建；
需要验证容器产物时触发 GitHub Actions 的对应组件任务，不在群晖上构建完整系统。
`compose.build.yaml` 仅保留为其他开发主机的调试参考，不用于本项目的生产更新。

## 单仓库编译参考

下面命令只用于开发检查和定位单个镜像问题。

### Core 和 Telegram Adapter

```bash
cd autofilm-core
npm ci
npm run typecheck
npm test
npm run build
docker build -t autofilm-core:local .
docker build -f Dockerfile.telegram -t autofilm-telegram-adapter:local .
```

### OpenList 前端和组合镜像

```bash
cd autofilm-openlist-frontend
corepack enable
pnpm install --frozen-lockfile
pnpm run lint
pnpm run build

cd ..
docker build \
  -f autofilm-openlist/Dockerfile.autofilm \
  --build-context autofilm_frontend=./autofilm-openlist-frontend \
  -t autofilm-openlist:local \
  ./autofilm-openlist
```

组合镜像使用 Go 1.26 和 Node 24 构建，并把前端 `dist` 放入 OpenList 可执行文件
使用的静态资源目录。

### Jellyfin Web 和组合镜像

```bash
cd autofilm-jellyfin-web
npm ci
npm run build:check
npm test
npm run build:production

cd ..
docker build \
  -f autofilm-jellyfin/Dockerfile.autofilm \
  --build-context autofilm_web=./autofilm-jellyfin-web \
  --build-arg TARGET_RUNTIME=linux-x64 \
  -t autofilm-jellyfin:local \
  ./autofilm-jellyfin
```

组合镜像使用 .NET 10 自包含发布，并把修改版 Jellyfin Web 复制到最终镜像。
其他 CPU 架构需要把 `TARGET_RUNTIME` 改为对应 .NET Runtime Identifier。

### WeClaw

```bash
cd autofilm-weclaw
go test ./...
go build -o weclaw .
docker build -t autofilm-weclaw:local .
```

## 升级与重新部署

```bash
cd autofilm-suite/autofilm-core
docker compose -f compose.full.yaml config
docker compose -f compose.full.yaml --profile wechat pull
docker compose -f compose.full.yaml --profile wechat up -d
docker compose -f compose.full.yaml ps
```

不使用的 `search` profile 不应在升级命令中加入。只需要替换某个服务时可使用：

```bash
docker compose -f compose.full.yaml pull jellyfin
docker compose -f compose.full.yaml up -d jellyfin
```

更新 Jellyfin/OpenList 前必须分别备份它们的持久化目录。更新 Core 前备份
Core SQLite；仅复制主数据库而遗漏 WAL 不是有效在线备份。

### 现有数据目录

完整编排不会假定固定的群晖目录。以下变量用于接管现有 OpenList/Jellyfin 数据：

- `OPENLIST_DATA_DIR`：OpenList 持久化目录，挂载到 `/opt/openlist/data`。
- `JELLYFIN_CONFIG_DIR`：Jellyfin 配置和数据库目录，挂载到 `/config`。
- `JELLYFIN_CACHE_DIR`：Jellyfin 缓存目录，挂载到 `/cache`。
- `JELLYFIN_MEDIA_DIR`：本地媒体根目录，挂载到 `/movie`。
`JELLYFIN_MEDIA_DIR` 用于常规本地媒体库；OpenList 媒体不依赖该挂载。

### 接管已有部署

在本机 `.env` 中填写现有数据目录、宿主机端口和公开地址。`.env` 不进入版本库，
避免公开个人域名、目录和服务凭据。已有 Jackett 和 FlareSolverr 可以继续作为
外部服务使用，此时不启用完整编排中的 `search` profile。

旧 AList 数据目录由 UID `1001` 的 OpenList 进程写入。接管旧目录时需要保证该
UID 拥有读写权限。Jellyfin 旧数据库首次由 v12 启动时会执行数据库升级，
应等待升级完成后再访问媒体库。

## 备份

停止 Core 后备份 `data`。在线备份应使用 SQLite backup API，
不要只复制主数据库文件而遗漏 WAL。

OpenList 和 Jellyfin 数据目录独立备份。Core 数据库不替代它们。
`data/tmp/subtitles` 不需要备份。

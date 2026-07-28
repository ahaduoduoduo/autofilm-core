# Security model

Updated: 2026-07-28

## 首次启动

未配置环境变量账号时，只有数据库中没有任何用户才开放 `POST /api/setup`。
首个账号固定为所有者。密码至少 12 个字符，使用带随机盐的 scrypt 保存。

管理会话使用随机 HttpOnly、SameSite=Lax Cookie。生产域名使用 HTTPS
时 Cookie 自动启用 Secure。

最后一个正常所有者不能被降级或停用；管理员不能创建或修改所有者。

## 凭据

AI 密钥、附加请求头、Adapter 出站令牌和媒体服务凭据使用
`AUTOFILM_MASTER_KEY` 加密。主密钥不写入数据库。

更换主密钥前必须重新保存所有秘密字段；直接更换会使旧密文无法解密。

OpenList 的 115 Cookie 不属于 Core 凭据。Core 只持有 OpenList
管理员 Token 和独立 Jellyfin/OpenList 服务令牌。

## 网络

- Core、WeClaw、OpenList 和 Jellyfin 应放在私有 Docker 网络。
- 只向局域网或反向代理开放必要端口。
- WeClaw 旧 `/api/send` 为兼容接口，不应用于 Core。
- Native 双向请求使用两组不同的随机令牌。
- `AUTOFILM_MEDIA_BASE_URL` 只需要 Adapter 可访问，不必暴露公网。

临时二维码 URL 使用 256 位随机 Token、有效期和读取次数限制，并返回
`Cache-Control: no-store`。

## 外部影响

下载工具只有在用户明确要求后调用。普通成员看不到 OpenList
重新认证工具。Jellyfin 远端刷新只接受不含 `..` 的 OpenList 绝对路径。

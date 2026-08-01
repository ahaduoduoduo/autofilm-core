# 现有媒体资源升级

Updated: 2026-08-01

## 目标

资源升级用于把 Jellyfin 中已经存在的一部电影或一个单集换成更高质量的文件，同时
保持原 Jellyfin Item ID。它不是新增媒体，也不使用普通 `RemoteRefresh`。

保持不变的数据包括：

- Item ID、TMDB/IMDb 等 Provider ID；
- 标题、简介、图片和人工编辑的元数据；
- 用户播放进度、已看状态、收藏和个人数据；
- 已有外挂字幕流。新视频媒体流由 Jellyfin 的实际探测结果替换。

当前只接受 `openlist:///` Movie 和 Episode。Series、Season、本地媒体和普通 HTTP
媒体不属于该功能范围。

## Agent 工具

1. `search_media_upgrade_candidates`
   - 一次接收 1 到 8 个现有 Jellyfin Movie/Episode ID。
   - 每个目标生成不可变 `upgrade_item_id`。
   - Jackett 查询最多 4 项并发，结果继续按大小从大到小保存。
   - 每个资源生成与该升级项绑定的 `upgrade_selection_id`；普通资源搜索返回的
     `candidateId` 无法用于升级，Agent 也不读取下载入口。
2. `start_media_upgrades`
   - 每项只接受同一个 `upgrade_item_id` 返回的 `upgrade_selection_id` 和
     `fallback_upgrade_selection_ids`，不接受普通搜索 ID 或数字序号。
   - Core 选中候选后才读取 Jackett 的 torrent 下载入口；`.torrent` 在内网转换为
     BitTorrent v1 magnet，已有 magnet 也会重新校验并用 Jackett 标题替换 `dn`。
   - OpenList 只接收通过校验的 magnet，不接收 Jackett URL。
   - 候选发布名与当前文件发布名相同，且总大小只存在字幕等小型附属文件差异时，
     标记 `sameAsCurrent=true` 并拒绝提交，避免把同一视频再次当作升级资源。
   - 最多 4 项并发提交 OpenList 离线下载。
   - 一项提交失败不会停止其他项。
3. `get_media_upgrade_job`
   - 返回批次内每项独立状态、下载任务、新文件、旧文件备份和错误。
4. `rollback_media_upgrades`
   - 仅在用户明确确认恢复后调用。
   - 先把旧文件恢复到原目录，再把同一个 Jellyfin Item ID 改回旧文件。
   - 刚替换的新文件随后进入该升级项的备份目录。

## 隔离和并发

每个升级项使用自己的目录：

```text
/115/autofilm-staging/upgrades/<upgrade-item-id>
```

下载任务的元数据同时保存 `jobId`、`upgradeItemId` 和 `jellyfinItemId`。候选选择、
OpenList 任务、结果路径和 Jellyfin 目标不依赖数组位置或完成顺序，因此两个同时完成的
文件不会交叉使用。

Jackett 查询和 OpenList 下载最多 4 项并发。后台替换最多处理 4 项；Jellyfin 服务器
内部将 ffprobe 限制为 2 项并发。A 下载完成后立即处理 A，不等待 B。B 超时等待备用
资源、失败或放弃时，不改变 A 的状态。

下载任务保存结构化候选的 ID、Jackett 标题和已解析 magnet。成员看到的资源名称始终
来自 Jackett `Title`；Core 不从 magnet `dn` 推断展示名称，也不向 Agent 返回 Jackett
API Key、内网下载 URL 或 magnet。普通搜索候选的内存有效期为 30 分钟，过期后必须
重新搜索。

升级选择 ID 本身包含升级项身份。即使两个搜索结果指向同一 Jackett 资源，它们也不能
跨升级项互换。升级候选保存在 SQLite 中，不使用普通搜索的 30 分钟内存缓存；读取旧的
未完成升级任务时，Core 会根据已保存候选重新生成当前格式的选择 ID，无需迁移数据库。

## 下载完成判定

升级继续复用普通任务进度 Worker，只把 OpenList `StateSucceeded` 视为下载完成。
`result_path` 必须存在，升级任务才进入文件识别阶段。

升级任务带有 `mediaUpgrade` 元数据，进度 Worker 因此不会：

- 调用 `RemoteRefresh`；
- 创建第二个 Jellyfin 条目；
- 恢复普通下载的字幕后续事件。

40 秒的 115 秒传规则保持不变。超时后任务进入 `awaiting_alternative`，用户选择保存的
备用候选后，复用同一个升级项和临时目录。

## 识别与替换

每个成功下载项按以下顺序处理：

1. Jellyfin `MediaReplacement/Inspect` 使用自身 `VideoResolver` 和
   `EpisodeResolver` 读取结果目录；电影选择非附加视频中的主文件，单集还必须匹配
   原季号和集号。
2. Core 精确读取 Jellyfin 记录中的旧视频路径。该路径因历史迁移而不存在时，只列举
   其直接上级目录，并把空格、点号、下划线和连字符视为等价分隔符。目录和视频都必须
   唯一匹配，扩展名必须一致，文件大小误差不得超过 1 MiB；否则停止处理。
3. 文件移动到解析后的真实旧视频目录，并使用包含升级项短 ID 的唯一名称，避免覆盖
   旧文件。OpenList 先按原名移动，再在目标目录改名，避免 115 在改名后暂时查询不到
   新对象，并在改名前最多等待 7 秒确认移动后的对象已由供应方返回。旧实现留下
   “已改名但尚未移动”，或新实现留下“已移动但尚未改名”的文件时，Core 只有在原
   路径不存在、中间路径唯一且大小匹配时才继续操作。真实旧路径保存到升级项，不修改
   其他 Jellyfin 条目。
4. `MediaReplacement/Preview` 通过 Jellyfin 的 `IMediaEncoder` 对 OpenList 内部
   下载地址执行 ffprobe，返回当前和新文件的真实宽高及媒体流。远端读取造成
   `FfmpegException` 时最多执行 3 次，总延迟为 11 秒；其他异常不重试。
5. Core 在实际视频文件识别后再次比较发布名与视频字节数，拒绝相同视频；同时拒绝
   像素数低于原文件的结果。同分辨率仍允许编码、HDR、码率或音轨升级。
6. `MediaReplacement/Apply` 在单条目锁内重新核对原路径、新文件大小和修改时间，
   保存新媒体流并更新原 Video 记录。它不创建条目、不运行元数据供应方、不更新图片。
7. Core 再读取相同 Item ID，检查路径和视频流。检查通过即标记 `succeeded`。
8. 旧文件从解析后的真实路径移动到：

```text
/115/autofilm-backups/upgrades/<upgrade-item-id>
```

服务在“成功已记录、旧文件尚未移动”之间重启时，SQLite 中
`state=succeeded, backup_path=NULL` 的项目会继续执行旧文件移动。移动请求响应丢失时，
Core 同时核对源路径和目标路径，只有源已消失且目标存在才认定成功。

旧文件移动失败不会撤销已经工作的新版；状态改为
`succeeded_with_backup_error` 并保留具体错误。备份当前没有自动删除期限。

## 失败边界

- 下载失败：只影响对应升级项。
- 下载内容没有可识别视频：不修改 Jellyfin。
- 单集季集号不匹配：不修改 Jellyfin。
- 历史旧路径没有唯一的分隔符等价项：不移动文件、不修改 Jellyfin，下载结果继续保留
  在升级临时目录。
- 新文件分辨率下降：新文件移回该任务临时目录，原条目继续使用旧文件。
- 新旧文件属于相同发布且大小相同：停止替换，下载结果保留在升级临时目录。
- Apply 写入失败：Jellyfin 服务恢复原媒体流和条目字段。
- Apply 响应丢失：Core 读取原 Item ID；新路径和视频流已经存在时继续成功处理。
- 自动检查失败且存在短期回退令牌：Jellyfin 恢复原快照。

升级成功不要求用户手工试播。自动检查的范围是 Item ID、OpenList URI 和 Jellyfin
视频流记录；OpenList 的实际客户端播放仍使用现有 302 直播放实现。

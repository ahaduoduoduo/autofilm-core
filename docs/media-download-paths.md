# 媒体下载目录

Updated: 2026-07-29

## 目标

Agent 负责判断资源内容，Core 负责生成目录。下载工具不接受任意
`destination`，避免模型把多季合集放进单季目录，或者为同一剧集生成不同名称。

OpenList 服务配置保存两个根目录：

- `movieLibraryRoot`：默认 `/115/nvideo/movie`。
- `tvLibraryRoot`：默认 `/115/nvideo/tv`。

两个值必须是安全的 OpenList 绝对路径。管理界面位于“媒体服务 → OpenList”。

## 结构化参数

下载工具要求：

- `media_type`：`movie` 或 `tv`。
- `tmdb_id`：`search_catalog` 返回的真实 TMDB ID。
- `seasons`：电影使用空数组；电视剧使用资源实际包含的全部季号。

Core 使用 TMDB 英文标题生成稳定目录名。模型不能传入最终目录。

## 目录规则

电影继续按提交月份归档：

```text
<movieLibraryRoot>/2026-07
```

电视剧单季进入季目录：

```text
<tvLibraryRoot>/The.Example.Show/S03
```

多季合集进入剧集根目录：

```text
<tvLibraryRoot>/The.Example.Show
```

例如 `S01-S03` 必须传 `seasons=[1,2,3]`。Core 根据数组长度选择目录，
不使用可能与季号冲突的 `is_collection` 布尔值。

## Jellyfin 刷新

电视剧无论下载单季还是多季合集，都刷新剧集根目录并携带 TMDB ID 及
`provider_target=series`。这样
`RemoteRefresh` 将 Provider ID 应用于 Series，而不是 Season。

电影下载目标是月份目录，实际资源文件名或种子根目录只有下载完成后才确定，
因此自动刷新月份目录并让 Jellyfin 使用正常文件名匹配，不把电影 TMDB ID
错误写到月份 Folder。

任务元数据同时保存：

- 实际下载目录 `destination`。
- Jellyfin 刷新目录 `jellyfinRefreshPath`。
- 可安全应用的 `jellyfinProviderIds`。
- 媒体类型、TMDB ID、标题、季号和是否为多季合集；Worker 根据媒体类型发送
  Jellyfin 的 Movie 或 Series 目标。

## 失败条件

Core 拒绝以下参数：

- 无效或非正整数 TMDB ID。
- 电视剧没有季号。
- 电影包含季号。
- 重复季号。
- 小于 0 或大于 999 的季号。
- TMDB 返回的媒体类型与工具参数不一致。

路径计算测试覆盖电影、单季、多季合集、错误参数和不可用标题；下载工具测试
同时检查模型无法提交 `destination`。

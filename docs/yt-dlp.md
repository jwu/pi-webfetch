# yt-dlp 抓取逻辑

本文记录 `webfetch` 在 YouTube URL 上使用 `yt-dlp` 的抓取流程。

## 适用范围

当 URL 域名是以下之一时，会走 `yt-dlp`：

- `youtube.com`
- `www.youtube.com`
- `m.youtube.com`
- `music.youtube.com`
- `youtu.be`
- `youtube-nocookie.com`

YouTube URL 不走 Scrapling，也不使用 Defuddle。

## URL 规范化

执行前会先规范化 URL：

- 去掉首尾空白
- 校验 URL 是否有效
- 只允许 `http:` 和 `https:`
- 去掉 fragment/hash

## mode 处理

`yt-dlp` 路由支持：

| 请求 mode | 实际结果 mode | 说明 |
|---|---|---|
| `markdown` | `markdown` | 默认，返回可读摘要 |
| `text` | `text` | 当前内容格式与 markdown 相同，但 mode 标记为 text |
| `html` | `markdown` | YouTube 路由不返回 HTML，退化为 markdown |
| `json` | `json` | 返回精简稳定 JSON |

`json` mode 只支持 YouTube / `yt-dlp` 路由。其他路由请求 `json` 会失败。

## URL 类型判断

`yt-dlp` 路由分三类：

1. 单视频
2. 播放列表 / playlist URL
3. 频道根 URL

### 单视频

例如：

```text
https://www.youtube.com/watch?v=PIdETjcXNIk
https://youtu.be/PIdETjcXNIk
```

没有 `list=`，也不是频道路径时，按单视频处理。

### 播放列表 / 扁平列表

以下 URL 会按 flat playlist 处理：

- 路径以 `/playlist` 开头
- URL 带 `list=` 参数
- 频道子页，例如 `/@name/videos`、`/@name/shorts`

### 频道根 URL

以下 URL 会按频道根处理：

```text
https://www.youtube.com/@name
https://www.youtube.com/channel/<id>
https://www.youtube.com/c/<name>
https://www.youtube.com/user/<name>
```

频道根 URL 会尝试展开 Videos、Shorts、Streams 三类 section。

## Cookies 递进重试

`webfetch` 对 yt-dlp 命令采用递进式 cookies 策略：

1. 先不带 cookies 执行 yt-dlp 命令
2. 如果命令失败，且 stderr 中包含 `"Sign in to confirm you're not a bot"`（YouTube 反爬虫验证），自动重试并带上 `--cookies-from-browser chrome`
3. 重试成功则继续后续流程，结果中会标记 `usedCookies: true`

此策略适用于所有 yt-dlp 命令：元数据抓取（`-J`）、字幕下载。

如果 cookies 重试也失败，会根据 stderr 内容给出不同的错误提示：

| stderr | 提示 |
|---|---|
| 包含 `Sign in to confirm` | YouTube 要求 cookies 认证，请确保 Chrome 中已登录 YouTube |
| 包含 `chrome`（cookie 重试失败） | Chrome cookies 提取失败，确认 Chrome 已安装并已登录 |
| 其他 | yt-dlp 未安装或命令失败 |

## 单视频抓取流程

### 第一步：抓元数据

执行（失败时自动重试带 `--cookies-from-browser chrome`）：

```bash
yt-dlp -J --skip-download --no-warnings --no-playlist <url>
```

这一步不会下载视频，只获取 JSON 元数据，包括：

- `id`
- `title`
- `webpage_url`
- `channel`
- `channel_url`
- `uploader`
- `language`
- `upload_date`
- `duration`
- `view_count`
- `like_count`
- `description`
- `chapters`
- `subtitles`
- `automatic_captions`

### 第二步：选择字幕

拿到元数据后，会检查：

```ts
info.subtitles
info.automatic_captions
```

选择规则：

1. 优先人工字幕 `subtitles`
2. 如果没有人工字幕，再用自动字幕 `automatic_captions`
3. 语言优先级：
   1. 视频声明语言 `info.language`
   2. `en`
   3. `zh`
   4. `zh-Hans`
   5. `zh-Hant`
4. 如果仍然没有可用字幕，则不下载字幕正文

### 第三步：下载字幕正文

如果选中了人工字幕，执行：

```bash
yt-dlp --skip-download --no-warnings --no-playlist \
  --write-subs \
  --sub-langs <language> \
  --sub-format vtt \
  --paths <tmpdir> \
  -o '%(id)s.%(ext)s' \
  <url>
```

如果选中了自动字幕，执行：

```bash
yt-dlp --skip-download --no-warnings --no-playlist \
  --write-auto-subs \
  --sub-langs <language> \
  --sub-format vtt \
  --paths <tmpdir> \
  -o '%(id)s.%(ext)s' \
  <url>
```

### 第四步：清理 VTT

下载后的 `.vtt` 会被清理为纯文本 transcript。

会移除：

- `WEBVTT`
- `Kind:` / `Language:` 头部
- 时间轴行
- cue 编号
- `STYLE` / `REGION` / `NOTE` block
- HTML 标签
- 连续重复行

会转换常见 HTML entity，例如：

```text
&amp; -> &
&lt;  -> <
&gt;  -> >
&quot; -> "
&#39; -> '
```

## 播放列表抓取流程

播放列表和频道子页使用 flat playlist，不抓每个视频详情，不下载字幕。

执行（失败时自动重试带 `--cookies-from-browser chrome`）：

```bash
yt-dlp -J --skip-download --no-warnings --flat-playlist <url>
```

输出会整理成：

```json
{
  "type": "youtube_playlist",
  "url": "...",
  "id": "...",
  "title": "...",
  "entries": [
    {
      "id": "...",
      "title": "...",
      "url": "https://www.youtube.com/watch?v=...",
      "duration": 123,
      "viewCount": 456
    }
  ]
}
```

注意：flat playlist 能拿到的字段取决于 `yt-dlp` 和 YouTube 当前返回的数据。有些条目可能没有 duration 或 view count。

## 频道根抓取流程

频道根 URL 会先执行（失败时自动重试带 `--cookies-from-browser chrome`）：

```bash
yt-dlp -J --skip-download --no-warnings --flat-playlist <channel-url>
```

通常会得到频道 section，例如：

```text
Brandon Melville - Videos  -> https://www.youtube.com/@Brandon-Melville/videos
Brandon Melville - Shorts  -> https://www.youtube.com/@Brandon-Melville/shorts
```

然后 `webfetch` 会自动展开这些 section（每个 section 同样享受 cookies 递进重试）：

```bash
yt-dlp -J --skip-download --no-warnings --flat-playlist <channel-url>/videos

yt-dlp -J --skip-download --no-warnings --flat-playlist <channel-url>/shorts

yt-dlp -J --skip-download --no-warnings --flat-playlist <channel-url>/streams
```

实际只展开根结果中存在的 section。

最终会整理成：

```json
{
  "type": "youtube_channel",
  "url": "https://www.youtube.com/@name",
  "id": "...",
  "title": "...",
  "channel": "...",
  "sections": [
    {
      "type": "videos",
      "title": "... - Videos",
      "url": ".../videos",
      "entries": []
    },
    {
      "type": "shorts",
      "title": "... - Shorts",
      "url": ".../shorts",
      "entries": []
    }
  ],
  "entries": []
}
```

`entries` 是所有 section 条目的合并列表，方便消费。

如果 section 展开失败，会记录到 `errors`，但只要根频道信息可用，整体仍会成功返回已获取的部分内容。

## Markdown 输出

### 单视频

默认 Markdown 输出类似：

```markdown
# Video Title

URL: https://www.youtube.com/watch?v=...
Channel: ...
Upload Date: ...
Duration: 12:34
Views: 12345
Language: en

## Description

...

## Chapters

- 0:00 Intro
- 1:23 Demo

## Transcript

...
```

如果没有字幕：

```markdown
## Transcript

No transcript found.
```

没有字幕不会导致整个工具失败。

### 播放列表

```markdown
# Playlist Title

URL: ...

## Videos

- Video 1 — https://www.youtube.com/watch?v=... (12:34, 123 views)
- Video 2 — https://www.youtube.com/watch?v=...
```

### 频道

```markdown
# Channel Title

URL: ...
Channel: ...
Entries: 85

## Channel - Videos

URL: .../videos

- Video 1 — https://www.youtube.com/watch?v=...

## Channel - Shorts

URL: .../shorts

- Short 1 — https://www.youtube.com/watch?v=...
```

## JSON 输出

`mode: "json"` 时不添加普通 `webfetch` 头部，直接返回 JSON 文本。

单视频类型：

```json
{
  "type": "youtube_video",
  "url": "...",
  "id": "...",
  "title": "...",
  "channel": "...",
  "duration": 123,
  "transcript": {
    "source": "automatic",
    "language": "en",
    "text": "..."
  }
}
```

播放列表类型：

```json
{
  "type": "youtube_playlist",
  "url": "...",
  "entries": []
}
```

频道类型：

```json
{
  "type": "youtube_channel",
  "url": "...",
  "sections": [],
  "entries": []
}
```

## 进度状态

`yt-dlp` 路由会产生以下 progress phase：

| 场景 | phase | message 示例 |
|---|---|---|
| 单视频元数据 | `trying` | `fetching metadata with yt-dlp` |
| 播放列表 | `trying` | `fetching flat playlist with yt-dlp` |
| 频道根 | `trying` | `fetching channel sections with yt-dlp` |
| 展开频道 videos | `extracting` | `fetching channel videos with yt-dlp` |
| 展开频道 shorts | `extracting` | `fetching channel shorts with yt-dlp` |
| 下载字幕 | `extracting` | `downloading automatic subtitles (en) with yt-dlp` |
| 成功 | `success` | `yt-dlp succeeded` |

工具渲染会展示 phase、cli 和 message，例如：

```text
extracting: yt-dlp — downloading automatic subtitles (en) with yt-dlp
```

## 失败处理

### 未安装 yt-dlp

如果系统找不到 `yt-dlp`，底层 `spawn` 会返回类似：

```text
spawn yt-dlp ENOENT
```

最终会返回失败，并提示：

```text
YouTube URL matched. Make sure yt-dlp is installed and available in PATH.
```

### 命令失败

如果 `yt-dlp` exit code 非 0，`webfetch` 会先判断是否为 YouTube 反爬虫验证。

如果是 bot 检测（stderr 包含 `"Sign in to confirm"`），自动重试并带上 `--cookies-from-browser chrome`。

如果重试仍失败，或不是 bot 检测错误，会返回：

```text
yt-dlp command exited with code <code>
```

错误提示会根据 stderr 内容区分：

- 包含 `Sign in to confirm`：提示用户确保 Chrome 中已登录 YouTube
- 包含 `chrome`（cookies 重试也失败）：提示用户确认 Chrome 已安装且已登录
- 其他：通用错误提示

### JSON 为空或非法

如果 `yt-dlp -J` 没有输出 JSON，或 JSON 无法解析，会返回失败。

### 字幕失败

字幕下载失败不会让单视频整体失败。

如果视频元数据已经抓到，但字幕下载失败，会：

- 返回视频信息
- Transcript 显示 `No transcript found.`
- 在 `details.errors` 中记录字幕失败原因

## 超时

`yt-dlp` 命令超时时间是：

```text
120_000 ms
```

超时会返回：

```text
yt-dlp command timed out after 120000 ms
```

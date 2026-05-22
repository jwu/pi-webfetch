# Scrapling 抓取逻辑

本文记录 `webfetch` 在非 GitHub、非 YouTube URL 上使用 Scrapling 的抓取流程。

## 适用范围

当 URL 满足以下条件时，会走 Scrapling：

- URL 协议是 `http://` 或 `https://`
- 不是 GitHub / Gist URL
- 不是 YouTube URL

GitHub URL 会走 `gh`，YouTube URL 会走 `yt-dlp`。

## 执行命令

`webfetch` 通过 Scrapling CLI shell 执行内嵌 Python 代码：

```bash
scrapling shell -L warning -c "..."
```

Python 代码里会使用：

```python
from scrapling.fetchers import Fetcher, DynamicFetcher, StealthyFetcher
from scrapling.core.shell import Convertor
```

内容抽取使用：

```python
Convertor._extract_content(page, extraction_type=mode, main_content_only=True)
```

## URL 和 mode 处理

执行前会先规范化 URL：

- 去掉首尾空白
- 校验 URL 是否有效
- 只允许 `http:` 和 `https:`
- 去掉 fragment/hash

支持的 mode：

- `markdown`
- `html`
- `text`

`json` mode 不支持 Scrapling 路由。如果非 YouTube URL 请求 `mode: "json"`，会直接返回失败：

```text
json mode is only supported by yt-dlp routes.
```

## Defuddle 默认行为

对 Scrapling 路由，默认 Markdown 输出会使用 Defuddle：

1. Scrapling 先用 `html` mode 抽取主内容 HTML
2. Defuddle 把 HTML 转成 Markdown

也就是说，用户请求：

```json
{ "mode": "markdown" }
```

默认实际管线是：

```text
Scrapling html -> Defuddle markdown
```

可以通过配置关闭 Defuddle：

```json
{
  "webfetch": {
    "useDefuddle": false
  }
}
```

关闭后，Scrapling 会直接抽取 Markdown。

## 抓取策略

Scrapling 有三种策略：

| 策略 | Scrapling API | 说明 |
|---|---|---|
| `fetcher` | `Fetcher.get(url)` | 静态抓取，最快 |
| `dynamic` | `DynamicFetcher.fetch(url, network_idle=True, wait=3000)` | 动态页面抓取 |
| `stealthy` | `StealthyFetcher.fetch(url, network_idle=True, wait=3000)` | 更强的反检测抓取 |

默认顺序：

```text
fetcher -> dynamic -> stealthy
```

### 站点特定映射

部分站点会跳过默认顺序，直接使用指定策略：

| 域名 | 策略 | 原因 |
|---|---|---|
| `shadertoy.com` 及子域 | `stealthy` | 常见 Cloudflare 防护 |
| `x.com` / `twitter.com` 及子域 | `stealthy` | SPA 和反爬行为明显 |

## 单个策略的成功条件

某个策略只有同时满足以下条件才算成功：

1. Scrapling 命令正常运行
2. HTTP status 不是 `>= 400`
3. `_extract_content` 返回非空内容
4. 如果启用 Defuddle，Defuddle 转 Markdown 成功且非空
5. 如果启用质量判断，LLM 判断内容可用

失败会记录到 `errors`，然后尝试下一个策略。

## Defuddle 失败时的重试

当启用 Defuddle 时，每个 Scrapling 策略是独立尝试的：

```text
fetcher html -> defuddle
  如果失败：记录错误，继续 dynamic

dynamic html -> defuddle
  如果失败：记录错误，继续 stealthy

stealthy html -> defuddle
```

因此 Defuddle 对某个策略失败不会立即结束整个工具调用。

## 质量判断

如果配置：

```json
{
  "webfetch": {
    "qualityJudge": true
  }
}
```

则 Markdown 内容会交给模型判断是否可用。

会被判为不可用的情况包括：

- 主要是导航栏、页脚、版权声明
- 验证码 / Cloudflare challenge
- 错误页
- 与请求 URL 无关

如果判断不可用，会把该策略当作失败并继续尝试下一个策略。

如果质量判断本身失败，则 fail open：使用已抓到的内容，不让工具不可用。

## 进度状态

Scrapling 会产生以下 progress phase：

| phase | message 示例 |
|---|---|
| `starting` | `starting scrapling shell (fetcher → dynamic → stealthy)` |
| `trying` | `trying fetcher` |
| `extracting` | `extracting markdown with fetcher` |
| `success` | `fetcher succeeded` |
| `failed` | `fetcher failed: HTTP status 403` |
| `converting` | `converting cleaned HTML with Defuddle (fetcher)` |
| `judging` | `judging content quality (fetcher)` |

工具渲染会展示 phase、cli、strategy 和 message，例如：

```text
extracting: scrapling fetcher — extracting html with fetcher
```

## 失败处理

如果 Scrapling 不存在，底层 `spawn` 会返回类似：

```text
spawn scrapling ENOENT
```

最终工具会返回失败结果，并提示：

```text
Fallback fetch uses Scrapling + Defuddle. Make sure Scrapling is available via `scrapling shell -L warning -c "print('ok')"`.
```

失败结果会设置：

```ts
isError: true
phase: 'failed'
```

## 输出和截断

成功结果会包含头部信息：

```text
URL: ...
Status: ...
Fetcher: fetcher
Strategy: ...
Mode: markdown
Scrapling-Mode: html
Converter: defuddle
Content-Length: ...
```

如果输出超过 pi 的标准限制，会截断展示，并把完整内容写入临时文件：

```text
Full output: /tmp/pi-webfetch-.../content.md
```

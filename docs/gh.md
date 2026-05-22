# gh 抓取逻辑

本文记录 `webfetch` 在 GitHub URL 上使用 GitHub CLI（`gh`）的抓取流程。

## 适用范围

当 URL 域名是以下之一时，会走 `gh`：

- `github.com`
- `www.github.com`
- `gist.github.com`

其他 GitHub 相关域名不会自动匹配。

## URL 规范化

执行前会先规范化 URL：

- 去掉首尾空白
- 校验 URL 是否有效
- 只允许 `http:` 和 `https:`
- 去掉 fragment/hash
- 仓库名会去掉末尾 `.git`

例如：

```text
https://github.com/owner/repo.git
```

会按仓库：

```text
owner/repo
```

处理。

## mode 处理

`gh` 本身不负责 HTML/Markdown 转换。

`webfetch` 对 GitHub 路由的 mode 处理是：

| 请求 mode | 实际结果 mode |
|---|---|
| `markdown` | `markdown` |
| `text` | `text` |
| `html` | `text` |
| `json` | `json` |

其中 `html` 会退化为 `text`，因为 `gh` 返回的是 CLI/API 文本或 JSON，而不是页面 HTML。

## 路由规则

`webfetch` 会根据 GitHub URL 路径选择不同的 `gh` 命令。

### 用户页

```text
https://github.com/<owner>
```

执行：

```bash
gh api users/<owner>
```

### 仓库首页

```text
https://github.com/<owner>/<repo>
```

执行：

```bash
gh repo view https://github.com/<owner>/<repo>
```

### Pull Request

```text
https://github.com/<owner>/<repo>/pull/<number>
```

执行：

```bash
gh pr view https://github.com/<owner>/<repo>/pull/<number>
```

### Issue

```text
https://github.com/<owner>/<repo>/issues/<number>
```

执行：

```bash
gh issue view https://github.com/<owner>/<repo>/issues/<number>
```

### Release tag

```text
https://github.com/<owner>/<repo>/releases/tag/<tag>
```

执行：

```bash
gh release view <tag> -R <owner>/<repo>
```

### GitHub Actions run

```text
https://github.com/<owner>/<repo>/actions/runs/<run-id>
```

执行：

```bash
gh run view <run-id> -R <owner>/<repo>
```

### Gist

```text
https://gist.github.com/<owner>/<id>
```

执行：

```bash
gh gist view https://gist.github.com/<owner>/<id>
```

## 文件和目录

GitHub 的 `blob`、`raw`、`tree` URL 会走 contents API。

### 文件内容

```text
https://github.com/<owner>/<repo>/blob/<ref>/<path>
```

执行：

```bash
gh api repos/<owner>/<repo>/contents/<path> \
  --method GET \
  -f ref=<ref> \
  -H 'Accept: application/vnd.github.raw+json'
```

这会尽量返回原始文件内容。

### 目录列表

```text
https://github.com/<owner>/<repo>/tree/<ref>/<path>
```

执行：

```bash
gh api repos/<owner>/<repo>/contents/<path> \
  --method GET \
  -f ref=<ref> \
  --jq '<格式化表达式>'
```

目录条目会格式化为：

```text
- file README.md (1234 bytes)
  https://github.com/owner/repo/blob/main/README.md
- dir src
  https://github.com/owner/repo/tree/main/src
```

## 其他 GitHub URL

没有专门规则的 URL 会回退到：

```bash
gh api repos/<owner>/<repo>/<kind>/...
```

例如 commit：

```text
https://github.com/<owner>/<repo>/commit/<sha>
```

执行：

```bash
gh api repos/<owner>/<repo>/commits/<sha>
```

## 成功条件

`gh` 路由成功需要：

1. `gh` 命令能启动
2. 命令没有超时
3. exit code 是 `0`
4. stdout 非空

成功后，stdout 会作为工具内容返回。

## 进度状态

`gh` 路由的进度较简单：

| phase | message |
|---|---|
| `trying` | `fetching with gh` |
| `success` | `gh succeeded` |

工具渲染会展示 phase、cli、strategy 和 message，例如：

```text
trying: gh view repo — fetching with gh
```

## 失败处理

### 未安装 gh

如果系统找不到 `gh`，底层 `spawn` 会返回类似：

```text
spawn gh ENOENT
```

最终会返回失败，并提示：

```text
GitHub URL matched. Make sure GitHub CLI is installed and authenticated via `gh auth status`.
```

### 未认证或权限不足

如果 `gh` 未认证、权限不足或命令失败，会返回：

```text
gh command exited with code <code>
```

stderr 会附加到失败内容中，最多展示前 4000 字符。

### 404 特殊提示

如果 stderr 包含：

```text
HTTP 404
```

会提示用户检查：

- owner/repo 是否正确
- branch/ref 是否存在
- path 是否存在

提示文案：

```text
GitHub URL matched, but GitHub returned HTTP 404. Check that the owner/repo, branch/ref, and path exist.
```

## 超时

`gh` 命令超时时间是：

```text
60_000 ms
```

超时会返回：

```text
gh command timed out after 60000 ms
```

## 输出和截断

成功结果会包含头部信息：

```text
URL: ...
Fetcher: view repo
Strategy: GitHub repository URL matched; fetch repository with gh.
Mode: markdown
Converter: gh
Content-Length: ...
```

如果输出超过 pi 的标准限制，会截断展示，并把完整内容写入临时文件。

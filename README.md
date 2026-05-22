# pi-webfetch

A [pi](https://github.com/earendil-works/pi-mono) package that adds a `webfetch` tool for reading web URLs as clean Markdown, HTML, text, or YouTube metadata JSON.

`webfetch` is optimized for agent use:

- General web pages are cleaned into readable content.
- GitHub URLs are fetched with `gh` for better repository, issue, PR, file, and directory results.
- YouTube URLs are fetched with `yt-dlp` for video metadata, transcripts, playlists, and channel listings.

## Install

```bash
pi install npm:@johnnywu/pi-webfetch
```

Or via local path in `~/.pi/agent/settings.json` while developing:

```json
{
  "packages": ["~/dev/jwu/pi-webfetch"]
}
```

## Requirements

Install the optional CLI tools for the URL types you want to support:

| URL type | Required executable | Notes |
|---|---|---|
| General web pages | `scrapling` | Used for non-GitHub, non-YouTube URLs |
| GitHub / Gist | `gh` | Must be installed and authenticated for private or rate-limited content |
| YouTube | `yt-dlp` | Used for videos, transcripts, playlists, Shorts, and channels |

Defuddle is bundled as an npm dependency and is used by default to improve Markdown output for general web pages.

## Tool

### `webfetch`

Fetch and clean an HTTP(S) URL.

| Parameter | Type | Default | Description |
|---|---:|---:|---|
| `url` | string | required | HTTP(S) URL to inspect and fetch |
| `mode` | `markdown` \| `html` \| `text` \| `json` | `markdown` | Output mode. `json` is supported for YouTube results. |

Examples:

```json
{ "url": "https://example.com/article" }
```

```json
{ "url": "https://github.com/jwu/pi-webfetch" }
```

```json
{ "url": "https://www.youtube.com/watch?v=PIdETjcXNIk" }
```

```json
{ "url": "https://www.youtube.com/@Brandon-Melville", "mode": "json" }
```

## What you get

### General web pages

Default output is readable Markdown. You can request raw-ish cleaned HTML or plain text with `mode: "html"` or `mode: "text"`.

### GitHub URLs

GitHub URLs are routed through `gh`, so common GitHub pages return useful CLI/API content instead of noisy browser HTML. Supported URL shapes include:

- repositories
- users
- issues
- pull requests
- releases
- Actions runs
- gists
- files and directories
- commits and other API-backed paths

### YouTube URLs

YouTube URLs are routed through `yt-dlp`.

Supported inputs include:

- video URLs
- `youtu.be` short links
- playlists
- channel handles, for example `https://www.youtube.com/@name`
- channel Videos / Shorts / Streams tabs

For videos, `webfetch` returns metadata and tries to include a transcript. Missing transcripts do not fail the request.

For playlists, `webfetch` returns a flat list of entries.

For channel root URLs, `webfetch` expands available Videos, Shorts, and Streams tabs and merges their entries into one channel result.

`mode: "json"` returns a curated stable JSON shape for YouTube video, playlist, or channel data.

## Configuration

Add `webfetch` settings to `.pi/settings.json` (project) or `~/.pi/agent/settings.json` (global):

```json
{
  "webfetch": {
    "useDefuddle": true,
    "qualityJudge": false,
    "qualityJudgeModel": "google/gemini-2.5-flash",
    "qualityJudgeThinkLevel": "off"
  }
}
```

Project settings override global settings. The dotted key form also works:

```json
{
  "webfetch.useDefuddle": true,
  "webfetch.qualityJudge": true,
  "webfetch.qualityJudgeModel": "google/gemini-2.5-flash",
  "webfetch.qualityJudgeThinkLevel": "off"
}
```

### Settings

| Setting | Default | Description |
|---|---:|---|
| `webfetch.useDefuddle` | `true` | Use Defuddle to convert cleaned HTML to Markdown for general web pages. Set `false` to use Scrapling Markdown directly. |
| `webfetch.qualityJudge` | `false` | Ask a model to reject unusable fetched Markdown, such as boilerplate, captcha/challenge pages, or unrelated content. |
| `webfetch.qualityJudgeModel` | current pi model | Optional judge model in `provider/model` form. |
| `webfetch.qualityJudgeThinkLevel` | `off` | Optional judge thinking level: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. |

## Output behavior

- Only `http://` and `https://` URLs are accepted.
- Missing CLI executables return a friendly failed tool result.
- Output is truncated with pi's standard limits: 2000 lines or 50 KiB, whichever is hit first.
- If output is truncated, the full extracted content is saved to a temp file and the path is included in the result.

## Internal docs

Implementation details are documented in:

- [`docs/scrapling.md`](docs/scrapling.md)
- [`docs/gh.md`](docs/gh.md)
- [`docs/yt-dlp.md`](docs/yt-dlp.md)

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Type check
bun run typecheck

# Format
bun run format

# Release (local, requires GH_TOKEN and NPM_TOKEN)
bun run release
```

This project uses [semantic-release](https://semantic-release.gitbook.io) with [conventional commits](https://www.conventionalcommits.org/).

## License

MIT

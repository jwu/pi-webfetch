# pi-webfetch

A [pi](https://github.com/earendil-works/pi-mono) package that adds a `webfetch` tool for fetching and cleaning URL content with [Scrapling](https://github.com/D4Vinci/Scrapling).

Given a user-provided URL, `webfetch` chooses a Scrapling fetcher strategy, runs Scrapling through its CLI shell, and returns cleaned Markdown/HTML/text content to pi.

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

`webfetch` calls Scrapling through:

```bash
scrapling shell -L warning -c "..."
```

Make sure the `scrapling` executable is available in the environment where pi runs.

Defuddle conversion is bundled as an npm dependency and is used only when enabled in settings.

## Configuration

Add `webfetch.useDefuddle` to `.pi/settings.json` (project) or `~/.pi/agent/settings.json` (global):

```json
{
  "webfetch": {
    "useDefuddle": true
  }
}
```

Behavior:

| Setting | Markdown behavior |
|---|---|
| omitted / `false` | Scrapling fetches and extracts Markdown directly |
| `true` | Scrapling fetches cleaned HTML, then Defuddle converts that HTML to Markdown |

Project settings override global settings. For compatibility, the dotted key form also works:

```json
{
  "webfetch.useDefuddle": true
}
```

The switch affects Markdown output. Explicit `mode: "html"` or `mode: "text"` still uses Scrapling extraction directly.

## Tool

### `webfetch`

Fetch and clean an HTTP(S) URL with Scrapling.

| Parameter | Type | Default | Description |
|---|---:|---:|---|
| `url` | string | required | HTTP(S) URL to inspect and fetch |
| `mode` | `markdown` \| `html` \| `text` | `markdown` | Output mode. Markdown may be converted by Scrapling or Defuddle depending on settings. |

## Fetch strategy

`webfetch` uses an explicit built-in site-to-strategy mapping first.

Current mapping:

| Site | Strategy | Reason |
|---|---|---|
| `shadertoy.com` and subdomains | `StealthyFetcher` | Cloudflare protection; static/dynamic fetchers often return 403 or challenge HTML |
| `x.com`, `twitter.com` and subdomains | `StealthyFetcher` | SPA and anti-bot behavior; future login-state support can build on this |

For sites that are not in the mapping, `webfetch` uses sequential escalation from the Scrapling guide:

1. `Fetcher.get(url)` — fastest static fetcher
2. if it fails, returns HTTP `>= 400`, or extracts empty content, try `DynamicFetcher.fetch(url, network_idle=True, wait=3000)`
3. if that also fails or extracts empty content, try `StealthyFetcher.fetch(url, network_idle=True, wait=3000)`

Each failed attempt is recorded in `errors`, so the result explains why `webfetch` adjusted to the next strategy.

Content extraction uses:

```python
Convertor._extract_content(page, extraction_type=mode, main_content_only=True)
```

When `webfetch.useDefuddle` is true and Markdown output is requested, `mode` sent to Scrapling is `html`; the returned cleaned HTML is then parsed with Defuddle using `markdown: true`.

## Output behavior

- Only `http://` and `https://` URLs are accepted.
- Failed Scrapling strategies are included in tool details.
- Tool output is truncated with pi's standard limits: 2000 lines or 50 KiB, whichever is hit first.
- If output is truncated, the full extracted content is saved to a temp file and the path is included in the result.

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

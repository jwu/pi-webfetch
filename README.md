# pi-webfetch

A [pi](https://github.com/earendil-works/pi-mono) package that adds a `webfetch` tool scaffold.

The intended direction is: given a user-provided URL, inspect the URL and choose an appropriate CLI-backed strategy to fetch information, then clean the fetched content according to its type. The first version intentionally only registers the tool and its prompt-facing description so the package can be tested incrementally.

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

## Tool

### `webfetch`

Registered tool scaffold for URL fetching.

| Parameter | Type | Description |
|---|---:|---|
| `url` | string | URL to inspect and eventually fetch |

Current behavior: returns an explicit scaffold message. Actual fetching and cleanup behavior will be added step by step.

## Planned direction

- Analyze the URL and decide which CLI tool or strategy should fetch it.
- Fetch the target information.
- Clean or transform the fetched content based on response type and source.
- Keep each behavior small and testable before expanding scope.

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

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildScraplingShellCode,
  convertHtmlWithDefuddle,
  DEFAULT_STRATEGIES,
  SITE_STRATEGY_MAPPINGS,
  ghRouteForUrl,
  isGitHubUrl,
  isYouTubeUrl,
  normalizeMode,
  normalizeUrl,
  parseVttTranscript,
  readWebFetchSettings,
  runYtDlpFetch,
  siteStrategyMappingForUrl,
  strategiesForUrl,
  strategyReasonForUrl,
} from '../extensions/utils.ts';

describe('normalizeUrl', () => {
  it('accepts HTTP(S) URLs and removes fragments', () => {
    assert.equal(
      normalizeUrl(' https://example.com/path?q=1#frag '),
      'https://example.com/path?q=1',
    );
    assert.equal(normalizeUrl('http://example.com/'), 'http://example.com/');
  });

  it('rejects unsupported protocols and invalid input', () => {
    assert.throws(() => normalizeUrl('file:///etc/passwd'), /Only http:\/\/ and https:\/\//);
    assert.throws(() => normalizeUrl('not a url'), /Invalid URL/);
    assert.throws(() => normalizeUrl(''), /URL is required/);
  });
});

describe('normalizeMode', () => {
  it('accepts Scrapling extraction modes', () => {
    assert.equal(normalizeMode('markdown'), 'markdown');
    assert.equal(normalizeMode('html'), 'html');
    assert.equal(normalizeMode('text'), 'text');
    assert.equal(normalizeMode('json'), 'json');
  });

  it('falls back to markdown for unknown modes', () => {
    assert.equal(normalizeMode(undefined), 'markdown');
    assert.equal(normalizeMode('xml'), 'markdown');
  });
});

describe('readWebFetchSettings', () => {
  let originalHome: string | undefined;
  let home: string | undefined;
  let cwd: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = mkdtempSync('pi-webfetch-home-');
    cwd = mkdtempSync('pi-webfetch-cwd-');
    process.env.HOME = home;
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;

    if (home) rmSync(home, { recursive: true, force: true });
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  function writeGlobalSettings(content: unknown) {
    writeFileSync(join(home!, '.pi', 'agent', 'settings.json'), JSON.stringify(content));
  }

  function writeProjectSettings(content: unknown) {
    mkdirSync(join(cwd!, '.pi'), { recursive: true });
    writeFileSync(join(cwd!, '.pi', 'settings.json'), JSON.stringify(content));
  }

  it('defaults useDefuddle to the built-in fallback behavior', () => {
    assert.deepEqual(readWebFetchSettings(cwd!), {});
  });

  it('reads nested global webfetch settings', () => {
    writeGlobalSettings({
      webfetch: {
        useDefuddle: true,
        qualityJudge: true,
        qualityJudgeModel: 'google/gemini-2.5-flash',
        qualityJudgeThinkLevel: 'minimal',
      },
    });
    assert.deepEqual(readWebFetchSettings(cwd!), {
      useDefuddle: true,
      qualityJudge: true,
      qualityJudgeModel: 'google/gemini-2.5-flash',
      qualityJudgeThinkLevel: 'minimal',
    });
  });

  it('reads dotted webfetch.useDefuddle for compatibility', () => {
    writeGlobalSettings({ 'webfetch.useDefuddle': true });
    assert.deepEqual(readWebFetchSettings(cwd!), { useDefuddle: true });
  });

  it('lets project settings override global settings', () => {
    writeGlobalSettings({
      webfetch: {
        useDefuddle: true,
        qualityJudge: true,
        qualityJudgeModel: 'google/gemini-2.5-flash',
        qualityJudgeThinkLevel: 'minimal',
      },
    });
    writeProjectSettings({
      webfetch: {
        useDefuddle: false,
        qualityJudgeModel: 'anthropic/claude-sonnet-4-5',
        qualityJudgeThinkLevel: 'off',
      },
    });
    assert.deepEqual(readWebFetchSettings(cwd!), {
      useDefuddle: false,
      qualityJudge: true,
      qualityJudgeModel: 'anthropic/claude-sonnet-4-5',
      qualityJudgeThinkLevel: 'off',
    });
  });

  it('ignores invalid values', () => {
    writeGlobalSettings({
      webfetch: {
        useDefuddle: 'yes',
        qualityJudge: 'yes',
        qualityJudgeModel: '',
        qualityJudgeThinkLevel: 'extreme',
      },
    });
    assert.deepEqual(readWebFetchSettings(cwd!), {});
  });
});

describe('strategy mapping', () => {
  it('uses the default sequential Scrapling priority for unmapped sites', () => {
    assert.deepEqual(DEFAULT_STRATEGIES, ['fetcher', 'dynamic', 'stealthy']);
    assert.deepEqual(strategiesForUrl('https://example.com'), DEFAULT_STRATEGIES);
    assert.equal(siteStrategyMappingForUrl('https://example.com'), undefined);
    assert.match(strategyReasonForUrl('https://example.com'), /No site-specific mapping/);
  });

  it('keeps site-specific strategies in an explicit built-in mapping table', () => {
    assert.ok(SITE_STRATEGY_MAPPINGS.some((mapping) => mapping.domains.includes('shadertoy.com')));
    assert.ok(SITE_STRATEGY_MAPPINGS.some((mapping) => mapping.domains.includes('x.com')));
  });

  it('prefers StealthyFetcher for Shadertoy and subdomains', () => {
    assert.deepEqual(strategiesForUrl('https://www.shadertoy.com/view/abc123'), ['stealthy']);
    assert.deepEqual(strategiesForUrl('https://sub.shadertoy.com/view/abc123'), ['stealthy']);
    assert.match(strategyReasonForUrl('https://www.shadertoy.com/view/abc123'), /Cloudflare/);
  });

  it('prefers StealthyFetcher for Twitter/X', () => {
    assert.deepEqual(strategiesForUrl('https://x.com/jack'), ['stealthy']);
    assert.deepEqual(strategiesForUrl('https://twitter.com/jack'), ['stealthy']);
  });
});

describe('YouTube routing', () => {
  it('detects YouTube URL variants', () => {
    assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=abc123'), true);
    assert.equal(isYouTubeUrl('https://m.youtube.com/watch?v=abc123'), true);
    assert.equal(isYouTubeUrl('https://music.youtube.com/watch?v=abc123'), true);
    assert.equal(isYouTubeUrl('https://youtu.be/abc123'), true);
    assert.equal(isYouTubeUrl('https://www.youtube-nocookie.com/embed/abc123'), true);
    assert.equal(isYouTubeUrl('https://example.com/watch?v=abc123'), false);
  });

  it('cleans VTT subtitles into transcript text', () => {
    const transcript = parseVttTranscript(
      `WEBVTT\nKind: captions\nLanguage: en\n\n00:00:00.000 --> 00:00:01.000\n<c>Hello &amp; welcome</c>\n\n00:00:01.000 --> 00:00:02.000\nHello &amp; welcome\n\n00:00:02.000 --> 00:00:03.000\nWorld`,
    );

    assert.equal(transcript, 'Hello & welcome\nWorld');
  });
});

describe('runYtDlpFetch', () => {
  let originalPath: string | undefined;
  let binDir: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
    binDir = mkdtempSync('pi-webfetch-ytdlp-bin-');
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;

    if (binDir) rmSync(binDir, { recursive: true, force: true });
  });

  function installFakeYtDlp() {
    const videoInfo = {
      id: 'abc123',
      title: 'Example video',
      webpage_url: 'https://www.youtube.com/watch?v=abc123',
      channel: 'Example channel',
      language: 'fr',
      duration: 62,
      automatic_captions: { en: [{}] },
    };
    const playlistInfo = {
      id: 'PL123',
      title: 'Example playlist',
      webpage_url: 'https://www.youtube.com/playlist?list=PL123',
      entries: [
        { id: 'one', title: 'One' },
        { id: 'two', title: 'Two', webpage_url: 'https://www.youtube.com/watch?v=two' },
      ],
    };
    const channelRootInfo = {
      id: '@Example',
      title: 'Example Channel',
      webpage_url: 'https://www.youtube.com/@Example',
      channel: 'Example Channel',
      entries: [
        {
          id: 'UC123',
          title: 'Example Channel - Videos',
          url: 'https://www.youtube.com/@Example/videos',
        },
        {
          id: 'UC123',
          title: 'Example Channel - Shorts',
          url: 'https://www.youtube.com/@Example/shorts',
        },
      ],
    };
    const channelVideosInfo = {
      id: 'UC123',
      title: 'Example Channel - Videos',
      webpage_url: 'https://www.youtube.com/@Example/videos',
      entries: [{ id: 'long-one', title: 'Long One', duration: 120 }],
    };
    const channelShortsInfo = {
      id: 'UC123',
      title: 'Example Channel - Shorts',
      webpage_url: 'https://www.youtube.com/@Example/shorts',
      entries: [{ id: 'short-one', title: 'Short One', view_count: 42 }],
    };
    const script = `#!/bin/sh
last_arg=""
for arg in "$@"; do
  last_arg="$arg"
done
if echo " $* " | grep -q -- " -J "; then
  if echo " $* " | grep -q -- " --flat-playlist "; then
    case "$last_arg" in
      */@Example/videos) printf '%s\n' ${JSON.stringify(JSON.stringify(channelVideosInfo))} ;;
      */@Example/shorts) printf '%s\n' ${JSON.stringify(JSON.stringify(channelShortsInfo))} ;;
      */@Example) printf '%s\n' ${JSON.stringify(JSON.stringify(channelRootInfo))} ;;
      *) printf '%s\n' ${JSON.stringify(JSON.stringify(playlistInfo))} ;;
    esac
  else
    printf '%s\n' ${JSON.stringify(JSON.stringify(videoInfo))}
  fi
  exit 0
fi
output_dir=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--paths" ]; then
    output_dir="$arg"
    break
  fi
  previous="$arg"
done
mkdir -p "$output_dir"
cat > "$output_dir/abc123.en.vtt" <<'VTT'
WEBVTT

00:00:00.000 --> 00:00:01.000
Hello &amp; welcome

00:00:01.000 --> 00:00:02.000
World
VTT
`;
    const executable = join(binDir!, 'yt-dlp');
    writeFileSync(executable, script);
    chmodSync(executable, 0o755);
  }

  it('returns YouTube video metadata with transcript markdown', async () => {
    installFakeYtDlp();

    const result = await runYtDlpFetch({
      url: 'https://youtu.be/abc123',
      mode: 'markdown',
      cwd: process.cwd(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.strategy, 'yt-dlp');
    assert.equal(result.mode, 'markdown');
    assert.match(result.content ?? '', /# Example video/);
    assert.match(result.content ?? '', /Channel: Example channel/);
    assert.match(result.content ?? '', /Hello & welcome\nWorld/);
    assert.deepEqual(result.errors, []);
  });

  it('returns flat playlist data as curated JSON', async () => {
    installFakeYtDlp();

    const result = await runYtDlpFetch({
      url: 'https://www.youtube.com/playlist?list=PL123',
      mode: 'json',
      cwd: process.cwd(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'json');
    const parsed = JSON.parse(result.content ?? '{}') as {
      type: string;
      entries: Array<{ id: string; url: string }>;
    };
    assert.equal(parsed.type, 'youtube_playlist');
    assert.deepEqual(
      parsed.entries.map((entry) => entry.url),
      ['https://www.youtube.com/watch?v=one', 'https://www.youtube.com/watch?v=two'],
    );
  });

  it('expands channel root URLs into videos and shorts sections', async () => {
    installFakeYtDlp();
    const messages: string[] = [];

    const result = await runYtDlpFetch({
      url: 'https://www.youtube.com/@Example',
      mode: 'json',
      cwd: process.cwd(),
      onProgress: (progress) => messages.push(progress.message),
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'json');
    assert.match(result.strategyReason ?? '', /expand channel videos and shorts/);
    assert.ok(messages.includes('fetching channel sections with yt-dlp'));
    assert.ok(messages.includes('fetching channel videos with yt-dlp'));
    assert.ok(messages.includes('fetching channel shorts with yt-dlp'));

    const parsed = JSON.parse(result.content ?? '{}') as {
      type: string;
      entries: Array<{ id: string; url: string; duration?: number; viewCount?: number }>;
      sections: Array<{ type: string; entries: Array<{ id: string }> }>;
    };
    assert.equal(parsed.type, 'youtube_channel');
    assert.deepEqual(
      parsed.sections.map((section) => section.type),
      ['videos', 'shorts'],
    );
    assert.deepEqual(
      parsed.entries.map((entry) => [entry.id, entry.url, entry.duration, entry.viewCount]),
      [
        ['long-one', 'https://www.youtube.com/watch?v=long-one', 120, undefined],
        ['short-one', 'https://www.youtube.com/watch?v=short-one', undefined, 42],
      ],
    );
  });
});

describe('GitHub routing', () => {
  it('detects github.com and gist.github.com URLs only', () => {
    assert.equal(isGitHubUrl('https://github.com/jwu/pi-webfetch'), true);
    assert.equal(isGitHubUrl('https://www.github.com/jwu/pi-webfetch'), true);
    assert.equal(isGitHubUrl('https://gist.github.com/jwu/abc123'), true);
    assert.equal(isGitHubUrl('https://example.com/jwu/pi-webfetch'), false);
  });

  it('routes known GitHub URL types to matching gh view commands', () => {
    assert.equal(ghRouteForUrl('https://github.com/jwu/pi-webfetch').strategy, 'view repo');
    assert.equal(ghRouteForUrl('https://github.com/jwu/pi-webfetch/pull/34').strategy, 'view pr');
    assert.equal(
      ghRouteForUrl('https://github.com/jwu/pi-webfetch/issues/12').strategy,
      'view issue',
    );
    assert.equal(
      ghRouteForUrl('https://github.com/jwu/pi-webfetch/releases/tag/v1.0').strategy,
      'view release',
    );
    assert.equal(ghRouteForUrl('https://gist.github.com/jwu/abc123').strategy, 'view gist');
    assert.equal(
      ghRouteForUrl('https://github.com/jwu/pi-webfetch/actions/runs/99').strategy,
      'view run',
    );

    assert.deepEqual(ghRouteForUrl('https://github.com/jwu/pi-webfetch').args, [
      'repo',
      'view',
      'https://github.com/jwu/pi-webfetch',
    ]);
    assert.deepEqual(ghRouteForUrl('https://github.com/jwu/pi-webfetch/pull/34').args, [
      'pr',
      'view',
      'https://github.com/jwu/pi-webfetch/pull/34',
    ]);
    assert.deepEqual(ghRouteForUrl('https://github.com/jwu/pi-webfetch/issues/12').args, [
      'issue',
      'view',
      'https://github.com/jwu/pi-webfetch/issues/12',
    ]);
    assert.deepEqual(ghRouteForUrl('https://github.com/jwu/pi-webfetch/releases/tag/v1.0').args, [
      'release',
      'view',
      'v1.0',
      '-R',
      'jwu/pi-webfetch',
    ]);
    assert.deepEqual(ghRouteForUrl('https://gist.github.com/jwu/abc123').args, [
      'gist',
      'view',
      'https://gist.github.com/jwu/abc123',
    ]);
    assert.deepEqual(ghRouteForUrl('https://github.com/jwu/pi-webfetch/actions/runs/99').args, [
      'run',
      'view',
      '99',
      '-R',
      'jwu/pi-webfetch',
    ]);
  });

  it('falls back to gh api for unmatched GitHub URLs', () => {
    assert.equal(ghRouteForUrl('https://github.com/jwu/pi-webfetch/commit/abc123').strategy, 'api');
    assert.equal(
      ghRouteForUrl('https://github.com/jwu/pi-webfetch/blob/main/README.md').strategy,
      'api',
    );
    assert.equal(
      ghRouteForUrl('https://github.com/jwu/pi-webfetch/tree/main/extensions').strategy,
      'api',
    );

    assert.deepEqual(ghRouteForUrl('https://github.com/jwu/pi-webfetch/commit/abc123').args, [
      'api',
      'repos/jwu/pi-webfetch/commits/abc123',
    ]);
    assert.deepEqual(ghRouteForUrl('https://github.com/jwu/pi-webfetch/blob/main/README.md').args, [
      'api',
      'repos/jwu/pi-webfetch/contents/README.md',
      '--method',
      'GET',
      '-f',
      'ref=main',
      '-H',
      'Accept: application/vnd.github.raw+json',
    ]);
    const treeRoute = ghRouteForUrl('https://github.com/jwu/pi-webfetch/tree/main/extensions');
    assert.deepEqual(treeRoute.args.slice(0, 7), [
      'api',
      'repos/jwu/pi-webfetch/contents/extensions',
      '--method',
      'GET',
      '-f',
      'ref=main',
      '--jq',
    ]);
    assert.match(treeRoute.args[7], /\.\[\]/);
    assert.match(treeRoute.args[7], /\.path/);
    assert.match(treeRoute.args[7], /\.html_url/);
  });
});

describe('buildScraplingShellCode', () => {
  it('contains the Scrapling API calls from the guide', () => {
    const code = buildScraplingShellCode();

    assert.match(code, /from scrapling\.fetchers import Fetcher, DynamicFetcher, StealthyFetcher/);
    assert.match(code, /Convertor\._extract_content/);
    assert.match(code, /Fetcher\.get/);
    assert.match(code, /DynamicFetcher\.fetch/);
    assert.match(code, /StealthyFetcher\.fetch/);
    assert.match(code, /network_idle=True/);
    assert.match(code, /wait=3000/);
  });
});

describe('convertHtmlWithDefuddle', () => {
  it('converts HTML to markdown with Defuddle', async () => {
    const markdown = await convertHtmlWithDefuddle(
      '<!doctype html><html><body><article><h1>Hello</h1><p>World</p></article></body></html>',
      'https://example.com/article',
    );

    assert.match(markdown, /World/);
    assert.ok(!markdown.includes('<article>'));
  });
});

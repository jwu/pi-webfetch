import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildScraplingShellCode,
  convertHtmlWithDefuddle,
  DEFAULT_STRATEGIES,
  SITE_STRATEGY_MAPPINGS,
  ghRouteForUrl,
  isGitHubUrl,
  normalizeMode,
  normalizeUrl,
  readWebFetchSettings,
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
  });

  it('falls back to markdown for unknown modes', () => {
    assert.equal(normalizeMode(undefined), 'markdown');
    assert.equal(normalizeMode('json'), 'markdown');
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

  it('reads nested global webfetch.useDefuddle', () => {
    writeGlobalSettings({ webfetch: { useDefuddle: true } });
    assert.deepEqual(readWebFetchSettings(cwd!), { useDefuddle: true });
  });

  it('reads dotted webfetch.useDefuddle for compatibility', () => {
    writeGlobalSettings({ 'webfetch.useDefuddle': true });
    assert.deepEqual(readWebFetchSettings(cwd!), { useDefuddle: true });
  });

  it('lets project settings override global settings', () => {
    writeGlobalSettings({ webfetch: { useDefuddle: true } });
    writeProjectSettings({ webfetch: { useDefuddle: false } });
    assert.deepEqual(readWebFetchSettings(cwd!), { useDefuddle: false });
  });

  it('ignores invalid values', () => {
    writeGlobalSettings({ webfetch: { useDefuddle: 'yes' } });
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

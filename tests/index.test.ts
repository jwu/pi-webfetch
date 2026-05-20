import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import webfetchExtension, { createWebFetchTool, type WebFetchRunner } from '../extensions/index.ts';

function fakeRunner(content = '# Example\n\nFetched content'): WebFetchRunner {
  return async ({ url, mode }) => ({
    ok: true,
    url,
    finalUrl: url,
    status: 200,
    strategy: 'fetcher',
    strategyReason: 'test strategy reason',
    mode: mode ?? 'markdown',
    content,
    contentLength: content.length,
    errors: [],
  });
}

function failingRunner(): WebFetchRunner {
  return async ({ url, mode }) => ({
    ok: false,
    url,
    mode: mode ?? 'markdown',
    strategyReason: 'test strategy reason',
    errors: [{ strategy: 'fetcher', error: 'HTTP status 403' }],
    stderr: 'blocked',
  });
}

function mockTheme() {
  return {
    fg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  };
}

function markerTheme() {
  return {
    fg(color: string, text: string) {
      return `[${color}]${text}[/${color}]`;
    },
    bold(text: string) {
      return `<b>${text}</b>`;
    },
  };
}

describe('webfetch extension', () => {
  it('registers the webfetch tool', () => {
    const tools: Array<ReturnType<typeof createWebFetchTool>> = [];

    webfetchExtension({
      registerTool(tool: ReturnType<typeof createWebFetchTool>) {
        tools.push(tool);
      },
    } as never);

    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'webfetch');
    assert.equal(tools[0].label, 'Web Fetch');
    assert.match(tools[0].description, /Scrapling/);
    assert.match(tools[0].description, /gh/);
    assert.ok(tools[0].promptSnippet?.includes('Scrapling'));
    assert.ok(tools[0].promptGuidelines?.some((line) => line.includes('github.com')));
    assert.ok(tools[0].promptGuidelines?.some((line) => line.includes('scrapling shell')));
    assert.ok(tools[0].promptGuidelines?.some((line) => line.includes('useDefuddle')));
  });

  it('routes GitHub URLs to gh', async () => {
    let ghCalled = false;
    let converterCalled = false;
    const ghRunner: WebFetchRunner = async ({ url, mode }) => {
      ghCalled = true;
      return {
        ok: true,
        url,
        finalUrl: url,
        status: 200,
        strategy: 'view repo',
        strategyReason: 'GitHub URL matched; fetch with gh.',
        mode: mode ?? 'markdown',
        content: '{"nameWithOwner":"jwu/pi-webfetch"}',
        contentLength: 34,
        errors: [],
      };
    };

    const tool = createWebFetchTool(
      undefined,
      () => ({}),
      async () => {
        converterCalled = true;
        return 'converted';
      },
      ghRunner,
    );
    const result = await tool.execute(
      'call-1',
      { url: 'https://github.com/jwu/pi-webfetch' },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    assert.equal(ghCalled, true);
    assert.equal(converterCalled, false);
    assert.match(result.content[0].text, /Fetcher: view repo/);
    assert.match(result.content[0].text, /Converter: gh/);
    assert.deepEqual(result.details, {
      url: 'https://github.com/jwu/pi-webfetch',
      finalUrl: 'https://github.com/jwu/pi-webfetch',
      status: 200,
      strategy: 'view repo',
      strategyReason: 'GitHub URL matched; fetch with gh.',
      mode: 'markdown',
      scraplingMode: undefined,
      converter: 'gh',
      useDefuddle: false,
      contentLength: 34,
      fullOutputPath: undefined,
      truncation: (result.details as { truncation: unknown }).truncation,
      phase: 'done',
      errors: [],
    });
  });

  it('renders GitHub failures as failed without duplicated gh label', async () => {
    const ghRunner: WebFetchRunner = async ({ url, mode }) => ({
      ok: false,
      url,
      strategy: 'view repo',
      strategyReason: 'GitHub URL matched; fetch with gh.',
      mode: mode ?? 'markdown',
      errors: [{ strategy: 'view repo', error: 'gh auth required' }],
    });

    const tool = createWebFetchTool(undefined, () => ({}), undefined, ghRunner);
    const result = await tool.execute(
      'call-1',
      { url: 'https://github.com/jwu/pi-webfetch' },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    const rendered = tool.renderResult(result, { expanded: false, isPartial: false }, mockTheme());
    const text = rendered
      .render(1000)
      .map((line) => line.trimEnd())
      .join('\n');

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /GitHub CLI/);
    assert.doesNotMatch(result.content[0].text, /Scrapling \+ Defuddle/);
    assert.match(text, /^└─ failed: gh view repo/m);
    assert.doesNotMatch(text, /failed: gh gh/);
  });

  it('returns fetched Scrapling content from the runner', async () => {
    const tool = createWebFetchTool(fakeRunner());
    const result = await tool.execute(
      'call-1',
      { url: 'https://example.com', mode: 'markdown' },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    assert.equal(result.content[0].type, 'text');
    assert.match(result.content[0].text, /Fetcher: fetcher/);
    assert.match(result.content[0].text, /Converter: scrapling/);
    assert.match(result.content[0].text, /# Example/);
    const details = result.details as unknown as Record<string, unknown>;
    assert.equal((details.truncation as { truncated: boolean }).truncated, false);
    delete details.truncation;
    assert.deepEqual(details, {
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      status: 200,
      strategy: 'fetcher',
      strategyReason: 'test strategy reason',
      mode: 'markdown',
      scraplingMode: 'markdown',
      converter: 'scrapling',
      useDefuddle: false,
      contentLength: '# Example\n\nFetched content'.length,
      fullOutputPath: undefined,
      phase: 'done',
      errors: [],
    });
  });

  it('uses Scrapling HTML plus Defuddle for markdown when enabled in settings', async () => {
    let runnerMode: string | undefined;
    const runner: WebFetchRunner = async ({ url, mode }) => {
      runnerMode = mode;
      return {
        ok: true,
        url,
        finalUrl: url,
        status: 200,
        strategy: 'fetcher',
        strategyReason: 'test strategy reason',
        mode: mode ?? 'markdown',
        content: '<article><h1>Example</h1><p>Fetched content</p></article>',
        contentLength: 57,
        errors: [],
      };
    };

    const tool = createWebFetchTool(
      runner,
      () => ({ useDefuddle: true }),
      async (html, url) => {
        assert.match(html, /<article>/);
        assert.equal(url, 'https://example.com');
        return '# Example\n\nFetched content';
      },
    );

    const result = await tool.execute(
      'call-1',
      { url: 'https://example.com', mode: 'markdown' },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    assert.equal(runnerMode, 'html');
    assert.match(result.content[0].text, /Scrapling-Mode: html/);
    assert.match(result.content[0].text, /Converter: defuddle/);
    assert.match(result.content[0].text, /# Example/);
    const details = result.details as unknown as Record<string, unknown>;
    assert.equal((details.truncation as { truncated: boolean }).truncated, false);
    delete details.truncation;
    assert.deepEqual(details, {
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      status: 200,
      strategy: 'fetcher',
      strategyReason: 'test strategy reason',
      mode: 'markdown',
      scraplingMode: 'html',
      converter: 'defuddle',
      useDefuddle: true,
      contentLength: '# Example\n\nFetched content'.length,
      fullOutputPath: undefined,
      phase: 'done',
      errors: [],
    });
  });

  it('does not use Defuddle for explicit html mode even when enabled', async () => {
    let converterCalled = false;
    let runnerMode: string | undefined;
    const runner: WebFetchRunner = async ({ url, mode }) => {
      runnerMode = mode;
      return {
        ok: true,
        url,
        finalUrl: url,
        status: 200,
        strategy: 'fetcher',
        strategyReason: 'test strategy reason',
        mode: mode ?? 'markdown',
        content: '<main>HTML</main>',
        contentLength: 17,
        errors: [],
      };
    };

    const tool = createWebFetchTool(
      runner,
      () => ({ useDefuddle: true }),
      async () => {
        converterCalled = true;
        return 'converted';
      },
    );

    const result = await tool.execute(
      'call-1',
      { url: 'https://example.com', mode: 'html' },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    assert.equal(runnerMode, 'html');
    assert.equal(converterCalled, false);
    assert.match(result.content[0].text, /Converter: scrapling/);
    assert.match(result.content[0].text, /<main>HTML<\/main>/);
  });

  it('returns an error result when Defuddle conversion fails', async () => {
    const tool = createWebFetchTool(
      fakeRunner('<article>HTML</article>'),
      () => ({ useDefuddle: true }),
      async () => {
        throw new Error('defuddle exploded');
      },
    );

    const result = await tool.execute(
      'call-1',
      { url: 'https://example.com' },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Web fetch failed/);
    assert.match(result.content[0].text, /defuddle exploded/);
    assert.deepEqual(result.details, {
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      status: 200,
      strategy: 'fetcher',
      strategyReason: 'test strategy reason',
      mode: 'markdown',
      scraplingMode: 'html',
      converter: 'defuddle',
      useDefuddle: true,
      contentLength: '<article>HTML</article>'.length,
      phase: 'failed',
      currentStrategy: 'fetcher',
      errors: [{ strategy: 'defuddle', error: 'defuddle exploded' }],
    });
  });

  it('streams progress updates while Scrapling is running', async () => {
    const updates: unknown[] = [];
    const runner: WebFetchRunner = async ({ url, mode, onProgress }) => {
      onProgress?.({ phase: 'trying', strategy: 'fetcher', message: 'trying fetcher' });
      onProgress?.({
        phase: 'failed',
        strategy: 'fetcher',
        message: 'fetcher failed: HTTP status 403',
        errors: [{ strategy: 'fetcher', error: 'HTTP status 403' }],
      });
      return {
        ok: true,
        url,
        finalUrl: url,
        status: 200,
        strategy: 'dynamic',
        strategyReason: 'test strategy reason',
        mode: mode ?? 'markdown',
        content: 'content',
        contentLength: 7,
        errors: [{ strategy: 'fetcher', error: 'HTTP status 403' }],
      };
    };

    const tool = createWebFetchTool(runner);
    await tool.execute(
      'call-1',
      { url: 'https://example.com' },
      undefined,
      (update: unknown) => updates.push(update),
      { cwd: process.cwd() },
    );

    assert.ok(updates.length >= 3);
    assert.deepEqual(
      updates.map((update) => (update as { details: { phase: string } }).details.phase),
      ['starting', 'trying', 'failed'],
    );
  });

  it('renders partial progress as tree status lines', async () => {
    const tool = createWebFetchTool(fakeRunner());
    const theme = markerTheme();
    const partial = {
      content: [{ type: 'text', text: 'webfetch https://example.com\ntrying fetcher' }],
      details: {
        url: 'https://example.com',
        mode: 'markdown',
        scraplingMode: 'markdown',
        converter: 'scrapling',
        useDefuddle: false,
        phase: 'trying',
        currentStrategy: 'fetcher',
        message: 'trying fetcher',
        errors: [],
      },
    };

    const rendered = tool.renderResult(partial, { expanded: false, isPartial: true }, theme);
    const text = rendered
      .render(1000)
      .map((line) => line.trimEnd())
      .join('\n');

    assert.match(
      text,
      /^\[dim\]└─ \[\/dim\]\[accent\]trying\[\/accent\]: \[customMessageLabel\]scrapling\[\/customMessageLabel\]\[dim\] fetcher\[\/dim\]/,
    );
  });

  it('renders body output with toolOutput color rather than markdown highlighting', async () => {
    const tool = createWebFetchTool(fakeRunner('# Heading\n\n**bold**'));
    const theme = markerTheme();
    const result = await tool.execute(
      'call-1',
      { url: 'https://example.com' },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme);
    const text = collapsed
      .render(1000)
      .map((line) => line.trimEnd())
      .join('\n');

    assert.match(text, /\[toolOutput\]# Heading\[\/toolOutput\]/);
    assert.match(text, /\[toolOutput\]\*\*bold\*\*\[\/toolOutput\]/);
  });

  it('renders compact call and expandable result output', async () => {
    const longOutput = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n');
    const tool = createWebFetchTool(fakeRunner(longOutput));
    const theme = mockTheme();

    const call = tool.renderCall({ url: 'https://example.com', mode: 'markdown' }, theme);
    assert.match(call.render(120).join('\n'), /webfetch https:\/\/example\.com/);

    const result = await tool.execute(
      'call-1',
      { url: 'https://example.com' },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme);
    const collapsedText = collapsed
      .render(1000)
      .map((line) => line.trimEnd())
      .join('\n');
    assert.match(collapsedText, /^└─ done fetcher \| markdown via scrapling \| \d+B/m);
    assert.match(collapsedText, /\n\nline 1/);
    assert.match(collapsedText, /line 20/);
    assert.doesNotMatch(collapsedText, /line 21/);
    assert.doesNotMatch(collapsedText, /├─ line 1/);
    assert.match(collapsedText, /\.\.\. \(60 more lines, ctrl\+o to expand\)/);

    const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme);
    const expandedText = expanded
      .render(1000)
      .map((line) => line.trimEnd())
      .join('\n');
    assert.match(expandedText, /^└─ done fetcher \| markdown via scrapling \| \d+B/m);
    assert.match(expandedText, /\n\nURL: https:\/\/example\.com/);
    assert.match(expandedText, /line 80/);
  });

  it('returns an error result when Scrapling fails', async () => {
    const tool = createWebFetchTool(failingRunner());
    const result = await tool.execute(
      'call-1',
      { url: 'https://example.com' },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Web fetch failed/);
    assert.match(result.content[0].text, /HTTP status 403/);
    assert.deepEqual(result.details, {
      url: 'https://example.com',
      finalUrl: undefined,
      status: undefined,
      strategy: undefined,
      strategyReason: 'test strategy reason',
      mode: 'markdown',
      scraplingMode: 'markdown',
      converter: 'scrapling',
      useDefuddle: false,
      contentLength: undefined,
      phase: 'failed',
      errors: [{ strategy: 'fetcher', error: 'HTTP status 403' }],
    });
  });
});

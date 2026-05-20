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
    assert.ok(tools[0].promptSnippet?.includes('Scrapling'));
    assert.ok(tools[0].promptGuidelines?.some((line) => line.includes('scrapling shell')));
    assert.ok(tools[0].promptGuidelines?.some((line) => line.includes('useDefuddle')));
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
    assert.match(result.content[0].text, /Scrapling fetch failed/);
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

  it('renders compact call and expandable result output', async () => {
    const tool = createWebFetchTool(fakeRunner('line 1\nline 2\nline 3'));
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
    assert.match(collapsed.render(120).join('\n'), /done/);
    assert.doesNotMatch(collapsed.render(120).join('\n'), /line 2/);

    const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme);
    assert.match(expanded.render(120).join('\n'), /line 2/);
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
    assert.match(result.content[0].text, /Scrapling fetch failed/);
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
      errors: [{ strategy: 'fetcher', error: 'HTTP status 403' }],
    });
  });
});

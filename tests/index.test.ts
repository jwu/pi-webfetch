import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import webfetchExtension from '../extensions/index.ts';

type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: { url: string },
  ) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    details: unknown;
  }>;
};

function registerExtension(): RegisteredTool {
  const tools: RegisteredTool[] = [];

  webfetchExtension({
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  } as never);

  assert.equal(tools.length, 1);
  return tools[0];
}

describe('webfetch extension', () => {
  it('registers the webfetch tool scaffold', () => {
    const tool = registerExtension();

    assert.equal(tool.name, 'webfetch');
    assert.equal(tool.label, 'Web Fetch');
    assert.match(tool.description, /URL/);
    assert.match(tool.description, /scaffold/i);
    assert.ok(tool.promptSnippet?.includes('URL'));
    assert.ok(tool.promptGuidelines?.some((line) => line.includes('not implemented yet')));
  });

  it('returns an explicit scaffold message when executed', async () => {
    const tool = registerExtension();
    const result = await tool.execute('call-1', { url: 'https://example.com' });

    assert.equal(result.content[0].type, 'text');
    assert.match(result.content[0].text, /not implemented yet/);
    assert.match(result.content[0].text, /https:\/\/example\.com/);
    assert.deepEqual(result.details, {
      url: 'https://example.com',
      status: 'scaffold',
    });
  });
});

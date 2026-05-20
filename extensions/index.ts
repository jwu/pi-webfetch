import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const WebFetchParams = Type.Object({
  url: Type.String({
    description:
      'URL to inspect and fetch. The implementation will decide the best fetching strategy.',
  }),
});

export interface WebFetchInput {
  url: string;
}

export interface WebFetchDetails {
  url: string;
  status: 'scaffold';
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'webfetch',
    label: 'Web Fetch',
    description:
      'Inspect a user-provided URL and fetch its information with an appropriate CLI-backed strategy. This package currently registers the tool scaffold only; fetching and cleanup strategies will be added incrementally.',
    promptSnippet:
      'Inspect and fetch information from a user-provided URL using the appropriate strategy.',
    promptGuidelines: [
      'Use webfetch when the user provides a URL and asks to inspect, fetch, read, summarize, or analyze its content.',
      'The current webfetch implementation is a scaffold; report that fetching behavior is not implemented yet instead of inventing fetched content.',
    ],
    parameters: WebFetchParams,

    async execute(_toolCallId, params: WebFetchInput) {
      return {
        content: [
          {
            type: 'text',
            text: `webfetch is registered, but fetching is not implemented yet. URL received: ${params.url}`,
          },
        ],
        details: {
          url: params.url,
          status: 'scaffold',
        } satisfies WebFetchDetails,
      };
    },
  });
}

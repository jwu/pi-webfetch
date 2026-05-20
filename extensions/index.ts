import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type AgentToolUpdateCallback,
  type TruncationResult,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import {
  DEFAULT_MODE,
  convertHtmlWithDefuddle,
  normalizeMode,
  persistFullContent,
  readWebFetchSettings,
  runScraplingFetch,
  type ExtractionMode,
  type FetchStrategy,
  type ScraplingFetchOptions,
  type ScraplingFetchResult,
  type WebFetchProgress,
  type WebFetchSettings,
} from './utils.js';

const WebFetchParams = Type.Object({
  url: Type.String({
    description: 'HTTP or HTTPS URL to inspect and fetch with Scrapling.',
  }),
  mode: Type.Optional(
    Type.Union([Type.Literal('markdown'), Type.Literal('html'), Type.Literal('text')]),
  ),
});

export interface WebFetchInput {
  url: string;
  mode?: ExtractionMode;
}

export interface WebFetchDetails {
  url: string;
  finalUrl?: string;
  status?: number | string | null;
  strategy?: string;
  strategyReason?: string;
  mode: ExtractionMode;
  scraplingMode?: ExtractionMode;
  converter: 'scrapling' | 'defuddle';
  useDefuddle: boolean;
  phase?: WebFetchProgress['phase'] | 'converting' | 'done';
  currentStrategy?: FetchStrategy;
  message?: string;
  contentLength?: number;
  fullOutputPath?: string;
  truncation?: TruncationResult;
  errors: ScraplingFetchResult['errors'];
}

export type WebFetchRunner = (options: ScraplingFetchOptions) => Promise<ScraplingFetchResult>;
export type DefuddleConverter = (html: string, url: string) => Promise<string>;
export type SettingsReader = (cwd: string) => WebFetchSettings;

function extensionForMode(mode: ExtractionMode): string {
  if (mode === 'html') return 'html';
  if (mode === 'text') return 'txt';
  return 'md';
}

function formatErrors(errors: ScraplingFetchResult['errors']): string {
  if (errors.length === 0) return 'No Scrapling error details were returned.';
  return errors.map((error) => `- ${error.strategy}: ${error.error}`).join('\n');
}

function formatSuccess(
  result: ScraplingFetchResult,
  content: string,
  options: {
    converter: WebFetchDetails['converter'];
    useDefuddle: boolean;
    scraplingMode?: ExtractionMode;
    fullOutputPath?: string;
  },
): string {
  const header = [
    `URL: ${result.finalUrl ?? result.url}`,
    result.status !== undefined && result.status !== null ? `Status: ${result.status}` : undefined,
    result.strategy ? `Fetcher: ${result.strategy}` : undefined,
    result.strategyReason ? `Strategy: ${result.strategyReason}` : undefined,
    `Mode: ${result.mode}`,
    options.scraplingMode && options.scraplingMode !== result.mode
      ? `Scrapling-Mode: ${options.scraplingMode}`
      : undefined,
    `Converter: ${options.converter}`,
    result.contentLength !== undefined ? `Content-Length: ${result.contentLength}` : undefined,
    options.fullOutputPath ? `Full output: ${options.fullOutputPath}` : undefined,
  ].filter((line): line is string => Boolean(line));

  return `${header.join('\n')}\n\n${content}`;
}

function formatFailure(result: ScraplingFetchResult): string {
  const stderr = result.stderr?.trim();
  const hint = [
    'Scrapling fetch failed.',
    '',
    'Tried fetcher strategy order from the Scrapling guide. Make sure Scrapling is available via:',
    '',
    '  scrapling shell -L warning -c "print(\'ok\')"',
    '',
    'Errors:',
    formatErrors(result.errors),
  ];

  if (stderr) {
    hint.push('', 'stderr:', stderr.slice(0, 4000));
  }

  return hint.join('\n');
}

function emitToolProgress(
  onUpdate: AgentToolUpdateCallback<WebFetchDetails> | undefined,
  params: WebFetchInput,
  details: WebFetchDetails,
) {
  onUpdate?.({
    content: [
      {
        type: 'text' as const,
        text: `webfetch ${params.url}\n${details.message ?? details.phase ?? 'running'}`,
      },
    ],
    details,
  });
}

function formatPipeline(details: WebFetchDetails): string {
  if (details.mode === 'markdown') {
    return details.converter === 'defuddle' ? 'markdown via defuddle' : 'markdown via scrapling';
  }
  return `${details.mode} via scrapling`;
}

function formatFailedAttempts(count: number): string | undefined {
  if (count === 0) return undefined;
  return `${count} ${count === 1 ? 'attempt' : 'attempts'}`;
}

function formatRenderSummary(details: WebFetchDetails, theme: any): string {
  if (details.phase && details.phase !== 'done') {
    const phase =
      details.phase === 'failed'
        ? theme.fg('warning', details.phase)
        : theme.fg('accent', details.phase);
    const cli = theme.fg('customMessageLabel', 'scrapling');
    const strategy = details.currentStrategy ? theme.fg('dim', ` ${details.currentStrategy}`) : '';
    return `${phase}: ${cli}${strategy}`;
  }

  const status =
    details.errors.length > 0 && !details.strategy
      ? theme.fg('error', 'failed')
      : theme.fg('success', 'done');
  const pieces = [
    details.strategy,
    formatPipeline(details),
    details.truncation?.truncated ? 'truncated' : undefined,
    formatFailedAttempts(details.errors.length),
  ].filter(Boolean);

  return pieces.length > 0 ? `${status} ${theme.fg('dim', pieces.join(' | '))}` : status;
}

function formatTreeLines(lines: string[], theme: any): string {
  return lines
    .map((line, index) => {
      const branch = index === lines.length - 1 ? '└─ ' : '├─ ';
      return theme.fg('dim', branch) + line;
    })
    .join('\n');
}

function renderOutputLines(output: string, theme: any): string[] {
  return output.split('\n').map((line) => theme.fg('toolOutput', line));
}

function getCollapsedPreviewOutput(output: string): string {
  if (!output.startsWith('URL: ')) return output;
  const bodyStart = output.indexOf('\n\n');
  if (bodyStart === -1) return output;
  return output.slice(bodyStart + 2);
}

function renderWebFetchResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: any,
): Text {
  const details = result.details as WebFetchDetails | undefined;
  if (!details) return new Text(theme.fg('error', 'webfetch: missing details'), 0, 0);

  const summaryLines = [formatRenderSummary(details, theme)];
  const output = result.content[0]?.type === 'text' ? (result.content[0].text ?? '') : '';

  if (options.isPartial) {
    if (details.errors.length > 0) {
      const last = details.errors.at(-1);
      if (last) summaryLines.push(theme.fg('warning', `${last.strategy}: ${last.error}`));
    }
    return new Text(formatTreeLines(summaryLines, theme), 0, 0);
  }

  const size = details.contentLength !== undefined ? formatSize(details.contentLength) : undefined;
  if (size) summaryLines[0] += theme.fg('muted', ` | ${size}`);

  let text = formatTreeLines(summaryLines, theme);

  if (!options.expanded) {
    if (output) {
      const previewOutput = getCollapsedPreviewOutput(output);
      const rawLines = previewOutput.split('\n');
      const renderedLines = renderOutputLines(previewOutput, theme);
      const maxPreviewLines = 20;
      const previewLines = renderedLines.slice(0, maxPreviewLines);
      const remaining = rawLines.length - previewLines.length;
      text += `\n\n${previewLines.join('\n')}`;

      if (remaining > 0) {
        text += theme.fg('muted', `\n... (${remaining} more lines, ctrl+o to expand)`);
      }
    }

    return new Text(text, 0, 0);
  }

  if (output) text += `\n\n${renderOutputLines(output, theme).join('\n')}`;
  return new Text(text, 0, 0);
}

export function createWebFetchTool(
  runner: WebFetchRunner = runScraplingFetch,
  settingsReader: SettingsReader = readWebFetchSettings,
  defuddleConverter: DefuddleConverter = convertHtmlWithDefuddle,
) {
  return {
    name: 'webfetch',
    label: 'Web Fetch',
    description:
      'Inspect a user-provided HTTP(S) URL and fetch its content with Scrapling. The tool chooses a Scrapling fetcher strategy based on the URL, then extracts cleaned markdown/html/text content with Scrapling Convertor.',
    promptSnippet:
      'Fetch and clean information from HTTP(S) URLs using Scrapling fetcher strategies.',
    promptGuidelines: [
      'Use webfetch when the user provides a URL and asks to inspect, fetch, read, summarize, or analyze its content.',
      'webfetch uses Scrapling through `scrapling shell`; if Scrapling is unavailable, report the tool error and do not invent fetched content.',
      'webfetch defaults to markdown extraction. Use mode="html" only when raw cleaned HTML is needed, and mode="text" for plain text.',
      'When settings.json has { "webfetch": { "useDefuddle": true } }, webfetch asks Scrapling for cleaned HTML and converts it to Markdown with Defuddle for markdown output.',
    ],
    parameters: WebFetchParams,

    async execute(
      _toolCallId: string,
      params: WebFetchInput,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<WebFetchDetails> | undefined,
      ctx: { cwd: string },
    ) {
      const mode = normalizeMode(params.mode ?? DEFAULT_MODE);
      const settings = settingsReader(ctx.cwd);
      const useDefuddle = settings.useDefuddle && mode === 'markdown';
      const scraplingMode: ExtractionMode = useDefuddle ? 'html' : mode;
      let converter: WebFetchDetails['converter'] = 'scrapling';
      emitToolProgress(onUpdate, params, {
        url: params.url,
        mode,
        scraplingMode,
        converter,
        useDefuddle,
        phase: 'starting',
        message: 'starting webfetch',
        errors: [],
      });
      let result = await runner({
        url: params.url,
        mode: scraplingMode,
        cwd: ctx.cwd,
        signal,
        onProgress: (progress) => {
          emitToolProgress(onUpdate, params, {
            url: params.url,
            mode,
            scraplingMode,
            converter,
            useDefuddle,
            phase: progress.phase,
            currentStrategy: progress.strategy,
            message: progress.message,
            errors: progress.errors ?? [],
          });
        },
      });

      if (!result.ok || !result.content) {
        return {
          content: [{ type: 'text' as const, text: formatFailure(result) }],
          details: {
            url: result.url,
            finalUrl: result.finalUrl,
            status: result.status,
            strategy: result.strategy,
            strategyReason: result.strategyReason,
            mode,
            scraplingMode,
            converter,
            useDefuddle,
            contentLength: result.contentLength,
            errors: result.errors,
          } as WebFetchDetails,
          isError: true as const,
        };
      }

      if (useDefuddle) {
        emitToolProgress(onUpdate, params, {
          url: result.url,
          finalUrl: result.finalUrl,
          status: result.status,
          strategy: result.strategy,
          strategyReason: result.strategyReason,
          mode,
          scraplingMode,
          converter: 'defuddle',
          useDefuddle,
          phase: 'converting',
          currentStrategy: result.strategy,
          message: 'converting cleaned HTML with Defuddle',
          contentLength: result.contentLength,
          errors: result.errors,
        });
        try {
          const content = await defuddleConverter(result.content, result.finalUrl ?? result.url);
          converter = 'defuddle';
          result = {
            ...result,
            mode: 'markdown',
            content,
            contentLength: content.length,
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const failedResult: ScraplingFetchResult = {
            ...result,
            ok: false,
            mode: 'markdown',
            errors: [...result.errors, { strategy: 'defuddle', error: errorMessage }],
          };
          return {
            content: [{ type: 'text' as const, text: formatFailure(failedResult) }],
            details: {
              url: failedResult.url,
              finalUrl: failedResult.finalUrl,
              status: failedResult.status,
              strategy: failedResult.strategy,
              strategyReason: failedResult.strategyReason,
              mode: 'markdown',
              scraplingMode,
              converter: 'defuddle',
              useDefuddle,
              contentLength: failedResult.contentLength,
              errors: failedResult.errors,
            } as WebFetchDetails,
            isError: true as const,
          };
        }
      }

      if (typeof result.content !== 'string') {
        return {
          content: [{ type: 'text' as const, text: formatFailure(result) }],
          details: {
            url: result.url,
            finalUrl: result.finalUrl,
            status: result.status,
            strategy: result.strategy,
            strategyReason: result.strategyReason,
            mode: result.mode,
            scraplingMode,
            converter,
            useDefuddle,
            contentLength: result.contentLength,
            errors: result.errors,
          } as WebFetchDetails,
          isError: true as const,
        };
      }

      const resultContent = result.content;
      const truncation = truncateHead(resultContent, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let content = truncation.content;
      let fullOutputPath: string | undefined;

      if (truncation.truncated) {
        fullOutputPath = await persistFullContent(resultContent, extensionForMode(result.mode));
        content += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: formatSuccess(result, content, {
              converter,
              useDefuddle,
              scraplingMode,
              fullOutputPath,
            }),
          },
        ],
        details: {
          url: result.url,
          finalUrl: result.finalUrl,
          status: result.status,
          strategy: result.strategy,
          strategyReason: result.strategyReason,
          mode: result.mode,
          scraplingMode,
          converter,
          useDefuddle,
          contentLength: result.contentLength,
          fullOutputPath,
          truncation,
          phase: 'done',
          errors: result.errors,
        } as WebFetchDetails,
      };
    },

    renderCall(args: WebFetchInput, theme: any) {
      let text = theme.fg('toolTitle', theme.bold('webfetch '));
      text += theme.fg('accent', args.url);
      if (args.mode) text += theme.fg('dim', ` (${args.mode})`);
      return new Text(text, 0, 0);
    },

    renderResult(
      result: { content: Array<{ type: string; text?: string }>; details?: unknown },
      options: { expanded: boolean; isPartial: boolean },
      theme: any,
    ) {
      return renderWebFetchResult(result, options, theme);
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(createWebFetchTool());
}

import type { Api, Model, ModelThinkingLevel, UserMessage } from '@earendil-works/pi-ai';
import { clampThinkingLevel, complete } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ModelRegistry } from '@earendil-works/pi-coding-agent';
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

import { convertHtmlWithDefuddle } from './cli/defuddle.js';
import { isGitHubUrl, runGhFetch } from './cli/gh.js';
import { runScraplingFetch, strategiesForUrl } from './cli/scrapling.js';
import { isYouTubeUrl, runYtDlpFetch } from './cli/ytdlp.js';
import { normalizeMode, persistFullContent, readWebFetchSettings } from './shared.js';
import {
  DEFAULT_MODE,
  type ExtractionMode,
  type ScraplingFetchOptions,
  type ScraplingFetchResult,
  type WebFetchProgress,
  type WebFetchSettings,
} from './types.js';

const WebFetchParams = Type.Object({
  url: Type.String({
    description: 'HTTP or HTTPS URL to inspect and fetch.',
  }),
  mode: Type.Optional(
    Type.Union([
      Type.Literal('markdown'),
      Type.Literal('html'),
      Type.Literal('text'),
      Type.Literal('json'),
    ]),
  ),
});

export interface WebFetchInput {
  url: string;
  mode?: ExtractionMode;
}

type WebFetchErrorDetail = { strategy: string; error: string };
type WebFetchProgressUpdate = Omit<WebFetchProgress, 'strategy' | 'errors'> & {
  strategy?: string;
  errors?: WebFetchErrorDetail[];
};
type WebFetchResultLike = Omit<ScraplingFetchResult, 'strategy' | 'errors'> & {
  strategy?: string;
  errors: WebFetchErrorDetail[];
};
type WebFetchOptionsLike = Omit<ScraplingFetchOptions, 'onProgress'> & {
  onProgress?: (progress: WebFetchProgressUpdate) => void;
};

export interface WebFetchDetails {
  url: string;
  finalUrl?: string;
  status?: number | string | null;
  strategy?: string;
  strategyReason?: string;
  mode: ExtractionMode;
  scraplingMode?: ExtractionMode;
  converter: 'scrapling' | 'defuddle' | 'gh' | 'yt-dlp';
  useDefuddle: boolean;
  usedCookies?: boolean;
  phase?: WebFetchProgress['phase'] | 'converting' | 'judging' | 'done';
  currentStrategy?: string;
  message?: string;
  contentLength?: number;
  fullOutputPath?: string;
  truncation?: TruncationResult;
  errors: WebFetchErrorDetail[];
}

export type WebFetchRunner = (options: WebFetchOptionsLike) => Promise<WebFetchResultLike>;
export type DefuddleConverter = (html: string, url: string) => Promise<string>;
export type SettingsReader = (cwd: string) => WebFetchSettings;

interface WebFetchExecutionContext {
  cwd: string;
  model?: Model<Api>;
  modelRegistry?: ModelRegistry;
}

interface QualityJudgeInput {
  url: string;
  finalUrl?: string;
  strategy?: string;
  content: string;
  settings: WebFetchSettings;
  ctx: WebFetchExecutionContext;
  signal?: AbortSignal;
}

interface QualityJudgeDecision {
  usable: boolean;
  reason: string;
}

export type QualityJudge = (input: QualityJudgeInput) => Promise<QualityJudgeDecision | undefined>;

function extensionForMode(mode: ExtractionMode): string {
  if (mode === 'html') return 'html';
  if (mode === 'text') return 'txt';
  if (mode === 'json') return 'json';
  return 'md';
}

function formatErrors(errors: WebFetchErrorDetail[]): string {
  if (errors.length === 0) return 'No fetch error details were returned.';
  return errors.map((error) => `- ${error.strategy}: ${error.error}`).join('\n');
}

function formatSuccess(
  result: WebFetchResultLike,
  content: string,
  options: {
    converter: WebFetchDetails['converter'];
    useDefuddle: boolean;
    scraplingMode?: ExtractionMode;
    fullOutputPath?: string;
  },
): string {
  if (result.mode === 'json') return content;

  const header = [
    `URL: ${result.finalUrl ?? result.url}`,
    result.status !== undefined && result.status !== null ? `Status: ${result.status}` : undefined,
    result.strategy ? `Fetcher: ${result.strategy}` : undefined,
    result.strategyReason ? `Strategy: ${result.strategyReason}` : undefined,
    `Mode: ${result.mode}`,
    options.converter !== 'gh' && options.scraplingMode && options.scraplingMode !== result.mode
      ? `Scrapling-Mode: ${options.scraplingMode}`
      : undefined,
    `Converter: ${options.converter}`,
    result.contentLength !== undefined ? `Content-Length: ${result.contentLength}` : undefined,
    options.fullOutputPath ? `Full output: ${options.fullOutputPath}` : undefined,
  ].filter((line): line is string => Boolean(line));

  return `${header.join('\n')}\n\n${content}`;
}

function formatGitHubFailureHint(stderr: string | undefined): string {
  if (stderr?.includes('HTTP 404')) {
    return 'GitHub URL matched, but GitHub returned HTTP 404. Check that the owner/repo, branch/ref, and path exist.';
  }

  return 'GitHub URL matched. Make sure GitHub CLI is installed and authenticated via `gh auth status`.';
}

function formatYouTubeFailureHint(stderr: string | undefined): string {
  if (stderr && /sign in to confirm/i.test(stderr)) {
    return 'YouTube URL matched, but YouTube requires browser cookies to verify you are not a bot. Make sure you are signed into YouTube in Chrome. If you use another browser, configure `webfetch.ytdlpCookiesFromBrowser` in pi settings.';
  }
  if (stderr && /chrome/i.test(stderr)) {
    return 'YouTube URL matched. yt-dlp tried to use Chrome cookies but failed. Make sure Chrome is installed and you are signed into YouTube in Chrome, or configure `webfetch.ytdlpCookiesFromBrowser` in pi settings to another browser.';
  }
  return 'YouTube URL matched. Make sure yt-dlp is installed and available in PATH.';
}

function formatFailure(result: WebFetchResultLike): string {
  const stderr = result.stderr?.trim();
  const isGh = isGitHubUrl(result.url);
  const isYouTube = isYouTubeUrl(result.url);
  const hint = [
    'Web fetch failed.',
    '',
    isGh
      ? formatGitHubFailureHint(stderr)
      : isYouTube
        ? formatYouTubeFailureHint(stderr)
        : 'Fallback fetch uses Scrapling + Defuddle. Make sure Scrapling is available via `scrapling shell -L warning -c "print(\'ok\')"`.',
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
  if (details.converter === 'gh') return `${details.mode} via gh`;
  if (details.converter === 'yt-dlp') return `${details.mode} via yt-dlp`;
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
    const cliName =
      details.converter === 'gh' ? 'gh' : details.converter === 'yt-dlp' ? 'yt-dlp' : 'scrapling';
    const cli = theme.fg('customMessageLabel', cliName);
    const strategy =
      details.currentStrategy && details.currentStrategy !== cliName
        ? theme.fg('dim', ` ${details.currentStrategy}`)
        : '';
    const message = details.message ? theme.fg('dim', ` — ${details.message}`) : '';
    return `${phase}: ${cli}${strategy}${message}`;
  }

  const status =
    details.errors.length > 0 && !details.strategy
      ? theme.fg('error', 'failed')
      : theme.fg('success', 'done');
  const pieces = [
    details.strategy,
    formatPipeline(details),
    details.usedCookies ? 'cookies' : undefined,
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

const QUALITY_JUDGE_SYSTEM_PROMPT = `You judge whether fetched web content is usable for answering a user's request.
Return only JSON with this shape: {"usable": boolean, "reason": string}.
Mark usable=false when the content is mainly boilerplate, navigation, footer/legal text, a captcha/challenge/anti-bot page, an error page, or unrelated to the requested URL. Keep reason concise.`;

function parseModelRef(ref: string): { provider: string; modelId: string } | undefined {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

function resolveQualityJudgeModel(
  settings: WebFetchSettings,
  ctx: WebFetchExecutionContext,
): Model<Api> | undefined {
  if (settings.qualityJudgeModel) {
    const ref = parseModelRef(settings.qualityJudgeModel);
    if (!ref) return undefined;
    return ctx.modelRegistry?.find(ref.provider, ref.modelId);
  }

  return ctx.model;
}

function extractTextContent(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content
    .filter((content): content is { type: 'text'; text: string } => content.type === 'text')
    .map((content) => content.text)
    .join('\n');
}

function parseQualityJudgeDecision(raw: string): QualityJudgeDecision | undefined {
  const trimmed = raw.trim();
  const jsonText = trimmed.startsWith('{') ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) return undefined;

  try {
    const parsed = JSON.parse(jsonText) as Partial<QualityJudgeDecision>;
    if (typeof parsed.usable !== 'boolean') return undefined;
    return {
      usable: parsed.usable,
      reason:
        typeof parsed.reason === 'string' && parsed.reason.trim()
          ? parsed.reason.trim()
          : 'no reason',
    };
  } catch {
    return undefined;
  }
}

async function runQualityJudge({
  url,
  finalUrl,
  strategy,
  content,
  settings,
  ctx,
  signal,
}: QualityJudgeInput): Promise<QualityJudgeDecision | undefined> {
  if (!settings.qualityJudge) return undefined;
  if (!ctx.modelRegistry) return undefined;

  const model = resolveQualityJudgeModel(settings, ctx);
  if (!model) return undefined;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return undefined;

  const userMessage: UserMessage = {
    role: 'user',
    timestamp: Date.now(),
    content: [
      {
        type: 'text',
        text: [
          `Requested URL: ${url}`,
          finalUrl ? `Final URL: ${finalUrl}` : undefined,
          strategy ? `Fetch strategy: ${strategy}` : undefined,
          '',
          'Fetched Markdown sample:',
          content.slice(0, 12_000),
        ]
          .filter((line): line is string => line !== undefined)
          .join('\n'),
      },
    ],
  };

  try {
    const requestedThinking = settings.qualityJudgeThinkLevel ?? 'off';
    const clampedThinking = clampThinkingLevel(model, requestedThinking as ModelThinkingLevel);
    const response = await complete(
      model,
      { systemPrompt: QUALITY_JUDGE_SYSTEM_PROMPT, messages: [userMessage] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal,
        maxTokens: 200,
        ...(clampedThinking !== 'off' ? { reasoning: clampedThinking } : {}),
      },
    );

    if (response.stopReason === 'aborted') return undefined;
    return parseQualityJudgeDecision(extractTextContent(response));
  } catch {
    return undefined;
  }
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

async function runWithDefuddlePerStrategy(options: {
  runner: WebFetchRunner;
  defuddleConverter: DefuddleConverter;
  qualityJudge: QualityJudge;
  params: WebFetchInput;
  settings: WebFetchSettings;
  ctx: WebFetchExecutionContext;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<WebFetchDetails>;
}): Promise<WebFetchResultLike> {
  const strategies = strategiesForUrl(options.params.url);
  const accumulatedErrors: WebFetchErrorDetail[] = [];
  let lastResult: WebFetchResultLike | undefined;

  for (const strategy of strategies) {
    const result = await options.runner({
      url: options.params.url,
      mode: 'html',
      cwd: options.ctx.cwd,
      signal: options.signal,
      strategies: [strategy],
      onProgress: (progress) => {
        emitToolProgress(options.onUpdate, options.params, {
          url: options.params.url,
          mode: 'markdown',
          scraplingMode: 'html',
          converter: 'scrapling',
          useDefuddle: true,
          phase: progress.phase,
          currentStrategy: progress.strategy,
          message: progress.message,
          errors: [...accumulatedErrors, ...(progress.errors ?? [])],
        });
      },
    });

    lastResult = result;

    if (!result.ok || !result.content) {
      accumulatedErrors.push(...result.errors);
      continue;
    }

    emitToolProgress(options.onUpdate, options.params, {
      url: result.url,
      finalUrl: result.finalUrl,
      status: result.status,
      strategy: result.strategy,
      strategyReason: result.strategyReason,
      mode: 'markdown',
      scraplingMode: 'html',
      converter: 'defuddle',
      useDefuddle: true,
      phase: 'converting',
      currentStrategy: result.strategy,
      message: `converting cleaned HTML with Defuddle (${result.strategy ?? strategy})`,
      contentLength: result.contentLength,
      errors: accumulatedErrors,
    });

    try {
      const content = await options.defuddleConverter(
        result.content,
        result.finalUrl ?? result.url,
      );
      if (options.settings.qualityJudge) {
        emitToolProgress(options.onUpdate, options.params, {
          url: result.url,
          finalUrl: result.finalUrl,
          status: result.status,
          strategy: result.strategy,
          strategyReason: result.strategyReason,
          mode: 'markdown',
          scraplingMode: 'html',
          converter: 'defuddle',
          useDefuddle: true,
          phase: 'judging',
          currentStrategy: result.strategy,
          message: `judging content quality (${result.strategy ?? strategy})`,
          contentLength: content.length,
          errors: accumulatedErrors,
        });

        const judgement = await options
          .qualityJudge({
            url: options.params.url,
            finalUrl: result.finalUrl,
            strategy: result.strategy ?? strategy,
            content,
            settings: options.settings,
            ctx: options.ctx,
            signal: options.signal,
          })
          .catch(() => undefined);

        if (judgement && !judgement.usable) {
          const strategyName = result.strategy ?? strategy;
          accumulatedErrors.push(...result.errors, {
            strategy: strategyName,
            error: `quality-judge: ${judgement.reason}`,
          });
          lastResult = {
            ...result,
            ok: false,
            mode: 'markdown',
            content,
            contentLength: content.length,
            errors: accumulatedErrors,
          };
          emitToolProgress(options.onUpdate, options.params, {
            url: result.url,
            finalUrl: result.finalUrl,
            status: result.status,
            strategy: result.strategy,
            strategyReason: result.strategyReason,
            mode: 'markdown',
            scraplingMode: 'html',
            converter: 'defuddle',
            useDefuddle: true,
            phase: 'failed',
            currentStrategy: strategyName,
            message: `${strategyName} rejected by quality judge: ${judgement.reason}`,
            contentLength: content.length,
            errors: accumulatedErrors,
          });
          continue;
        }
      }

      return {
        ...result,
        ok: true,
        mode: 'markdown',
        content,
        contentLength: content.length,
        errors: [...accumulatedErrors, ...result.errors],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const strategyName = result.strategy ?? strategy;
      accumulatedErrors.push(...result.errors, {
        strategy: strategyName,
        error: `defuddle: ${errorMessage}`,
      });
      lastResult = {
        ...result,
        ok: false,
        mode: 'markdown',
        errors: accumulatedErrors,
      };
      emitToolProgress(options.onUpdate, options.params, {
        url: result.url,
        finalUrl: result.finalUrl,
        status: result.status,
        strategy: result.strategy,
        strategyReason: result.strategyReason,
        mode: 'markdown',
        scraplingMode: 'html',
        converter: 'defuddle',
        useDefuddle: true,
        phase: 'failed',
        currentStrategy: strategyName,
        message: `${strategyName} defuddle failed: ${errorMessage}`,
        contentLength: result.contentLength,
        errors: accumulatedErrors,
      });
    }
  }

  return {
    ...(lastResult ?? {
      ok: false,
      url: options.params.url,
      mode: 'markdown' as const,
      errors: [] as WebFetchErrorDetail[],
    }),
    ok: false,
    mode: 'markdown',
    content: undefined,
    errors: accumulatedErrors,
  };
}

export function createWebFetchTool(
  runner: WebFetchRunner = runScraplingFetch,
  settingsReader: SettingsReader = readWebFetchSettings,
  defuddleConverter: DefuddleConverter = convertHtmlWithDefuddle,
  ghRunner: WebFetchRunner = runGhFetch,
  qualityJudge: QualityJudge = runQualityJudge,
  ytDlpRunner: WebFetchRunner = runYtDlpFetch,
) {
  return {
    name: 'webfetch',
    label: 'Web Fetch',
    description:
      'Inspect a user-provided HTTP(S) URL. GitHub URLs are fetched with gh, YouTube URLs with yt-dlp, and all other URLs fall back to Scrapling plus Defuddle for readable markdown.',
    promptSnippet: 'Fetch and clean information from HTTP(S) URLs using gh, yt-dlp, or Scrapling.',
    promptGuidelines: [
      'Use webfetch when the user provides a URL and asks to inspect, fetch, read, summarize, or analyze its content.',
      'webfetch routes github.com URLs through `gh`; if GitHub CLI is unavailable or unauthenticated, report the tool error and do not invent fetched content.',
      'webfetch routes YouTube URLs through `yt-dlp`; if yt-dlp is unavailable, report the tool error and do not invent fetched content.',
      'For non-GitHub and non-YouTube URLs, webfetch falls back to Scrapling through `scrapling shell`; if Scrapling is unavailable, report the tool error and do not invent fetched content.',
      'webfetch defaults to markdown extraction. Use mode="html" only when raw cleaned HTML is needed, mode="text" for plain text, and mode="json" for YouTube yt-dlp metadata.',
      'For fallback markdown, webfetch asks Scrapling for cleaned HTML and converts it to Markdown with Defuddle by default. Set { "webfetch": { "useDefuddle": false } } to skip Defuddle.',
      'If webfetch output is truncated and includes a Full output path, use the read tool on that path when complete content is needed.',
      'Evaluate fetched content quality before relying on it; if it looks like boilerplate, a captcha/challenge page, or unrelated content, tell the user instead of treating it as authoritative.',
      'Optional setting { "webfetch": { "qualityJudge": true, "qualityJudgeModel": "provider/model", "qualityJudgeThinkLevel": "off" } } asks an LLM to reject unusable content before trying the next Scrapling strategy.',
    ],
    parameters: WebFetchParams,

    async execute(
      _toolCallId: string,
      params: WebFetchInput,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<WebFetchDetails> | undefined,
      ctx: WebFetchExecutionContext,
    ) {
      const mode = normalizeMode(params.mode ?? DEFAULT_MODE);
      const selectedRunner =
        runner === runScraplingFetch && isGitHubUrl(params.url)
          ? ghRunner
          : runner === runScraplingFetch && isYouTubeUrl(params.url)
            ? ytDlpRunner
            : runner;
      const settings = settingsReader(ctx.cwd);
      const useDefuddle =
        selectedRunner !== ghRunner &&
        selectedRunner !== ytDlpRunner &&
        mode === 'markdown' &&
        (settings.useDefuddle ?? selectedRunner === runScraplingFetch);
      const scraplingMode: ExtractionMode = useDefuddle ? 'html' : mode;
      const detailScraplingMode =
        selectedRunner === ghRunner || selectedRunner === ytDlpRunner ? undefined : scraplingMode;
      let converter: WebFetchDetails['converter'] =
        selectedRunner === ghRunner
          ? 'gh'
          : selectedRunner === ytDlpRunner
            ? 'yt-dlp'
            : 'scrapling';
      emitToolProgress(onUpdate, params, {
        url: params.url,
        mode,
        scraplingMode: detailScraplingMode,
        converter,
        useDefuddle,
        phase: 'starting',
        message: 'starting webfetch',
        errors: [],
      });
      let result: WebFetchResultLike;

      if (useDefuddle) {
        converter = 'defuddle';
        result = await runWithDefuddlePerStrategy({
          runner: selectedRunner,
          defuddleConverter,
          qualityJudge,
          params,
          settings,
          ctx,
          signal,
          onUpdate,
        });
      } else {
        result = await selectedRunner({
          url: params.url,
          mode: selectedRunner === ghRunner ? mode : scraplingMode,
          cwd: ctx.cwd,
          signal,
          onProgress: (progress) => {
            emitToolProgress(onUpdate, params, {
              url: params.url,
              mode,
              scraplingMode: detailScraplingMode,
              converter,
              useDefuddle,
              phase: progress.phase,
              currentStrategy: progress.strategy,
              message: progress.message,
              errors: progress.errors ?? [],
            });
          },
        });
      }

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
            scraplingMode: detailScraplingMode,
            converter,
            useDefuddle,
            contentLength: result.contentLength,
            phase: 'failed',
            ...(result.strategy ? { currentStrategy: result.strategy } : {}),
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
              scraplingMode: detailScraplingMode,
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
          scraplingMode: detailScraplingMode,
          converter,
          useDefuddle,
          usedCookies: result.usedCookies,
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

function isFailedWebFetchDetails(details: unknown): details is WebFetchDetails {
  return Boolean(
    details &&
    typeof details === 'object' &&
    (details as Partial<WebFetchDetails>).phase === 'failed',
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(createWebFetchTool());

  pi.on('tool_result', (event) => {
    if (event.toolName !== 'webfetch') return;
    if (!isFailedWebFetchDetails(event.details)) return;
    return { isError: true };
  });
}

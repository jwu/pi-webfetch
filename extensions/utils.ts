import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';

export const DEFAULT_MODE = 'markdown' as const;
export const SCRAPLING_COMMAND_TIMEOUT_MS = 180_000;

export type ExtractionMode = 'markdown' | 'html' | 'text';
export type FetchStrategy = 'fetcher' | 'dynamic' | 'stealthy';

export interface SiteStrategyMapping {
  domains: string[];
  strategies: FetchStrategy[];
  reason: string;
}

export const DEFAULT_STRATEGIES: FetchStrategy[] = ['fetcher', 'dynamic', 'stealthy'];

export const SITE_STRATEGY_MAPPINGS: SiteStrategyMapping[] = [
  {
    domains: ['shadertoy.com'],
    strategies: ['stealthy'],
    reason: 'Shadertoy is commonly protected by Cloudflare; start with StealthyFetcher.',
  },
  {
    domains: ['x.com', 'twitter.com'],
    strategies: ['stealthy'],
    reason: 'Twitter/X is a SPA and often needs StealthyFetcher plus login-state support.',
  },
];

export interface ScraplingError {
  strategy: FetchStrategy | 'defuddle';
  error: string;
}

export interface WebFetchProgress {
  phase: 'starting' | 'trying' | 'extracting' | 'failed' | 'success';
  strategy?: FetchStrategy;
  message: string;
  errors?: ScraplingError[];
}

export interface WebFetchSettings {
  useDefuddle: boolean;
}

export interface ScraplingFetchResult {
  ok: boolean;
  url: string;
  finalUrl?: string;
  status?: number | string | null;
  strategy?: FetchStrategy;
  strategyReason?: string;
  mode: ExtractionMode;
  content?: string;
  contentLength?: number;
  outputPath?: string;
  errors: ScraplingError[];
  stdout?: string;
  stderr?: string;
}

export interface ScraplingFetchOptions {
  url: string;
  mode?: ExtractionMode;
  cwd: string;
  signal?: AbortSignal;
  onProgress?: (progress: WebFetchProgress) => void;
}

export interface CompletedProcess {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

function readSettingsFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function getGlobalSettingsPath(): string {
  return join(process.env.HOME ?? homedir(), '.pi', 'agent', 'settings.json');
}

function getProjectSettingsPath(cwd: string): string {
  return join(cwd, '.pi', 'settings.json');
}

function extractUseDefuddle(settings: Record<string, unknown>): boolean | undefined {
  const dotted = settings['webfetch.useDefuddle'];
  if (typeof dotted === 'boolean') return dotted;

  const webfetch = settings.webfetch;
  if (webfetch && typeof webfetch === 'object' && !Array.isArray(webfetch)) {
    const value = (webfetch as Record<string, unknown>).useDefuddle;
    if (typeof value === 'boolean') return value;
  }

  return undefined;
}

export function readWebFetchSettings(cwd: string): WebFetchSettings {
  const projectUseDefuddle = extractUseDefuddle(readSettingsFile(getProjectSettingsPath(cwd)));
  if (projectUseDefuddle !== undefined) return { useDefuddle: projectUseDefuddle };

  const globalUseDefuddle = extractUseDefuddle(readSettingsFile(getGlobalSettingsPath()));
  if (globalUseDefuddle !== undefined) return { useDefuddle: globalUseDefuddle };

  return { useDefuddle: false };
}

export function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error('URL is required.');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `Unsupported URL protocol "${url.protocol}". Only http:// and https:// are allowed.`,
    );
  }

  url.hash = '';
  return url.href;
}

export function normalizeMode(mode: unknown): ExtractionMode {
  if (mode === 'html' || mode === 'text' || mode === 'markdown') return mode;
  return DEFAULT_MODE;
}

function hostnameOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function siteStrategyMappingForUrl(url: string): SiteStrategyMapping | undefined {
  const hostname = hostnameOf(url);
  return SITE_STRATEGY_MAPPINGS.find((mapping) =>
    mapping.domains.some((domain) => domainMatches(hostname, domain)),
  );
}

export function strategiesForUrl(url: string): FetchStrategy[] {
  return siteStrategyMappingForUrl(url)?.strategies ?? DEFAULT_STRATEGIES;
}

export function strategyReasonForUrl(url: string): string {
  return (
    siteStrategyMappingForUrl(url)?.reason ??
    'No site-specific mapping matched; try Fetcher, then DynamicFetcher, then StealthyFetcher until content is extracted.'
  );
}

export function buildScraplingShellCode(): string {
  return String.raw`
import json
import os
from scrapling.fetchers import Fetcher, DynamicFetcher, StealthyFetcher
from scrapling.core.shell import Convertor

url = os.environ['PI_WEBFETCH_URL']
mode = os.environ.get('PI_WEBFETCH_MODE', 'markdown')
strategies = json.loads(os.environ.get('PI_WEBFETCH_STRATEGIES', '["fetcher", "dynamic", "stealthy"]'))
outfile = os.environ['PI_WEBFETCH_OUTPUT']
progress_prefix = '__PI_WEBFETCH_PROGRESS__'


def emit_progress(payload):
    print(progress_prefix + json.dumps(payload, ensure_ascii=True), flush=True)


def extract(page, extraction_mode):
    return ''.join(Convertor._extract_content(page, extraction_type=extraction_mode, main_content_only=True))


def get_status(page):
    status = getattr(page, 'status', None)
    try:
        return int(status) if status is not None else None
    except Exception:
        return status


def get_url(page):
    return getattr(page, 'url', None) or url


def fetch_with_strategy(strategy):
    if strategy == 'fetcher':
        return Fetcher.get(url)
    if strategy == 'dynamic':
        return DynamicFetcher.fetch(url, network_idle=True, wait=3000)
    if strategy == 'stealthy':
        return StealthyFetcher.fetch(url, network_idle=True, wait=3000)
    raise RuntimeError(f'Unknown strategy: {strategy}')


def write_result(payload):
    with open(outfile, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False)


errors = []
emit_progress({
    'phase': 'starting',
    'message': 'starting scrapling shell',
})

for strategy in strategies:
    try:
        emit_progress({
            'phase': 'trying',
            'strategy': strategy,
            'message': f'trying {strategy}',
            'errors': errors,
        })
        page = fetch_with_strategy(strategy)
        status = get_status(page)
        if isinstance(status, int) and status >= 400:
            raise RuntimeError(f'HTTP status {status}')

        emit_progress({
            'phase': 'extracting',
            'strategy': strategy,
            'message': f'extracting {mode} with {strategy}',
            'errors': errors,
        })
        content = extract(page, mode)
        if not content or not content.strip():
            raise RuntimeError('empty extracted content')

        emit_progress({
            'phase': 'success',
            'strategy': strategy,
            'message': f'{strategy} succeeded',
            'errors': errors,
        })
        write_result({
            'ok': True,
            'url': url,
            'finalUrl': get_url(page),
            'status': status,
            'strategy': strategy,
            'mode': mode,
            'content': content,
            'contentLength': len(content),
            'errors': errors,
        })
        break
    except Exception as exc:
        errors.append({
            'strategy': strategy,
            'error': str(exc),
        })
        emit_progress({
            'phase': 'failed',
            'strategy': strategy,
            'message': f'{strategy} failed: {exc}',
            'errors': errors,
        })
else:
    write_result({
        'ok': False,
        'url': url,
        'mode': mode,
        'errors': errors,
    })
`;
}

export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
    onStdoutLine?: (line: string) => void;
  },
): Promise<CompletedProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stdoutLineBuffer = '';

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs ?? SCRAPLING_COMMAND_TIMEOUT_MS);

    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
    };

    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      stdoutLineBuffer += chunk;
      while (true) {
        const newlineIndex = stdoutLineBuffer.indexOf('\n');
        if (newlineIndex === -1) break;
        const line = stdoutLineBuffer.slice(0, newlineIndex).replace(/\r$/, '');
        stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
        options.onStdoutLine?.(line);
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });

    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      if (stdoutLineBuffer) {
        options.onStdoutLine?.(stdoutLineBuffer.replace(/\r$/, ''));
      }
      resolve({ exitCode, stdout, stderr, timedOut, aborted });
    });
  });
}

function parseResultJson(raw: string, fallback: ScraplingFetchResult): ScraplingFetchResult {
  try {
    const parsed = JSON.parse(raw) as Partial<ScraplingFetchResult>;
    return {
      ok: Boolean(parsed.ok),
      url: typeof parsed.url === 'string' ? parsed.url : fallback.url,
      finalUrl: typeof parsed.finalUrl === 'string' ? parsed.finalUrl : undefined,
      status: parsed.status,
      strategy: parsed.strategy,
      strategyReason: fallback.strategyReason,
      mode: normalizeMode(parsed.mode),
      content: typeof parsed.content === 'string' ? parsed.content : undefined,
      contentLength: typeof parsed.contentLength === 'number' ? parsed.contentLength : undefined,
      outputPath: fallback.outputPath,
      errors: Array.isArray(parsed.errors) ? (parsed.errors as ScraplingError[]) : fallback.errors,
    };
  } catch {
    return fallback;
  }
}

const PROGRESS_PREFIX = '__PI_WEBFETCH_PROGRESS__';

function parseProgressLine(line: string): WebFetchProgress | undefined {
  if (!line.startsWith(PROGRESS_PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(line.slice(PROGRESS_PREFIX.length)) as Partial<WebFetchProgress>;
    if (typeof parsed.phase !== 'string' || typeof parsed.message !== 'string') return undefined;
    return {
      phase: parsed.phase as WebFetchProgress['phase'],
      strategy: parsed.strategy,
      message: parsed.message,
      errors: Array.isArray(parsed.errors) ? (parsed.errors as ScraplingError[]) : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function runScraplingFetch(
  options: ScraplingFetchOptions,
): Promise<ScraplingFetchResult> {
  const url = normalizeUrl(options.url);
  const mode = normalizeMode(options.mode);
  const strategies = strategiesForUrl(url);
  const strategyReason = strategyReasonForUrl(url);
  options.onProgress?.({
    phase: 'starting',
    message: `starting scrapling shell (${strategies.join(' → ')})`,
  });
  const tempDir = await mkdtemp(join(tmpdir(), 'pi-webfetch-'));
  const outputPath = join(tempDir, 'scrapling-result.json');

  const fallback: ScraplingFetchResult = {
    ok: false,
    url,
    mode,
    outputPath,
    strategyReason,
    errors: [],
  };

  try {
    const processResult = await runProcess(
      'scrapling',
      ['shell', '-L', 'warning', '-c', buildScraplingShellCode()],
      {
        cwd: options.cwd,
        signal: options.signal,
        timeoutMs: SCRAPLING_COMMAND_TIMEOUT_MS,
        env: {
          PI_WEBFETCH_URL: url,
          PI_WEBFETCH_MODE: mode,
          PI_WEBFETCH_STRATEGIES: JSON.stringify(strategies),
          PI_WEBFETCH_OUTPUT: outputPath,
        },
        onStdoutLine: (line) => {
          const progress = parseProgressLine(line);
          if (progress) options.onProgress?.(progress);
        },
      },
    );

    let fileResult = fallback;
    try {
      fileResult = parseResultJson(await readFile(outputPath, 'utf8'), fallback);
    } catch {
      fileResult = fallback;
    }

    fileResult.stdout = processResult.stdout;
    fileResult.stderr = processResult.stderr;

    if (processResult.aborted) {
      return {
        ...fileResult,
        ok: false,
        errors: [
          ...fileResult.errors,
          { strategy: strategies[0], error: 'scrapling command aborted' },
        ],
      };
    }

    if (processResult.timedOut) {
      return {
        ...fileResult,
        ok: false,
        errors: [
          ...fileResult.errors,
          {
            strategy: strategies[0],
            error: `scrapling command timed out after ${SCRAPLING_COMMAND_TIMEOUT_MS} ms`,
          },
        ],
      };
    }

    if (processResult.exitCode !== 0) {
      return {
        ...fileResult,
        ok: false,
        errors: [
          ...fileResult.errors,
          {
            strategy: strategies[0],
            error: `scrapling command exited with code ${processResult.exitCode}`,
          },
        ],
      };
    }

    return fileResult;
  } catch (error) {
    return {
      ...fallback,
      errors: [
        {
          strategy: strategies[0],
          error: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

export async function convertHtmlWithDefuddle(html: string, url: string): Promise<string> {
  const { Defuddle } = await import('defuddle/node');
  const result = await Defuddle(html, url, {
    markdown: true,
    useAsync: false,
  });
  const markdown = result.contentMarkdown ?? result.content;

  if (!markdown || !markdown.trim()) {
    throw new Error('Defuddle returned empty markdown content.');
  }

  return markdown;
}

export async function persistFullContent(content: string, extension: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'pi-webfetch-'));
  const outputPath = join(tempDir, `content.${extension}`);
  await withFileMutationQueue(outputPath, async () => {
    await writeFile(outputPath, content, 'utf8');
  });
  return outputPath;
}

export async function cleanupScraplingOutput(outputPath: string | undefined): Promise<void> {
  if (!outputPath) return;
  await rm(outputPath, { force: true });
}

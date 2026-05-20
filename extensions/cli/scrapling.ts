import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SITE_STRATEGY_MAPPINGS } from '../sites.js';
import { normalizeMode, normalizeUrl, runProcess } from '../shared.js';
import type {
  FetchStrategy,
  ScraplingError,
  ScraplingFetchOptions,
  ScraplingFetchResult,
  SiteStrategyMapping,
  WebFetchProgress,
} from '../types.js';

export const SCRAPLING_COMMAND_TIMEOUT_MS = 180_000;
export const DEFAULT_STRATEGIES: FetchStrategy[] = ['fetcher', 'dynamic', 'stealthy'];

const DEFAULT_STRATEGY_REASON =
  'No site-specific mapping matched; try Fetcher, then DynamicFetcher, then StealthyFetcher until content is extracted.';

export function siteStrategyMappingForUrl(url: string): SiteStrategyMapping | undefined {
  const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  return SITE_STRATEGY_MAPPINGS.find(({ domains }) =>
    domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`)),
  );
}

export function strategiesForUrl(url: string): FetchStrategy[] {
  return siteStrategyMappingForUrl(url)?.strategies ?? DEFAULT_STRATEGIES;
}

export function strategyReasonForUrl(url: string): string {
  return siteStrategyMappingForUrl(url)?.reason ?? DEFAULT_STRATEGY_REASON;
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

function parseResultJson(raw: string, fallback: ScraplingFetchResult): ScraplingFetchResult {
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
}

async function readScraplingResult(
  outputPath: string,
  fallback: ScraplingFetchResult,
): Promise<ScraplingFetchResult> {
  try {
    return parseResultJson(await readFile(outputPath, 'utf8'), fallback);
  } catch {
    return fallback;
  }
}

function withScraplingError(
  result: ScraplingFetchResult,
  strategy: FetchStrategy,
  error: string,
): ScraplingFetchResult {
  return {
    ...result,
    ok: false,
    errors: [...result.errors, { strategy, error }],
  };
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

    const fileResult = {
      ...(await readScraplingResult(outputPath, fallback)),
      stdout: processResult.stdout,
      stderr: processResult.stderr,
    };
    const firstStrategy = strategies[0];

    if (processResult.aborted) {
      return withScraplingError(fileResult, firstStrategy, 'scrapling command aborted');
    }

    if (processResult.timedOut) {
      return withScraplingError(
        fileResult,
        firstStrategy,
        `scrapling command timed out after ${SCRAPLING_COMMAND_TIMEOUT_MS} ms`,
      );
    }

    if (processResult.exitCode !== 0) {
      return withScraplingError(
        fileResult,
        firstStrategy,
        `scrapling command exited with code ${processResult.exitCode}`,
      );
    }

    return fileResult;
  } catch (error) {
    return withScraplingError(
      fallback,
      strategies[0],
      error instanceof Error ? error.message : String(error),
    );
  }
}

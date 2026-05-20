export const DEFAULT_MODE = 'markdown' as const;

export type ExtractionMode = 'markdown' | 'html' | 'text';
export type FetchStrategy = 'fetcher' | 'dynamic' | 'stealthy';
export type FetcherName = FetchStrategy | 'gh';

export interface SiteStrategyMapping {
  domains: string[];
  strategies: FetchStrategy[];
  reason: string;
}

export interface WebFetchError {
  strategy: FetcherName | 'defuddle';
  error: string;
}

export interface WebFetchProgress {
  phase: 'starting' | 'trying' | 'extracting' | 'failed' | 'success';
  strategy?: FetcherName;
  message: string;
  errors?: WebFetchError[];
}

export type QualityJudgeThinkLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface WebFetchSettings {
  useDefuddle?: boolean;
  qualityJudge?: boolean;
  qualityJudgeModel?: string;
  qualityJudgeThinkLevel?: QualityJudgeThinkLevel;
}

export interface WebFetchResult {
  ok: boolean;
  url: string;
  finalUrl?: string;
  status?: number | string | null;
  strategy?: FetcherName;
  strategyReason?: string;
  mode: ExtractionMode;
  content?: string;
  contentLength?: number;
  outputPath?: string;
  errors: WebFetchError[];
  stdout?: string;
  stderr?: string;
}

export interface WebFetchOptions {
  url: string;
  mode?: ExtractionMode;
  cwd: string;
  signal?: AbortSignal;
  strategies?: FetchStrategy[];
  onProgress?: (progress: WebFetchProgress) => void;
}

export type ScraplingError = WebFetchError;
export type ScraplingFetchResult = WebFetchResult;
export type ScraplingFetchOptions = WebFetchOptions;

export const DEFAULT_MODE = 'markdown' as const;

export type ExtractionMode = 'markdown' | 'html' | 'text';
export type FetchStrategy = 'fetcher' | 'dynamic' | 'stealthy';

export interface SiteStrategyMapping {
  domains: string[];
  strategies: FetchStrategy[];
  reason: string;
}

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

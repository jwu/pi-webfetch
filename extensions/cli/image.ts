import { normalizeUrl } from '../shared.js';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export interface ImageFetchOptions {
  url: string;
  signal?: AbortSignal;
  maxBytes?: number;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface FetchedImage {
  kind: 'image';
  url: string;
  finalUrl: string;
  status: number;
  mimeType: string;
  data: string;
  contentLength: number;
}

export interface OversizeImage {
  kind: 'too-large';
  url: string;
  finalUrl: string;
  status: number;
  mimeType: string;
  contentLength?: number;
  maxBytes: number;
}

export type ImageFetchResult = FetchedImage | OversizeImage | undefined;

function contentType(response: Response): string | undefined {
  const value = response.headers.get('content-type');
  return value?.split(';', 1)[0]?.trim().toLowerCase();
}

function contentLength(response: Response): number | undefined {
  const value = response.headers.get('content-length');
  if (!value || !/^\d+$/.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readBody(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}

/**
 * Downloads a URL only when its HTTP response declares a supported image MIME type.
 * Non-image and failed responses deliberately return undefined so webfetch can continue
 * through its usual GitHub, YouTube, or Scrapling pipeline.
 */
export async function runImageFetch(options: ImageFetchOptions): Promise<ImageFetchResult> {
  const url = normalizeUrl(options.url);
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: options.signal,
      redirect: 'follow',
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.8' },
    });
  } catch {
    return undefined;
  }

  const mimeType = contentType(response);
  if (!response.ok || !mimeType || !SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    await discardBody(response);
    return undefined;
  }

  const declaredLength = contentLength(response);
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    await discardBody(response);
    return {
      kind: 'too-large',
      url,
      finalUrl: response.url || url,
      status: response.status,
      mimeType,
      contentLength: declaredLength,
      maxBytes,
    };
  }

  const bytes = await readBody(response, maxBytes);
  if (!bytes) {
    return {
      kind: 'too-large',
      url,
      finalUrl: response.url || url,
      status: response.status,
      mimeType,
      maxBytes,
    };
  }

  return {
    kind: 'image',
    url,
    finalUrl: response.url || url,
    status: response.status,
    mimeType,
    data: Buffer.from(bytes).toString('base64'),
    contentLength: bytes.byteLength,
  };
}

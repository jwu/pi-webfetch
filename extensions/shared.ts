import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';

import { DEFAULT_MODE, type ExtractionMode, type WebFetchSettings } from './types.js';

export const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;

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

  return {};
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
    }, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);

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

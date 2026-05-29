import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

import { normalizeMode, normalizeUrl, runProcess } from '../shared.js';
import type { ExtractionMode, ScraplingFetchOptions, ScraplingFetchResult } from '../types.js';

export const YTDLP_COMMAND_TIMEOUT_MS = 120_000;

interface YtDlpSubtitleEntry {
  url?: string;
  ext?: string;
  name?: string;
}

interface YtDlpChapter {
  title?: string;
  start_time?: number;
  end_time?: number;
}

interface YtDlpInfo {
  _type?: string;
  id?: string;
  title?: string;
  webpage_url?: string;
  original_url?: string;
  url?: string;
  channel?: string;
  channel_url?: string;
  uploader?: string;
  uploader_url?: string;
  language?: string;
  upload_date?: string;
  timestamp?: number;
  duration?: number;
  view_count?: number;
  like_count?: number;
  description?: string;
  chapters?: YtDlpChapter[];
  subtitles?: Record<string, YtDlpSubtitleEntry[]>;
  automatic_captions?: Record<string, YtDlpSubtitleEntry[]>;
  entries?: YtDlpInfo[];
}

interface TranscriptResult {
  source: 'manual' | 'automatic';
  language: string;
  text: string;
}

interface CuratedVideo {
  type: 'youtube_video';
  url: string;
  id?: string;
  title?: string;
  channel?: string;
  channelUrl?: string;
  language?: string;
  uploadDate?: string;
  duration?: number;
  viewCount?: number;
  likeCount?: number;
  description?: string;
  chapters?: Array<{ title?: string; startTime?: number; endTime?: number }>;
  transcript?: TranscriptResult;
}

interface CuratedPlaylistEntry {
  id?: string;
  title?: string;
  url?: string;
  duration?: number;
  viewCount?: number;
}

interface CuratedPlaylist {
  type: 'youtube_playlist';
  url: string;
  id?: string;
  title?: string;
  entries: CuratedPlaylistEntry[];
}

interface CuratedChannelSection {
  type: 'videos' | 'shorts' | 'streams' | 'other';
  title?: string;
  url: string;
  entries: CuratedPlaylistEntry[];
}

interface CuratedChannel {
  type: 'youtube_channel';
  url: string;
  id?: string;
  title?: string;
  channel?: string;
  sections: CuratedChannelSection[];
  entries: CuratedPlaylistEntry[];
}

function hostnameOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

export function isYouTubeUrl(rawUrl: string): boolean {
  try {
    const hostname = hostnameOf(normalizeUrl(rawUrl));
    return (
      hostname === 'youtube.com' ||
      hostname === 'm.youtube.com' ||
      hostname === 'music.youtube.com' ||
      hostname === 'youtu.be' ||
      hostname === 'youtube-nocookie.com'
    );
  } catch {
    return false;
  }
}

function isLikelyPlaylistUrl(url: string): boolean {
  const parsed = new URL(url);
  if (parsed.searchParams.get('list')) return true;

  const pathname = parsed.pathname;
  return (
    pathname.startsWith('/playlist') ||
    pathname.startsWith('/channel/') ||
    pathname.startsWith('/c/') ||
    pathname.startsWith('/user/') ||
    pathname.startsWith('/@')
  );
}

function isChannelRootUrl(url: string): boolean {
  const parsed = new URL(url);
  if (parsed.searchParams.get('list')) return false;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length === 1 && parts[0]?.startsWith('@')) return true;
  if (parts.length === 2 && ['channel', 'c', 'user'].includes(parts[0] ?? '')) return true;
  return false;
}

function ytdlpResultMode(mode: ExtractionMode): ExtractionMode {
  if (mode === 'json') return 'json';
  if (mode === 'text') return 'text';
  return 'markdown';
}

function failedYtDlpResult(
  base: Omit<ScraplingFetchResult, 'ok' | 'errors'>,
  error: string,
): ScraplingFetchResult {
  return {
    ...base,
    ok: false,
    errors: [{ strategy: 'yt-dlp', error }],
  };
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null),
  ) as T;
}

function formatDuration(seconds: number | undefined): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    : `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function canonicalVideoUrl(info: YtDlpInfo, fallbackUrl: string): string {
  if (info.webpage_url) return info.webpage_url;
  if (info.id) return `https://www.youtube.com/watch?v=${info.id}`;
  return fallbackUrl;
}

function canonicalEntryUrl(entry: YtDlpInfo): string | undefined {
  if (entry.webpage_url) return entry.webpage_url;
  if (entry.url?.startsWith('http://') || entry.url?.startsWith('https://')) return entry.url;
  if (entry.id) return `https://www.youtube.com/watch?v=${entry.id}`;
  if (entry.url) return `https://www.youtube.com/watch?v=${entry.url}`;
  return undefined;
}

function curatedChapters(info: YtDlpInfo): CuratedVideo['chapters'] | undefined {
  if (!Array.isArray(info.chapters) || info.chapters.length === 0) return undefined;
  return info.chapters.map((chapter) =>
    compactObject({
      title: chapter.title,
      startTime: chapter.start_time,
      endTime: chapter.end_time,
    }),
  );
}

function curatedVideo(
  info: YtDlpInfo,
  fallbackUrl: string,
  transcript?: TranscriptResult,
): CuratedVideo {
  return compactObject({
    type: 'youtube_video' as const,
    url: canonicalVideoUrl(info, fallbackUrl),
    id: info.id,
    title: info.title,
    channel: info.channel ?? info.uploader,
    channelUrl: info.channel_url ?? info.uploader_url,
    language: info.language,
    uploadDate: info.upload_date,
    duration: info.duration,
    viewCount: info.view_count,
    likeCount: info.like_count,
    description: info.description,
    chapters: curatedChapters(info),
    transcript,
  });
}

function curatedEntry(entry: YtDlpInfo): CuratedPlaylistEntry {
  return compactObject({
    id: entry.id,
    title: entry.title,
    url: canonicalEntryUrl(entry),
    duration: entry.duration,
    viewCount: entry.view_count,
  });
}

function curatedPlaylist(info: YtDlpInfo, fallbackUrl: string): CuratedPlaylist {
  return compactObject({
    type: 'youtube_playlist' as const,
    url: info.webpage_url ?? info.original_url ?? fallbackUrl,
    id: info.id,
    title: info.title,
    entries: (info.entries ?? []).map(curatedEntry),
  });
}

function sectionTypeForUrl(url: string): CuratedChannelSection['type'] {
  const pathname = new URL(url).pathname.replace(/\/$/, '');
  if (pathname.endsWith('/videos')) return 'videos';
  if (pathname.endsWith('/shorts')) return 'shorts';
  if (pathname.endsWith('/streams')) return 'streams';
  return 'other';
}

function curatedChannel(
  info: YtDlpInfo,
  fallbackUrl: string,
  sections: CuratedChannelSection[],
): CuratedChannel {
  return compactObject({
    type: 'youtube_channel' as const,
    url: info.webpage_url ?? info.original_url ?? fallbackUrl,
    id: info.id,
    title: info.title,
    channel: info.channel ?? info.uploader,
    sections,
    entries: sections.flatMap((section) => section.entries),
  });
}

function formatChapters(chapters: CuratedVideo['chapters']): string | undefined {
  if (!chapters?.length) return undefined;
  return chapters
    .map((chapter) => {
      const start = formatDuration(chapter.startTime);
      return `- ${start ? `${start} ` : ''}${chapter.title ?? 'Untitled chapter'}`;
    })
    .join('\n');
}

function formatVideoMarkdown(video: CuratedVideo): string {
  const lines = [
    `# ${video.title ?? 'YouTube video'}`,
    '',
    `URL: ${video.url}`,
    video.channel ? `Channel: ${video.channel}` : undefined,
    video.uploadDate ? `Upload Date: ${video.uploadDate}` : undefined,
    video.duration !== undefined
      ? `Duration: ${formatDuration(video.duration) ?? video.duration}`
      : undefined,
    video.viewCount !== undefined ? `Views: ${video.viewCount}` : undefined,
    video.language ? `Language: ${video.language}` : undefined,
    '',
    video.description ? `## Description\n\n${video.description}` : undefined,
    formatChapters(video.chapters) ? `## Chapters\n\n${formatChapters(video.chapters)}` : undefined,
    `## Transcript\n\n${video.transcript?.text ?? 'No transcript found.'}`,
  ];

  return lines.filter((line): line is string => line !== undefined).join('\n');
}

function formatPlaylistEntries(entries: CuratedPlaylistEntry[]): string {
  return entries
    .map((entry, index) => {
      const label = entry.title ?? entry.id ?? `Video ${index + 1}`;
      const meta = [
        entry.duration !== undefined ? formatDuration(entry.duration) : undefined,
        entry.viewCount !== undefined ? `${entry.viewCount} views` : undefined,
      ].filter(Boolean);
      return `- ${label}${entry.url ? ` — ${entry.url}` : ''}${meta.length ? ` (${meta.join(', ')})` : ''}`;
    })
    .join('\n');
}

function formatPlaylistMarkdown(playlist: CuratedPlaylist): string {
  const entries = playlist.entries.length
    ? formatPlaylistEntries(playlist.entries)
    : 'No playlist entries found.';

  return [
    `# ${playlist.title ?? 'YouTube playlist'}`,
    '',
    `URL: ${playlist.url}`,
    '',
    '## Videos',
    '',
    entries,
  ].join('\n');
}

function formatChannelMarkdown(channel: CuratedChannel): string {
  const sectionLines = channel.sections.length
    ? channel.sections
        .map((section) =>
          [
            `## ${section.title ?? section.type}`,
            '',
            `URL: ${section.url}`,
            '',
            section.entries.length ? formatPlaylistEntries(section.entries) : 'No entries found.',
          ].join('\n'),
        )
        .join('\n\n')
    : 'No channel sections found.';

  return [
    `# ${channel.title ?? channel.channel ?? 'YouTube channel'}`,
    '',
    `URL: ${channel.url}`,
    channel.channel ? `Channel: ${channel.channel}` : undefined,
    `Entries: ${channel.entries.length}`,
    '',
    sectionLines,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function isBotDetectionError(stderr: string): boolean {
  return /sign in to confirm/i.test(stderr);
}

export function parseVttTranscript(vtt: string): string {
  const transcriptLines: string[] = [];
  let previous = '';
  let skippingBlock = false;

  for (const rawLine of vtt.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) {
      skippingBlock = false;
      continue;
    }

    if (line === 'STYLE' || line === 'REGION' || line.startsWith('NOTE')) {
      skippingBlock = true;
      continue;
    }

    if (skippingBlock) continue;
    if (line === 'WEBVTT' || line.startsWith('Kind:') || line.startsWith('Language:')) continue;
    if (/^\d+$/.test(line)) continue;
    if (line.includes('-->')) continue;

    const cleaned = decodeHtmlEntities(line.replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || cleaned === previous) continue;
    transcriptLines.push(cleaned);
    previous = cleaned;
  }

  return transcriptLines.join('\n').trim();
}

function languageMatches(language: string, preferred: string): boolean {
  const normalizedLanguage = language.toLowerCase();
  const normalizedPreferred = preferred.toLowerCase();
  return (
    normalizedLanguage === normalizedPreferred ||
    normalizedLanguage.startsWith(`${normalizedPreferred}-`) ||
    normalizedPreferred.startsWith(`${normalizedLanguage}-`)
  );
}

function preferredLanguages(nativeLanguage: string | undefined): string[] {
  return [nativeLanguage, 'en', 'zh', 'zh-Hans', 'zh-Hant']
    .filter((language): language is string => Boolean(language))
    .filter(
      (language, index, languages) =>
        languages.findIndex((candidate) => candidate.toLowerCase() === language.toLowerCase()) ===
        index,
    );
}

function pickSubtitleLanguage(
  subtitles: Record<string, YtDlpSubtitleEntry[]> | undefined,
  nativeLanguage: string | undefined,
): string | undefined {
  const languages = Object.keys(subtitles ?? {}).filter(
    (language) => (subtitles ?? {})[language]?.length,
  );
  if (languages.length === 0) return undefined;

  for (const preferred of preferredLanguages(nativeLanguage)) {
    const matched = languages.find((language) => languageMatches(language, preferred));
    if (matched) return matched;
  }

  return languages[0];
}

function chooseTranscriptSource(
  info: YtDlpInfo,
): { source: TranscriptResult['source']; language: string } | undefined {
  const manualLanguage = pickSubtitleLanguage(info.subtitles, info.language);
  if (manualLanguage) return { source: 'manual', language: manualLanguage };

  const automaticLanguage = pickSubtitleLanguage(info.automatic_captions, info.language);
  if (automaticLanguage) return { source: 'automatic', language: automaticLanguage };

  return undefined;
}

async function findVttFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return findVttFiles(path);
      return extname(entry.name).toLowerCase() === '.vtt' ? [path] : [];
    }),
  );
  return files.flat();
}

function buildTranscriptArgs(options: {
  url: string;
  source: TranscriptResult['source'];
  language: string;
  tempDir: string;
  cookiesFromBrowser?: string;
}): string[] {
  const args = ['--skip-download', '--no-warnings', '--no-playlist'];
  if (options.cookiesFromBrowser) {
    args.push('--cookies-from-browser', options.cookiesFromBrowser);
  }
  args.push(
    options.source === 'manual' ? '--write-subs' : '--write-auto-subs',
    '--sub-langs',
    options.language,
    '--sub-format',
    'vtt',
    '--paths',
    options.tempDir,
    '-o',
    '%(id)s.%(ext)s',
    options.url,
  );
  return args;
}

async function downloadTranscript(options: {
  url: string;
  cwd: string;
  signal?: AbortSignal;
  source: TranscriptResult['source'];
  language: string;
  useCookies?: boolean;
}): Promise<{ transcript?: TranscriptResult; error?: string; stdout?: string; stderr?: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'pi-webfetch-ytdlp-'));
  try {
    let processResult = await runProcess(
      'yt-dlp',
      buildTranscriptArgs({
        url: options.url,
        source: options.source,
        language: options.language,
        tempDir,
        cookiesFromBrowser: options.useCookies ? 'chrome' : undefined,
      }),
      {
        cwd: options.cwd,
        signal: options.signal,
        timeoutMs: YTDLP_COMMAND_TIMEOUT_MS,
      },
    );

    if (
      processResult.exitCode !== 0 &&
      !processResult.aborted &&
      !processResult.timedOut &&
      isBotDetectionError(processResult.stderr) &&
      !options.useCookies &&
      !options.signal?.aborted
    ) {
      processResult = await runProcess(
        'yt-dlp',
        buildTranscriptArgs({
          url: options.url,
          source: options.source,
          language: options.language,
          tempDir,
          cookiesFromBrowser: 'chrome',
        }),
        {
          cwd: options.cwd,
          signal: options.signal,
          timeoutMs: YTDLP_COMMAND_TIMEOUT_MS,
        },
      );
    }

    if (processResult.aborted) return { error: 'yt-dlp subtitle command aborted' };
    if (processResult.timedOut) {
      return { error: `yt-dlp subtitle command timed out after ${YTDLP_COMMAND_TIMEOUT_MS} ms` };
    }
    if (processResult.exitCode !== 0) {
      return {
        error: `yt-dlp subtitle command exited with code ${processResult.exitCode}`,
        stdout: processResult.stdout,
        stderr: processResult.stderr,
      };
    }

    const [subtitlePath] = await findVttFiles(tempDir);
    if (!subtitlePath) return { error: 'yt-dlp did not write a VTT subtitle file' };

    const text = parseVttTranscript(await readFile(subtitlePath, 'utf8'));
    if (!text) return { error: 'subtitle file did not contain transcript text' };

    return {
      transcript: {
        source: options.source,
        language: options.language,
        text,
      },
      stdout: processResult.stdout,
      stderr: processResult.stderr,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function parseInfoJson(raw: string): YtDlpInfo {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('yt-dlp returned invalid JSON');
  }
  return parsed as YtDlpInfo;
}

function buildYtDlpInfoArgs(
  url: string,
  flatPlaylist: boolean,
  cookiesFromBrowser?: string,
): string[] {
  const args = ['-J', '--skip-download', '--no-warnings'];
  if (cookiesFromBrowser) {
    args.push('--cookies-from-browser', cookiesFromBrowser);
  }
  args.push(...(flatPlaylist ? ['--flat-playlist'] : ['--no-playlist']), url);
  return args;
}

async function runYtDlpInfoCommand(
  url: string,
  cwd: string,
  signal: AbortSignal | undefined,
  flatPlaylist: boolean,
  cookiesFromBrowser?: string,
) {
  return runProcess('yt-dlp', buildYtDlpInfoArgs(url, flatPlaylist, cookiesFromBrowser), {
    cwd,
    signal,
    timeoutMs: YTDLP_COMMAND_TIMEOUT_MS,
  });
}

async function fetchYtDlpInfo(options: {
  url: string;
  cwd: string;
  signal?: AbortSignal;
  flatPlaylist: boolean;
}): Promise<{
  info?: YtDlpInfo;
  stdout: string;
  stderr: string;
  error?: string;
  usedCookies?: boolean;
}> {
  let processResult = await runYtDlpInfoCommand(
    options.url,
    options.cwd,
    options.signal,
    options.flatPlaylist,
  );
  let usedCookies = false;

  if (
    processResult.exitCode !== 0 &&
    !processResult.aborted &&
    !processResult.timedOut &&
    isBotDetectionError(processResult.stderr) &&
    !options.signal?.aborted
  ) {
    processResult = await runYtDlpInfoCommand(
      options.url,
      options.cwd,
      options.signal,
      options.flatPlaylist,
      'chrome',
    );
    usedCookies = true;
  }

  if (processResult.aborted) {
    return {
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      error: 'yt-dlp command aborted',
    };
  }
  if (processResult.timedOut) {
    return {
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      error: `yt-dlp command timed out after ${YTDLP_COMMAND_TIMEOUT_MS} ms`,
    };
  }
  if (processResult.exitCode !== 0) {
    return {
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      error: `yt-dlp command exited with code ${processResult.exitCode}`,
    };
  }
  if (!processResult.stdout.trim()) {
    return {
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      error: 'yt-dlp returned empty JSON',
    };
  }

  return {
    info: parseInfoJson(processResult.stdout),
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    usedCookies,
  };
}

function expandableChannelSectionUrls(info: YtDlpInfo): Array<{ title?: string; url: string }> {
  return (info.entries ?? []).flatMap((entry) => {
    const url = canonicalEntryUrl(entry);
    if (!url) return [];
    const type = sectionTypeForUrl(url);
    return type === 'videos' || type === 'shorts' || type === 'streams'
      ? [{ title: entry.title, url }]
      : [];
  });
}

async function expandChannelSections(options: {
  rootInfo: YtDlpInfo;
  cwd: string;
  signal?: AbortSignal;
  onProgress?: ScraplingFetchOptions['onProgress'];
}): Promise<{
  sections: CuratedChannelSection[];
  errors: ScraplingFetchResult['errors'];
  stdout: string;
  stderr: string;
}> {
  const sections: CuratedChannelSection[] = [];
  const errors: ScraplingFetchResult['errors'] = [];
  let stdout = '';
  let stderr = '';

  for (const section of expandableChannelSectionUrls(options.rootInfo)) {
    const type = sectionTypeForUrl(section.url);
    options.onProgress?.({
      phase: 'extracting',
      strategy: 'yt-dlp',
      message: `fetching channel ${type} with yt-dlp`,
    });
    const result = await fetchYtDlpInfo({
      url: section.url,
      cwd: options.cwd,
      signal: options.signal,
      flatPlaylist: true,
    });
    stdout += result.stdout;
    stderr += result.stderr;

    if (result.error || !result.info) {
      errors.push({
        strategy: 'yt-dlp',
        error: `${type}: ${result.error ?? 'missing section JSON'}`,
      });
      continue;
    }

    sections.push({
      type,
      title: result.info.title ?? section.title,
      url: result.info.webpage_url ?? result.info.original_url ?? section.url,
      entries: (result.info.entries ?? []).map(curatedEntry),
    });
  }

  return { sections, errors, stdout, stderr };
}

export async function runYtDlpFetch(options: ScraplingFetchOptions): Promise<ScraplingFetchResult> {
  const url = normalizeUrl(options.url);
  const mode = ytdlpResultMode(normalizeMode(options.mode));
  const playlist = isLikelyPlaylistUrl(url);
  const channelRoot = isChannelRootUrl(url);
  const base = {
    url,
    finalUrl: url,
    strategy: 'yt-dlp' as const,
    strategyReason: channelRoot
      ? 'YouTube channel URL matched; expand channel videos and shorts with yt-dlp flat playlists.'
      : playlist
        ? 'YouTube playlist/channel URL matched; fetch a flat playlist with yt-dlp.'
        : 'YouTube video URL matched; fetch metadata and transcript with yt-dlp.',
    mode,
  };

  options.onProgress?.({
    phase: 'trying',
    strategy: 'yt-dlp',
    message: channelRoot
      ? 'fetching channel sections with yt-dlp'
      : playlist
        ? 'fetching flat playlist with yt-dlp'
        : 'fetching metadata with yt-dlp',
  });

  try {
    const rootResult = await fetchYtDlpInfo({
      url,
      cwd: options.cwd,
      signal: options.signal,
      flatPlaylist: playlist,
    });

    const withProcessOutput = {
      ...base,
      stdout: rootResult.stdout,
      stderr: rootResult.stderr,
      usedCookies: rootResult.usedCookies,
    };

    if (rootResult.error || !rootResult.info) {
      return failedYtDlpResult(
        withProcessOutput,
        rootResult.error ?? 'yt-dlp returned missing JSON',
      );
    }

    const info = rootResult.info;

    if (channelRoot) {
      const expanded = await expandChannelSections({
        rootInfo: info,
        cwd: options.cwd,
        signal: options.signal,
        onProgress: options.onProgress,
      });
      const sections = expanded.sections.length
        ? expanded.sections
        : [
            {
              type: 'other' as const,
              title: info.title,
              url: info.webpage_url ?? info.original_url ?? url,
              entries: (info.entries ?? []).map(curatedEntry),
            },
          ];
      const curated = curatedChannel(info, url, sections);
      const content =
        mode === 'json' ? JSON.stringify(curated, null, 2) : formatChannelMarkdown(curated);
      options.onProgress?.({ phase: 'success', strategy: 'yt-dlp', message: 'yt-dlp succeeded' });
      return {
        ...withProcessOutput,
        stdout: withProcessOutput.stdout + expanded.stdout,
        stderr: withProcessOutput.stderr + expanded.stderr,
        ok: true,
        finalUrl: curated.url,
        content,
        contentLength: content.length,
        errors: expanded.errors,
        usedCookies: withProcessOutput.usedCookies,
      };
    }

    if (playlist) {
      const curated = curatedPlaylist(info, url);
      const content =
        mode === 'json' ? JSON.stringify(curated, null, 2) : formatPlaylistMarkdown(curated);
      options.onProgress?.({ phase: 'success', strategy: 'yt-dlp', message: 'yt-dlp succeeded' });
      return {
        ...withProcessOutput,
        ok: true,
        finalUrl: curated.url,
        content,
        contentLength: content.length,
        errors: [],
        usedCookies: withProcessOutput.usedCookies,
      };
    }

    const errors: ScraplingFetchResult['errors'] = [];
    const source = chooseTranscriptSource(info);
    let transcript: TranscriptResult | undefined;

    if (source) {
      options.onProgress?.({
        phase: 'extracting',
        strategy: 'yt-dlp',
        message: `downloading ${source.source} subtitles (${source.language}) with yt-dlp`,
      });
      const transcriptResult = await downloadTranscript({
        url,
        cwd: options.cwd,
        signal: options.signal,
        source: source.source,
        language: source.language,
        useCookies: rootResult.usedCookies,
      });
      transcript = transcriptResult.transcript;
      if (transcriptResult.error) {
        errors.push({ strategy: 'yt-dlp', error: `transcript: ${transcriptResult.error}` });
      }
    }

    const curated = curatedVideo(info, url, transcript);
    const content =
      mode === 'json' ? JSON.stringify(curated, null, 2) : formatVideoMarkdown(curated);
    options.onProgress?.({ phase: 'success', strategy: 'yt-dlp', message: 'yt-dlp succeeded' });
    return {
      ...withProcessOutput,
      ok: true,
      finalUrl: curated.url,
      content,
      contentLength: content.length,
      errors,
      usedCookies: withProcessOutput.usedCookies,
    };
  } catch (error) {
    return failedYtDlpResult(base, error instanceof Error ? error.message : String(error));
  }
}

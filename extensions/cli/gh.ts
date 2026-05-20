import { normalizeMode, normalizeUrl, runProcess } from '../shared.js';
import type { ExtractionMode, WebFetchProgress } from '../types.js';

export const GH_COMMAND_TIMEOUT_MS = 60_000;

export interface GitHubRoute {
  args: string[];
  reason: string;
  strategy: string;
}

interface GhFetchOptions {
  url: string;
  mode?: ExtractionMode;
  cwd: string;
  signal?: AbortSignal;
  onProgress?: (
    progress: Omit<WebFetchProgress, 'strategy' | 'errors'> & {
      strategy?: string;
      errors?: Array<{ strategy: string; error: string }>;
    },
  ) => void;
}

interface GhFetchResult {
  ok: boolean;
  url: string;
  finalUrl?: string;
  strategy?: string;
  strategyReason?: string;
  mode: ExtractionMode;
  content?: string;
  contentLength?: number;
  errors: Array<{ strategy: string; error: string }>;
  stdout?: string;
  stderr?: string;
}

function hostnameOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

export function isGitHubUrl(rawUrl: string): boolean {
  try {
    const hostname = hostnameOf(normalizeUrl(rawUrl));
    return hostname === 'github.com' || hostname === 'gist.github.com';
  } catch {
    return false;
  }
}

function splitPath(url: string): string[] {
  return new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
}

function repoName(repo: string): string {
  return repo.replace(/\.git$/, '');
}

function githubApiRoute(owner: string, repo: string, parts: string[], reason: string): GitHubRoute {
  return {
    reason,
    strategy: 'api',
    args: ['api', ['repos', owner, repo, ...parts].join('/')],
  };
}

const GITHUB_TREE_JQ = String.raw`.[] | "- " + (if .type == "dir" then "dir" else "file" end) + " " + .path + (if .type == "file" and (.size != null) then " (" + (.size | tostring) + " bytes)" else "" end) + "\n  " + .html_url`;

function contentsApiRoute(owner: string, repo: string, parts: string[], kind: string): GitHubRoute {
  const [ref, ...pathParts] = parts;
  if (!ref || (kind !== 'tree' && pathParts.length === 0)) {
    return githubApiRoute(owner, repo, [kind, ...parts], 'GitHub URL matched; fetch with gh api.');
  }

  const contentPath = pathParts.join('/');
  const args = [
    'api',
    `repos/${owner}/${repo}/contents${contentPath ? `/${contentPath}` : ''}`,
    '--method',
    'GET',
    '-f',
    `ref=${ref}`,
  ];

  if (kind === 'tree') {
    args.push('--jq', GITHUB_TREE_JQ);
  } else {
    args.push('-H', 'Accept: application/vnd.github.raw+json');
  }

  return {
    reason: `GitHub ${kind} URL matched; fetch ${kind === 'tree' ? 'directory listing with gh api --jq' : 'file contents with gh api'}.`,
    strategy: 'api',
    args,
  };
}

function fallbackApiRoute(owner: string, repo: string, kind: string, rest: string[]): GitHubRoute {
  if (kind === 'blob' || kind === 'raw' || kind === 'tree') {
    return contentsApiRoute(owner, repo, rest, kind);
  }
  if (kind === 'commit' && rest[0]) {
    return githubApiRoute(
      owner,
      repo,
      ['commits', rest[0]],
      'GitHub commit URL matched; fetch with gh api.',
    );
  }
  if (kind === 'branch' && rest[0]) {
    return githubApiRoute(
      owner,
      repo,
      ['branches', rest[0]],
      'GitHub branch URL matched; fetch with gh api.',
    );
  }
  return githubApiRoute(
    owner,
    repo,
    [kind, ...rest],
    'No specific GitHub view route matched; fetch raw data with gh api.',
  );
}

function gistRoute(url: string): GitHubRoute {
  const parts = splitPath(url);
  if (parts.length === 0) throw new Error('Unsupported GitHub gist URL. Expected /<owner>/<id>.');
  return {
    reason: 'GitHub gist URL matched; fetch gist with gh.',
    strategy: 'view gist',
    args: ['gist', 'view', url],
  };
}

export function ghRouteForUrl(rawUrl: string): GitHubRoute {
  const url = normalizeUrl(rawUrl);
  const hostname = hostnameOf(url);
  if (hostname === 'gist.github.com') return gistRoute(url);

  const [owner, rawRepo, kind, ...rest] = splitPath(url);
  if (!owner) throw new Error('Unsupported GitHub URL. Expected /<owner>/<repo>.');
  if (!rawRepo) {
    return {
      reason: 'GitHub owner URL matched; fetch owner data with gh api.',
      strategy: 'api',
      args: ['api', `users/${owner}`],
    };
  }

  const repo = repoName(rawRepo);
  const repository = `${owner}/${repo}`;
  if (!kind) {
    return {
      reason: 'GitHub repository URL matched; fetch repository with gh.',
      strategy: 'view repo',
      args: ['repo', 'view', url],
    };
  }

  if (kind === 'pull' && rest[0]) {
    return {
      reason: 'GitHub pull request URL matched; fetch pull request with gh.',
      strategy: 'view pr',
      args: ['pr', 'view', url],
    };
  }

  if (kind === 'issues' && rest[0]) {
    return {
      reason: 'GitHub issue URL matched; fetch issue with gh.',
      strategy: 'view issue',
      args: ['issue', 'view', url],
    };
  }

  if (kind === 'releases' && rest[0] === 'tag' && rest[1]) {
    return {
      reason: 'GitHub release tag URL matched; fetch release with gh.',
      strategy: 'view release',
      args: ['release', 'view', rest.slice(1).join('/'), '-R', repository],
    };
  }

  if (kind === 'actions' && rest[0] === 'runs' && rest[1]) {
    return {
      reason: 'GitHub Actions run URL matched; fetch run with gh.',
      strategy: 'view run',
      args: ['run', 'view', rest[1], '-R', repository],
    };
  }

  return fallbackApiRoute(owner, repo, kind, rest);
}

function resultModeForGh(mode: ExtractionMode): ExtractionMode {
  return mode === 'html' ? 'text' : mode;
}

export async function runGhFetch(options: GhFetchOptions): Promise<GhFetchResult> {
  const url = normalizeUrl(options.url);
  const mode = resultModeForGh(normalizeMode(options.mode));

  let route: GitHubRoute | undefined;
  try {
    route = ghRouteForUrl(url);
    options.onProgress?.({
      phase: 'trying',
      strategy: route.strategy,
      message: 'fetching with gh',
    });
    const processResult = await runProcess('gh', route.args, {
      cwd: options.cwd,
      signal: options.signal,
      timeoutMs: GH_COMMAND_TIMEOUT_MS,
    });

    const base = {
      url,
      finalUrl: url,
      strategy: route.strategy,
      strategyReason: route.reason,
      mode,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
    };

    if (processResult.aborted) {
      return {
        ...base,
        ok: false,
        errors: [{ strategy: route.strategy, error: 'gh command aborted' }],
      };
    }

    if (processResult.timedOut) {
      return {
        ...base,
        ok: false,
        errors: [
          {
            strategy: route.strategy,
            error: `gh command timed out after ${GH_COMMAND_TIMEOUT_MS} ms`,
          },
        ],
      };
    }

    if (processResult.exitCode !== 0) {
      return {
        ...base,
        ok: false,
        errors: [
          {
            strategy: route.strategy,
            error: `gh command exited with code ${processResult.exitCode}`,
          },
        ],
      };
    }

    const content = processResult.stdout.trimEnd();
    if (!content.trim()) {
      return {
        ...base,
        ok: false,
        errors: [{ strategy: route.strategy, error: 'gh returned empty content' }],
      };
    }

    options.onProgress?.({ phase: 'success', strategy: route.strategy, message: 'gh succeeded' });
    return {
      ...base,
      ok: true,
      content,
      contentLength: content.length,
      errors: [],
    };
  } catch (error) {
    return {
      ok: false,
      url,
      mode,
      strategy: route?.strategy ?? 'gh',
      strategyReason: route?.reason ?? 'GitHub URL matched; fetch with gh.',
      errors: [
        {
          strategy: route?.strategy ?? 'gh',
          error: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

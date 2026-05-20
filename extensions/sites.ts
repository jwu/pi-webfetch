import type { SiteStrategyMapping } from './types.js';

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

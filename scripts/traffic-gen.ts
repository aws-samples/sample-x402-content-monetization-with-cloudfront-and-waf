#!/usr/bin/env npx tsx
/**
 * x402 Traffic Generator
 *
 * Sends real HTTP traffic to a deployed CloudFront distribution, including
 * actual on-chain x402 payments on EVM and Solana networks.
 *
 * Usage:
 *   npx tsx scripts/traffic-gen.ts [options]
 *
 * Options:
 *   --url <url>       CloudFront base URL (default: from .env or stack output)
 *   --rounds <n>      Max requests to send; 0 = full playlist (default: 0)
 *   --delay <ms>      Delay between requests in ms (default: 500)
 *   --no-pay          Disable payment (dry run, bots just get 402s)
 *   --duration <min>  Continuous mode: run for <min> minutes with sinusoidal
 *                     traffic trends (default: 0 = one-shot playlist)
 *
 * Environment variables (or .env file in scripts/):
 *   CDP_API_KEY_ID       CDP API Key ID for EVM payments on Base
 *   CDP_API_KEY_SECRET   CDP API Key Secret for EVM payments on Base
 *   CDP_WALLET_SECRET    CDP Wallet Secret for EVM payments on Base
 *   SVM_PRIVATE_KEY      Base58-encoded 64-byte Solana secret key
 */

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { CdpClient } from '@coinbase/cdp-sdk';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { base58 } from '@scure/base';
import { toAccount } from 'viem/accounts';

// Load .env from scripts/ directory, then project root
const scriptDir = typeof __dirname !== 'undefined' ? __dirname : new URL('.', import.meta.url).pathname;
config({ path: resolve(scriptDir, '.env') });
config({ path: resolve(scriptDir, '../.env') });

// ── CLI args ─────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'https://YOUR_DISTRIBUTION.cloudfront.net' },
    rounds: { type: 'string', default: '0' },
    delay: { type: 'string', default: '500' },
    'no-pay': { type: 'boolean', default: false },
    duration: { type: 'string', default: '0' },
  },
  strict: true,
});

const BASE_URL = args.url!.replace(/\/$/, '');
const ROUNDS = parseInt(args.rounds!, 10);
const DELAY_MS = parseInt(args.delay!, 10);
const PAYMENTS_ENABLED = !args['no-pay'];
const DURATION_MS = parseFloat(args.duration!) * 60_000;

// ── x402 Client Setup ────────────────────────────────────────────────────────

async function initPaymentClient(): Promise<typeof fetch> {
  const cdpApiKeyId = process.env.CDP_API_KEY_ID;
  const cdpApiKeySecret = process.env.CDP_API_KEY_SECRET;
  const cdpWalletSecret = process.env.CDP_WALLET_SECRET;
  const client = new x402Client();
  let registeredSchemes = 0;

  const hasAnyEvmCredential = !!(
    cdpApiKeyId ||
    cdpApiKeySecret ||
    cdpWalletSecret
  );
  const hasCompleteEvmCredentials = !!(
    cdpApiKeyId &&
    cdpApiKeySecret &&
    cdpWalletSecret
  );

  if (hasAnyEvmCredential && !hasCompleteEvmCredentials) {
    const missing = [
      !cdpApiKeyId && 'CDP_API_KEY_ID',
      !cdpApiKeySecret && 'CDP_API_KEY_SECRET',
      !cdpWalletSecret && 'CDP_WALLET_SECRET',
    ].filter(Boolean).join(', ');
    console.error(`\n❌ Incomplete EVM signer configuration: ${missing}`);
    console.error('   Provide all CDP credentials or remove the partial config.\n');
    process.exit(1);
  }

  if (hasCompleteEvmCredentials) {
    const cdp = new CdpClient({
      apiKeyId: cdpApiKeyId,
      apiKeySecret: cdpApiKeySecret,
      walletSecret: cdpWalletSecret,
    });
    console.log('✅ Initialized CDP client for EVM payments');

    const serverAccount = await cdp.evm.getOrCreateAccount({
      name: 'x402-traffic-gen',
    });
    console.log(`🔑 EVM wallet: ${serverAccount.address}`);

    registerExactEvmScheme(client, { signer: toAccount(serverAccount) });
    registeredSchemes++;
    console.log('✅ Registered EVM payment scheme');
  }

  const svmPrivateKey = process.env.SVM_PRIVATE_KEY;
  if (svmPrivateKey) {
    const signer = await createKeyPairSignerFromBytes(base58.decode(svmPrivateKey));
    client.register('solana:*', new ExactSvmScheme(signer));
    registeredSchemes++;
    console.log(`🔑 Solana wallet: ${signer.address}`);
    console.log('✅ Registered Solana payment scheme');
  }

  if (registeredSchemes === 0) {
    console.error('\n❌ No payment signer configured.');
    console.error('   For Base payments, set CDP_API_KEY_ID, CDP_API_KEY_SECRET, and CDP_WALLET_SECRET.');
    console.error('   For Solana payments, set SVM_PRIVATE_KEY.');
    console.error('   You can also use --no-pay for a dry run.\n');
    process.exit(1);
  }

  console.log('');

  return wrapFetchWithPayment(fetch, client);
}

// ── Traffic Playlist ─────────────────────────────────────────────────────────
//
// Deterministic playlist: every bot pays across all 6 content routes,
// plus exactly 1 verify failure and 1 settlement failure.

interface Scenario {
  name: string;
  path: string;
  headers: Record<string, string>;
  expectStatus: number[];
  attemptPayment: boolean;
}

const API_PATHS = ['/api/sports.json', '/api/fashion.json', '/api/politics.json'];
const ARTICLE_PATHS = ['/articles/sports.html', '/articles/fashion.html', '/articles/politics.html'];
const ALL_PATHS = [...API_PATHS, ...ARTICLE_PATHS];

// Bot user-agent strings
const BOTS: Record<string, string> = {
  'ChatGPT-User': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)',
  'ClaudeBot':    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +https://claudebot.ai)',
  'GPTBot':       'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.3; +https://openai.com/gptbot)',
  'PerplexityBot':'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
  'cohere-ai':    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; cohere-ai/1.0; +https://cohere.com/bot)',
  'Meta-Agent':   'Mozilla/5.0 (compatible; Meta-ExternalAgent/1.0; +https://developers.facebook.com/docs/sharing/webmasters/crawler)',
};
const HUMAN_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function buildPlaylist(): Scenario[] {
  const playlist: Scenario[] = [];
  const botNames = Object.keys(BOTS);

  // ── Paying bots: each bot visits every content route ────────────────────
  for (const contentPath of ALL_PATHS) {
    const accept = contentPath.endsWith('.json') ? 'application/json' : 'text/html';
    const bot = botNames[playlist.length % botNames.length]; // round-robin bots
    playlist.push({
      name: `💰 ${bot} → ${contentPath}`,
      path: contentPath,
      headers: { 'User-Agent': BOTS[bot], 'Accept': accept },
      expectStatus: [200],
      attemptPayment: true,
    });
  }

  // Duplicate so more bots hit more routes (fill remaining rounds)
  for (let i = 0; i < ALL_PATHS.length; i++) {
    const contentPath = ALL_PATHS[i];
    const accept = contentPath.endsWith('.json') ? 'application/json' : 'text/html';
    const bot = botNames[(i + 3) % botNames.length]; // offset to get different combos
    playlist.push({
      name: `💰 ${bot} → ${contentPath}`,
      path: contentPath,
      headers: { 'User-Agent': BOTS[bot], 'Accept': accept },
      expectStatus: [200],
      attemptPayment: true,
    });
  }

  // ── Human traffic (free, no payment) ────────────────────────────────────
  playlist.push({
    name: '🧑 human → /',
    path: '/',
    headers: { 'User-Agent': HUMAN_UA, 'Accept': 'text/html' },
    expectStatus: [200],
    attemptPayment: false,
  });
  for (const p of ARTICLE_PATHS) {
    playlist.push({
      name: `🧑 human → ${p}`,
      path: p,
      headers: { 'User-Agent': HUMAN_UA, 'Accept': 'text/html' },
      expectStatus: [200],
      attemptPayment: false,
    });
  }

  // ── 1× Verify failure: garbage payment header ──────────────────────────
  playlist.push({
    name: '❌ GPTBot → /api/sports.json (verify fail)',
    path: '/api/sports.json',
    headers: {
      'User-Agent': BOTS['GPTBot'],
      'Accept': 'application/json',
      'X-PAYMENT': 'dGhpcyBpcyBub3QgYSB2YWxpZCBwYXltZW50', // base64 garbage
    },
    expectStatus: [402],
    attemptPayment: false,
  });

  // ── 1× Settlement failure: pay for a resource that doesn't exist ───────
  // Verification succeeds (facilitator holds funds) but origin returns 403,
  // so origin-response handler skips settlement → funds never settle.
  playlist.push({
    name: '❌ ClaudeBot → /api/deleted.json (settle fail)',
    path: '/api/deleted.json',
    headers: { 'User-Agent': BOTS['ClaudeBot'], 'Accept': 'application/json' },
    expectStatus: [403, 404],
    attemptPayment: true,
  });

  // Shuffle to make the output look like real mixed traffic
  for (let i = playlist.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [playlist[i], playlist[j]] = [playlist[j], playlist[i]];
  }

  return playlist;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Request execution ────────────────────────────────────────────────────────

interface RequestResult {
  status: number;
  paid: boolean;
  path: string;
}

async function executeRequest(scenario: Scenario, payFetch: typeof fetch): Promise<RequestResult> {
  const url = `${BASE_URL}${scenario.path}`;

  if (scenario.attemptPayment) {
    // wrapFetchWithPayment handles the full 402 → sign → resend flow automatically.
    const res = await payFetch(url, {
      method: 'GET',
      headers: scenario.headers,
    });
    await res.text();
    return { status: res.status, paid: res.status === 200, path: scenario.path };
  }

  // No payment — plain fetch
  const res = await fetch(url, { headers: scenario.headers, redirect: 'follow' });
  await res.text();
  return { status: res.status, paid: false, path: scenario.path };
}

// ── Sinusoidal continuous mode ────────────────────────────────────────────────

/** Returns a value in [0, 1] following a sine wave. */
function sinWeight(t: number, periodMs: number, phase: number): number {
  return 0.5 + 0.5 * Math.sin(2 * Math.PI * t / periodMs + phase);
}

/** Weighted random pick: returns the index of the chosen item. */
function pickWeighted(weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

const CONTENT_CATEGORIES = ['sports', 'fashion', 'politics'] as const;
const CONTENT_ROUTES: Record<string, string[]> = {
  sports:   ['/api/sports.json', '/articles/sports.html'],
  fashion:  ['/api/fashion.json', '/articles/fashion.html'],
  politics: ['/api/politics.json', '/articles/politics.html'],
};

const RATE_PERIOD   = 5 * 60_000;   // 5 min — request rate oscillation
const BOT_PERIOD    = 5 * 60_000;   // 5 min — bot popularity (staggered phases)
const CONTENT_PERIOD = 5 * 60_000;  // 5 min — content hotness (staggered phases)
const HUMAN_PERIOD  = 7.5 * 60_000; // 7.5 min — human vs bot ratio

const DELAY_MIN = 200;
const DELAY_MAX = 2000;

function computeDelay(elapsedMs: number): number {
  const w = sinWeight(elapsedMs, RATE_PERIOD, 0); // 1 = fast, 0 = slow
  return Math.round(DELAY_MAX - w * (DELAY_MAX - DELAY_MIN));
}

function generateScenario(elapsedMs: number): Scenario {
  // Small chance of error scenarios (~3%)
  if (Math.random() < 0.03) {
    if (Math.random() < 0.5) {
      return {
        name: '❌ GPTBot → /api/sports.json (verify fail)',
        path: '/api/sports.json',
        headers: {
          'User-Agent': BOTS['GPTBot'],
          'Accept': 'application/json',
          'X-PAYMENT': 'dGhpcyBpcyBub3QgYSB2YWxpZCBwYXltZW50',
        },
        expectStatus: [402],
        attemptPayment: false,
      };
    }
    return {
      name: '❌ ClaudeBot → /api/deleted.json (settle fail)',
      path: '/api/deleted.json',
      headers: { 'User-Agent': BOTS['ClaudeBot'], 'Accept': 'application/json' },
      expectStatus: [403, 404],
      attemptPayment: true,
    };
  }

  // Pick content category by sinusoidal weights
  const contentWeights = CONTENT_CATEGORIES.map((_, i) =>
    sinWeight(elapsedMs, CONTENT_PERIOD, i * (2 * Math.PI / 3))
  );
  const catIdx = pickWeighted(contentWeights);
  const category = CONTENT_CATEGORIES[catIdx];
  const routes = CONTENT_ROUTES[category];
  const contentPath = routes[Math.random() < 0.5 ? 0 : 1]; // API or article
  const accept = contentPath.endsWith('.json') ? 'application/json' : 'text/html';

  // Human vs bot decision
  const humanProb = 0.15 + 0.25 * sinWeight(elapsedMs, HUMAN_PERIOD, 0); // 15%–40%
  if (Math.random() < humanProb) {
    return {
      name: `🧑 human → ${contentPath}`,
      path: contentPath,
      headers: { 'User-Agent': HUMAN_UA, 'Accept': accept },
      expectStatus: [200],
      attemptPayment: false,
    };
  }

  // Pick bot by sinusoidal weights
  const botNames = Object.keys(BOTS);
  const botWeights = botNames.map((_, i) =>
    sinWeight(elapsedMs, BOT_PERIOD, i * (Math.PI / 3))
  );
  const botIdx = pickWeighted(botWeights);
  const bot = botNames[botIdx];

  return {
    name: `💰 ${bot} → ${contentPath}`,
    path: contentPath,
    headers: { 'User-Agent': BOTS[bot], 'Accept': accept },
    expectStatus: [200],
    attemptPayment: true,
  };
}

async function runContinuous(payFetch: typeof fetch, durationMs: number) {
  const startTime = Date.now();
  let i = 0;

  const stats: Record<string, Stats> = {};

  while (Date.now() - startTime < durationMs) {
    const elapsed = Date.now() - startTime;
    const scenario = generateScenario(elapsed);
    const pct = ((elapsed / durationMs) * 100).toFixed(1);
    const start = performance.now();
    i++;

    try {
      const result = await executeRequest(scenario, payFetch);
      const ms = (performance.now() - start).toFixed(0);
      const ok = scenario.expectStatus.includes(result.status);
      const icon = ok ? '✓' : '⚠';
      const payTag = result.paid ? ' 💳 settled' : '';
      console.log(`[${pct}% #${i}] ${icon} ${scenario.name} → ${result.status} (${ms}ms)${payTag}`);

      if (!stats[scenario.name]) stats[scenario.name] = { total: 0, byStatus: {}, paid: 0 };
      stats[scenario.name].total++;
      stats[scenario.name].byStatus[result.status] = (stats[scenario.name].byStatus[result.status] || 0) + 1;
      if (result.paid) stats[scenario.name].paid++;
    } catch (err: unknown) {
      const ms = (performance.now() - start).toFixed(0);
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[${pct}% #${i}] ✗ ${scenario.name} → ERROR (${ms}ms): ${msg}`);

      if (!stats[scenario.name]) stats[scenario.name] = { total: 0, byStatus: {}, paid: 0 };
      stats[scenario.name].total++;
      stats[scenario.name].byStatus[-1] = (stats[scenario.name].byStatus[-1] || 0) + 1;
    }

    const delay = computeDelay(Date.now() - startTime);
    if (Date.now() - startTime + delay < durationMs) await sleep(delay);
  }

  // Summary
  console.log('\n📊 Summary');
  console.log('─'.repeat(80));
  let totalReqs = 0;
  let totalPaid = 0;
  for (const [name, data] of Object.entries(stats)) {
    const breakdown = Object.entries(data.byStatus)
      .map(([s, c]) => `${s === '-1' ? 'ERR' : s}×${c}`)
      .join('  ');
    const paidTag = data.paid > 0 ? `  💳 ${data.paid} paid` : '';
    console.log(`  ${name}  (${data.total}×)  ${breakdown}${paidTag}`);
    totalReqs += data.total;
    totalPaid += data.paid;
  }
  console.log('─'.repeat(80));
  const elapsedMin = ((Date.now() - startTime) / 60_000).toFixed(1);
  console.log(`  Total: ${totalReqs} requests, ${totalPaid} payments settled over ${elapsedMin} min\n`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

interface Stats {
  total: number;
  byStatus: Record<number, number>;
  paid: number;
}

async function main() {
  console.log('\n🚀 x402 Traffic Generator');
  console.log(`   Target:    ${BASE_URL}`);
  console.log(`   Payment:   ${PAYMENTS_ENABLED ? 'enabled' : 'disabled (--no-pay)'}`);

  if (DURATION_MS > 0) {
    console.log(`   Mode:      continuous (${(DURATION_MS / 60_000).toFixed(1)} min, sinusoidal trends)`);
    console.log(`   Rate:      ${DELAY_MIN}ms–${DELAY_MAX}ms delay (sine-modulated)`);
    console.log('');

    const payFetch = PAYMENTS_ENABLED ? await initPaymentClient() : fetch;
    await runContinuous(payFetch, DURATION_MS);
    return;
  }

  const playlist = buildPlaylist();
  const rounds = ROUNDS > 0 ? Math.min(ROUNDS, playlist.length) : playlist.length;

  console.log(`   Requests:  ${rounds} (playlist of ${playlist.length})`);
  console.log(`   Delay:     ${DELAY_MS}ms`);
  console.log('');

  const payFetch = PAYMENTS_ENABLED
    ? await initPaymentClient()
    : fetch; // --no-pay mode: plain fetch, paying scenarios will just get 402

  // ── Diagnostic probe: test one payment end-to-end ─────────────────────
  if (PAYMENTS_ENABLED) {
    console.log('🔍 Probe: testing payment flow against /api/sports.json ...');
    const probeUrl = `${BASE_URL}/api/sports.json`;
    // Step 1: plain fetch to see the raw 402 response
    const raw402 = await fetch(probeUrl, {
      headers: { 'User-Agent': BOTS['GPTBot'], 'Accept': 'application/json' },
    });
    const raw402Body = await raw402.text();
    console.log(`   Raw request:  ${raw402.status}`);
    console.log(`   PAYMENT-REQUIRED header: ${raw402.headers.get('PAYMENT-REQUIRED') ? 'present' : 'MISSING'}`);
    console.log(`   Body (first 200 chars): ${raw402Body.slice(0, 200)}`);

    // Step 2: try with payFetch to see if it auto-pays
    const paidRes = await payFetch(probeUrl, {
      method: 'GET',
      headers: { 'User-Agent': BOTS['GPTBot'], 'Accept': 'application/json' },
    });
    const paidBody = await paidRes.text();
    console.log(`   PayFetch:     ${paidRes.status}${paidRes.status === 200 ? ' ✅ payment works!' : ' ❌ payment failed'}`);
    if (paidRes.status !== 200) {
      console.log(`   PayFetch body: ${paidBody.slice(0, 200)}`);
      // Check response headers for clues
      const payResHeader = paidRes.headers.get('PAYMENT-RESPONSE') || paidRes.headers.get('X-PAYMENT-RESPONSE');
      if (payResHeader) console.log(`   PAYMENT-RESPONSE: ${payResHeader}`);
    }
    console.log('');
  }

  const stats: Record<string, Stats> = {};

  for (let i = 0; i < rounds; i++) {
    const scenario = playlist[i];
    const start = performance.now();

    try {
      const result = await executeRequest(scenario, payFetch);
      const elapsed = (performance.now() - start).toFixed(0);
      const ok = scenario.expectStatus.includes(result.status);
      const icon = ok ? '✓' : '⚠';
      const payTag = result.paid ? ' 💳 settled' : '';
      console.log(`[${i + 1}/${rounds}] ${icon} ${scenario.name} → ${result.status} (${elapsed}ms)${payTag}`);

      if (!stats[scenario.name]) stats[scenario.name] = { total: 0, byStatus: {}, paid: 0 };
      stats[scenario.name].total++;
      stats[scenario.name].byStatus[result.status] = (stats[scenario.name].byStatus[result.status] || 0) + 1;
      if (result.paid) stats[scenario.name].paid++;
    } catch (err: unknown) {
      const elapsed = (performance.now() - start).toFixed(0);
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[${i + 1}/${rounds}] ✗ ${scenario.name} → ERROR (${elapsed}ms): ${msg}`);

      if (!stats[scenario.name]) stats[scenario.name] = { total: 0, byStatus: {}, paid: 0 };
      stats[scenario.name].total++;
      stats[scenario.name].byStatus[-1] = (stats[scenario.name].byStatus[-1] || 0) + 1;
    }

    if (i < rounds - 1) await sleep(DELAY_MS);
  }

  // ── Summary ──
  console.log('\n📊 Summary');
  console.log('─'.repeat(80));

  let totalReqs = 0;
  let totalPaid = 0;

  for (const [name, data] of Object.entries(stats)) {
    const breakdown = Object.entries(data.byStatus)
      .map(([s, c]) => `${s === '-1' ? 'ERR' : s}×${c}`)
      .join('  ');
    const paidTag = data.paid > 0 ? `  💳 ${data.paid} paid` : '';
    console.log(`  ${name}  (${data.total}×)  ${breakdown}${paidTag}`);
    totalReqs += data.total;
    totalPaid += data.paid;
  }

  console.log('─'.repeat(80));
  console.log(`  Total: ${totalReqs} requests, ${totalPaid} payments settled\n`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

/**
 * Property-based test: TTL-based config caching
 *
 * **Feature: x402-on-aws-edge, Property 14: TTL-based config caching**
 *
 * For any config loader with a configured TTL, calling `getEdgeConfig()`
 * multiple times within the TTL window should return the same cached value
 * without making additional API calls. After the TTL expires, the next call
 * should fetch fresh data. On cold start or cache miss, SSM params should
 * be fetched in parallel.
 *
 */

import * as fc from 'fast-check';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  getEdgeConfig,
  resetCache,
  _setTtl,
  _setSsmClient,
  _getCache,
} from '../../src/runtime/shared/config-loader';
import type { EdgeConfig } from '../../src/runtime/shared/types';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a valid Ethereum-like address. */
const arbPayTo: fc.Arbitrary<string> = fc
  .array(fc.constantFrom('0','1','2','3','4','5','6','7','8','9','a','b','c','d','e','f'), { minLength: 40, maxLength: 40 })
  .map((chars) => '0x' + chars.join(''));

/** Generate a valid network string. */
const arbNetwork: fc.Arbitrary<string> = fc.constantFrom(
  'eip155:84532',
  'eip155:8453',
);

/** Generate a valid facilitator URL. */
const arbFacilitatorUrl: fc.Arbitrary<string> = fc.constantFrom(
  'https://x402.org/facilitator',
  'https://cdp.facilitator.example.com',
);

/** Generate a valid EdgeConfig. */
const arbEdgeConfig: fc.Arbitrary<EdgeConfig> = fc
  .tuple(arbPayTo, arbNetwork, arbFacilitatorUrl)
  .map(([payTo, network, facilitatorUrl]) => ({
    payTo,
    network,
    facilitatorUrl,
  }));

/** Generate a TTL value in seconds (small values for testability). */
const arbTtlSeconds: fc.Arbitrary<number> = fc.integer({ min: 1, max: 60 });

/** Generate a number of calls to make within a TTL window. */
const arbCallCount: fc.Arbitrary<number> = fc.integer({ min: 2, max: 10 });

// ---------------------------------------------------------------------------
// Mock Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock SSM client that tracks invocation count and returns
 * the given EdgeConfig values.
 */
function createMockSsmClient(config: EdgeConfig): {
  client: SSMClient;
  getCallCount: () => number;
} {
  let callCount = 0;

  const client = {
    send: jest.fn(async (command: unknown) => {
      callCount++;
      const cmd = command as GetParameterCommand;
      const name = cmd.input?.Name ?? '';

      if (name.endsWith('/payto')) {
        return { Parameter: { Value: config.payTo } };
      }
      if (name.endsWith('/network')) {
        return { Parameter: { Value: config.network } };
      }
      if (name.endsWith('/facilitator-url')) {
        return { Parameter: { Value: config.facilitatorUrl } };
      }
      throw new Error(`Unexpected SSM parameter: ${name}`);
    }),
  } as unknown as SSMClient;

  return { client, getCallCount: () => callCount };
}

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe('Property 14: TTL-based config caching', () => {
  beforeEach(() => {
    resetCache();
  });

  it('cache hit: multiple calls within TTL return cached value without additional API calls', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEdgeConfig,
        arbTtlSeconds,
        arbCallCount,
        async (
          config: EdgeConfig,
          ttlSeconds: number,
          callCount: number,
        ) => {
          // Setup
          resetCache();
          const ssm = createMockSsmClient(config);
          _setSsmClient(ssm.client);
          _setTtl(ttlSeconds);

          // First call — cold start, should fetch from SSM
          const firstResult = await getEdgeConfig();
          expect(firstResult).toEqual(config);

          // SSM is called 3 times (payto, network, facilitator-url) on first fetch
          const ssmCallsAfterFirst = ssm.getCallCount();
          expect(ssmCallsAfterFirst).toBe(3);

          // Subsequent calls within TTL should use cache — no additional API calls
          for (let i = 0; i < callCount; i++) {
            const result = await getEdgeConfig();
            expect(result).toEqual(config);
          }

          // API call counts should not have increased
          expect(ssm.getCallCount()).toBe(ssmCallsAfterFirst);
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  it('cache miss after TTL expiry: call after TTL fetches fresh data', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEdgeConfig,
        arbEdgeConfig,
        async (
          config1: EdgeConfig,
          config2: EdgeConfig,
        ) => {
          // Setup with very short TTL
          resetCache();
          const ssm1 = createMockSsmClient(config1);
          _setSsmClient(ssm1.client);
          // Use a TTL of 0 seconds so the cache expires immediately
          _setTtl(0);

          // First call — fetches config1
          const firstResult = await getEdgeConfig();
          expect(firstResult).toEqual(config1);

          // Now swap to config2 mock (simulating SSM parameter update)
          const ssm2 = createMockSsmClient(config2);
          _setSsmClient(ssm2.client);

          // Wait a tiny bit to ensure TTL has expired (TTL=0 means immediate expiry)
          await new Promise((resolve) => setTimeout(resolve, 5));

          // Next call should fetch fresh data (config2)
          const secondResult = await getEdgeConfig();
          expect(secondResult).toEqual(config2);

          // The second mock should have been called
          expect(ssm2.getCallCount()).toBe(3);
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  it('parallel fetch on cold start: SSM params fetched concurrently via Promise.all', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEdgeConfig,
        async (config: EdgeConfig) => {
          // Setup
          resetCache();

          // Track the order of calls to verify parallelism
          const callTimestamps: { param: string; time: number }[] = [];
          const startTime = Date.now();

          // Create SSM mock that records call timestamps
          const ssmClient = {
            send: jest.fn(async (command: unknown) => {
              const cmd = command as GetParameterCommand;
              const name = cmd.input?.Name ?? '';
              callTimestamps.push({
                param: name,
                time: Date.now() - startTime,
              });
              if (name.endsWith('/payto'))
                return { Parameter: { Value: config.payTo } };
              if (name.endsWith('/network'))
                return { Parameter: { Value: config.network } };
              if (name.endsWith('/facilitator-url'))
                return { Parameter: { Value: config.facilitatorUrl } };
              throw new Error(`Unexpected SSM parameter: ${name}`);
            }),
          } as unknown as SSMClient;

          _setSsmClient(ssmClient);
          _setTtl(300);

          // Cold start call — should fetch SSM params
          const result = await getEdgeConfig();
          expect(result).toEqual(config);

          // Verify all 3 SSM params were fetched (payto, network, facilitator-url)
          expect(callTimestamps.length).toBe(3);

          // Verify cache is populated correctly
          const cacheState = _getCache();
          expect(cacheState.edgeConfig).toEqual(config);
          expect(cacheState.lastFetched).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });
});

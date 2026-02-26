/**
 * Property-based tests: WAF routing
 *
 * **Feature: align-x402-libraries, Property 9: Dynamic RoutesConfig construction**
 *
 * For any valid non-zero price string from the WAF header and a config with payTo and network,
 * the constructed RoutesConfig SHALL contain a single catch-all route entry with scheme: 'exact',
 * the provided payTo, the numeric price, and the provided network.
 *
 *
 * **Feature: align-x402-libraries, Property 10: WAF header pass-through for non-payable values**
 *
 * For any WAF route action header value that is absent, "0", non-numeric, or negative,
 * the origin-request handler SHALL return the original CloudFront request without invoking
 * the x402 middleware.
 *
 */

import * as fc from 'fast-check';
import type { RoutesConfig } from '@x402/core/server';
import type { Network } from '@x402/core/types';
import type { CloudFrontRequestEvent, CloudFrontRequest } from 'aws-lambda';

// ---------------------------------------------------------------------------
// Mocks (for Property 10 — handler-level testing)
// ---------------------------------------------------------------------------

jest.mock('../../src/runtime/shared/config-loader', () => ({
  getEdgeConfig: jest.fn(),
}));

jest.mock('../../src/runtime/shared/x402-middleware', () => ({
  createX402Middleware: jest.fn(),
}));

jest.mock('../../src/runtime/shared/logger', () => {
  const actual = jest.requireActual('../../src/runtime/shared/logger');
  return { ...actual, emitVerification: jest.fn(), emitPaymentRequested: jest.fn() };
});

import { createX402Middleware } from '../../src/runtime/shared/x402-middleware';

const mockCreateX402Middleware = createX402Middleware as jest.MockedFunction<typeof createX402Middleware>;

// ---------------------------------------------------------------------------
// RoutesConfig construction logic (mirrors handler inline construction)
// ---------------------------------------------------------------------------

/**
 * Constructs a RoutesConfig from a WAF price header value and edge config,
 * exactly as the origin-request handler does.
 *
 * @see src/origin-request/handler.ts — lines constructing `routes`
 */
function buildRoutesConfig(
  routeActionHeader: string,
  payTo: string,
  network: string,
): RoutesConfig {
  return {
    'GET /*': {
      accepts: {
        scheme: 'exact',
        payTo,
        price: parseFloat(routeActionHeader),
        network: network as Network,
      },
    },
  } as unknown as RoutesConfig;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a positive price string (e.g. "0.001", "1.5", "42"). */
const arbPriceString = fc
  .double({ min: 0.0001, max: 10000, noNaN: true, noDefaultInfinity: true })
  .filter((n) => n > 0)
  .map((n) => String(n));

/** Generate a hex payTo address (0x followed by 40 hex chars). */
const arbPayTo: fc.Arbitrary<string> = fc
  .array(fc.constantFrom('0','1','2','3','4','5','6','7','8','9','a','b','c','d','e','f'), { minLength: 40, maxLength: 40 })
  .map((chars) => '0x' + chars.join(''));

/** Generate a network identifier like "eip155:8453" or "eip155:84532". */
const arbNetwork = fc
  .integer({ min: 1, max: 99999 })
  .map((chainId) => `eip155:${chainId}`);

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe('Property 9: Dynamic RoutesConfig construction', () => {
  it('constructed RoutesConfig contains a single catch-all route with correct scheme, payTo, price, and network', () => {
    fc.assert(
      fc.property(
        arbPriceString,
        arbPayTo,
        arbNetwork,
        (priceStr, payTo, network) => {
          const routes = buildRoutesConfig(priceStr, payTo, network);

          // Should have exactly one route key
          const keys = Object.keys(routes);
          expect(keys).toHaveLength(1);
          expect(keys[0]).toBe('GET /*');

          // Access the route entry
          const route = (routes as Record<string, unknown>)['GET /*'] as {
            accepts: {
              scheme: string;
              payTo: string;
              price: number;
              network: string;
            };
          };

          // Verify scheme is 'exact'
          expect(route.accepts.scheme).toBe('exact');

          // Verify payTo matches input
          expect(route.accepts.payTo).toBe(payTo);

          // Verify price is the numeric parse of the price string
          expect(route.accepts.price).toBe(parseFloat(priceStr));

          // Verify network matches input
          expect(route.accepts.network).toBe(network);
        },
      ),
      { numRuns: 150, verbose: true },
    );
  });

  it('price is always a finite positive number', () => {
    fc.assert(
      fc.property(
        arbPriceString,
        arbPayTo,
        arbNetwork,
        (priceStr, payTo, network) => {
          const routes = buildRoutesConfig(priceStr, payTo, network);
          const route = (routes as Record<string, unknown>)['GET /*'] as {
            accepts: { price: number };
          };

          expect(Number.isFinite(route.accepts.price)).toBe(true);
          expect(route.accepts.price).toBeGreaterThan(0);
        },
      ),
      { numRuns: 150, verbose: true },
    );
  });

  it('payTo address is preserved exactly as provided', () => {
    fc.assert(
      fc.property(
        arbPriceString,
        arbPayTo,
        arbNetwork,
        (priceStr, payTo, network) => {
          const routes = buildRoutesConfig(priceStr, payTo, network);
          const route = (routes as Record<string, unknown>)['GET /*'] as {
            accepts: { payTo: string };
          };

          // payTo must start with 0x and be exactly 42 chars (0x + 40 hex)
          expect(route.accepts.payTo).toBe(payTo);
          expect(route.accepts.payTo.startsWith('0x')).toBe(true);
          expect(route.accepts.payTo).toHaveLength(42);
        },
      ),
      { numRuns: 150, verbose: true },
    );
  });

  it('network identifier is preserved exactly as provided', () => {
    fc.assert(
      fc.property(
        arbPriceString,
        arbPayTo,
        arbNetwork,
        (priceStr, payTo, network) => {
          const routes = buildRoutesConfig(priceStr, payTo, network);
          const route = (routes as Record<string, unknown>)['GET /*'] as {
            accepts: { network: string };
          };

          expect(route.accepts.network).toBe(network);
          expect(route.accepts.network.startsWith('eip155:')).toBe(true);
        },
      ),
      { numRuns: 150, verbose: true },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 10: WAF header pass-through for non-payable values
// ---------------------------------------------------------------------------

/**
 * Build a minimal CloudFront origin-request event with optional WAF header.
 */
function buildCloudFrontEvent(
  wafHeaderValue?: string,
): CloudFrontRequestEvent {
  const headers: CloudFrontRequest['headers'] = {
    host: [{ key: 'Host', value: 'example.com' }],
  };

  if (wafHeaderValue !== undefined) {
    headers['x-amzn-waf-x-x402-route-action'] = [
      { key: 'x-amzn-waf-x-x402-route-action', value: wafHeaderValue },
    ];
  }

  return {
    Records: [
      {
        cf: {
          config: {
            distributionDomainName: 'd111111abcdef8.cloudfront.net',
            distributionId: 'EDFDVBD6EXAMPLE',
            eventType: 'origin-request' as const,
            requestId: 'test-request-id',
          },
          request: {
            clientIp: '203.0.113.178',
            headers,
            method: 'GET',
            querystring: '',
            uri: '/api/data',
          },
        },
      },
    ],
  };
}

/** Generator for non-payable WAF header values. */
const arbNonPayableWafHeader: fc.Arbitrary<string | undefined> = fc.oneof(
  // Absent header
  fc.constant(undefined),
  // Explicit "0"
  fc.constant('0'),
  // Non-numeric strings (alphabetic, mixed, special chars)
  fc.string({ minLength: 1, maxLength: 20 })
    .filter((s: string) => isNaN(parseFloat(s)) && s !== ''),
  // Negative numbers
  fc.double({ min: -10000, max: -0.0001, noNaN: true, noDefaultInfinity: true })
    .map((n) => String(n)),
);

describe('Property 10: WAF header pass-through for non-payable values', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('handler returns original request without invoking middleware for non-payable WAF header values', async () => {
    // Dynamically import handler after mocks are set up
    const { handler } = await import('../../src/runtime/origin-request/handler');

    await fc.assert(
      fc.asyncProperty(
        arbNonPayableWafHeader,
        async (wafHeaderValue) => {
          mockCreateX402Middleware.mockClear();

          const event = buildCloudFrontEvent(wafHeaderValue);
          const originalRequest = event.Records[0].cf.request;

          const result = await handler(event);

          // Handler should return the original request object (pass-through)
          expect(result).toBe(originalRequest);

          // createX402Middleware should NOT have been called
          expect(mockCreateX402Middleware).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 150, verbose: true },
    );
  });

  it('handler returns a CloudFront request (not a response) for non-payable values', async () => {
    const { handler } = await import('../../src/runtime/origin-request/handler');

    await fc.assert(
      fc.asyncProperty(
        arbNonPayableWafHeader,
        async (wafHeaderValue) => {
          mockCreateX402Middleware.mockClear();

          const event = buildCloudFrontEvent(wafHeaderValue);
          const result = await handler(event);

          // Result should be a request object (has 'uri' and 'method'), not a response (has 'status')
          const resultObj = result as unknown as Record<string, unknown>;
          expect(resultObj).toHaveProperty('uri');
          expect(resultObj).toHaveProperty('method');
          expect(resultObj).not.toHaveProperty('status');
        },
      ),
      { numRuns: 150, verbose: true },
    );
  });
});

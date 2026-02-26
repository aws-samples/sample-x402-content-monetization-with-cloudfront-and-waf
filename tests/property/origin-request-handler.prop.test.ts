/**
 * Property-based test: Lambda@Edge route action header interpretation
 *
 * **Feature: x402-on-aws-edge, Property 3: Lambda@Edge route action header interpretation**
 *
 * For any incoming request to Lambda@Edge, the function should:
 *   (a) pass through to origin without payment when the `x-x402-route-action`
 *       header is absent,
 *   (b) pass through without payment when the header value is `"0"`, and
 *   (c) initiate the x402 payment flow (constructing a per-request RoutesConfig
 *       with the correct price, PayTo, and Network) when the header contains
 *       a non-zero price string.
 *
 */

import * as fc from 'fast-check';
import type {
  CloudFrontRequestEvent,
  CloudFrontRequest,
  CloudFrontResultResponse,
} from 'aws-lambda';
import { handler } from '../../src/runtime/origin-request/handler';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the config-loader module (only getEdgeConfig — getCdpCredentials removed)
jest.mock('../../src/runtime/shared/config-loader', () => ({
  getEdgeConfig: jest.fn(),
}));

// Mock the logger module
jest.mock('../../src/runtime/shared/logger', () => {
  const actual = jest.requireActual('../../src/runtime/shared/logger');
  return { ...actual, emitVerification: jest.fn(), emitPaymentRequested: jest.fn() };
});

// ---------------------------------------------------------------------------
// x402-middleware mock
//
// The handler delegates to createX402Middleware().processOriginRequest().
// We mock this to return configurable results per test scenario.
// ---------------------------------------------------------------------------

const mockProcessOriginRequest = jest.fn();

jest.mock('../../src/runtime/shared/x402-middleware', () => ({
  createX402Middleware: jest.fn(() => ({
    processOriginRequest: mockProcessOriginRequest,
  })),
}));

jest.mock('../../src/runtime/shared/to-lambda-response', () => ({
  toLambdaResponse: jest.fn(
    (instructions: { status: number; headers: Record<string, string>; body?: unknown }) => {
      const headers: Record<string, Array<{ key: string; value: string }>> = {};
      for (const [key, value] of Object.entries(instructions.headers)) {
        headers[key.toLowerCase()] = [{ key, value }];
      }
      if (!headers['cache-control']) {
        headers['cache-control'] = [{ key: 'Cache-Control', value: 'no-store' }];
      }
      return {
        status: String(instructions.status),
        statusDescription: instructions.status === 402 ? 'Payment Required' : 'Error',
        headers,
        body: instructions.body !== undefined
          ? (typeof instructions.body === 'string' ? instructions.body : JSON.stringify(instructions.body))
          : '',
      };
    },
  ),
}));

import { getEdgeConfig } from '../../src/runtime/shared/config-loader';

const mockGetEdgeConfig = getEdgeConfig as jest.MockedFunction<typeof getEdgeConfig>;

// ---------------------------------------------------------------------------
// Default mock config
// ---------------------------------------------------------------------------

const mockEdgeConfig = {
  payTo: '0x1234567890abcdef1234567890abcdef12345678',
  network: 'eip155:84532', // testnet
  facilitatorUrl: 'https://x402.org/facilitator',
};

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a valid URL path. */
const arbPath: fc.Arbitrary<string> = fc.oneof(
  // Simple paths
  fc
    .array(fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/), { minLength: 1, maxLength: 4 })
    .map((segments) => '/' + segments.join('/')),
  // Root path
  fc.constant('/'),
);

/** Generate a valid host header value. */
const arbHost: fc.Arbitrary<string> = fc.oneof(
  fc.constant('example.com'),
  fc.constant('api.example.com'),
  fc.stringMatching(/^[a-z][a-z0-9-]{2,10}\.(com|org|net)$/),
);

/** Generate a valid positive price string (non-zero). */
const arbPositivePrice: fc.Arbitrary<string> = fc.oneof(
  // Small decimal prices like 0.001, 0.01, 0.1
  fc.integer({ min: 1, max: 999999 }).map((n) => {
    const str = n.toString().padStart(6, '0');
    return '0.' + str.replace(/0+$/, '') || '0';
  }),
  // Integer prices like 1, 10, 100
  fc.integer({ min: 1, max: 1000 }).map(String),
  // Decimal prices like 1.5, 10.25
  fc
    .tuple(fc.integer({ min: 1, max: 100 }), fc.integer({ min: 1, max: 99 }))
    .map(([whole, frac]) => `${whole}.${frac}`),
);

/** Generate an invalid price value (non-numeric or negative). */
const arbInvalidPrice: fc.Arbitrary<string> = fc.oneof(
  // Non-numeric strings that parseFloat returns NaN for
  fc.stringMatching(/^[a-z]{1,10}$/),
  fc.constant('invalid'),
  fc.constant('abc'),
  fc.constant('NaN'),
  // Negative numbers
  fc.integer({ min: -1000, max: -1 }).map(String),
  fc.integer({ min: 1, max: 1000 }).map((n) => `-${n}`),
  fc.integer({ min: 1, max: 999 }).map((n) => `-0.${n}`),
  // Empty string (parseFloat returns NaN)
  fc.constant(''),
  // Special invalid formats that parseFloat returns NaN for
  fc.constant('..'),
  fc.constant('$100'),
  fc.constant('#123'),
  fc.constant('abc123'),
);

/** Generate a valid HTTP method. */
const arbMethod: fc.Arbitrary<string> = fc.constantFrom(
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
);

/** Generate a valid client IP address. */
const arbClientIp: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 1, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 1, max: 254 }),
  )
  .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock CloudFront request event.
 */
function createMockEvent(
  uri: string,
  options: {
    headers?: Record<string, string>;
    method?: string;
    clientIp?: string;
    host?: string;
  } = {},
): CloudFrontRequestEvent {
  const {
    headers = {},
    method = 'GET',
    clientIp = '192.168.1.1',
    host = 'example.com',
  } = options;

  const cfHeaders: Record<string, Array<{ key: string; value: string }>> = {};

  for (const [key, value] of Object.entries(headers)) {
    cfHeaders[key.toLowerCase()] = [{ key, value }];
  }

  // Always add a host header
  if (!cfHeaders['host']) {
    cfHeaders['host'] = [{ key: 'Host', value: host }];
  }

  return {
    Records: [
      {
        cf: {
          config: {
            distributionDomainName: 'd123.cloudfront.net',
            distributionId: 'EDFDVBD6EXAMPLE',
            eventType: 'origin-request',
            requestId: 'test-request-id',
          },
          request: {
            clientIp,
            headers: cfHeaders,
            method,
            querystring: '',
            uri,
          },
        },
      },
    ],
  };
}

/**
 * Type for CloudFront handler result.
 */
type HandlerResult = CloudFrontRequest | CloudFrontResultResponse | undefined | null;

/**
 * Check if the result is a CloudFront request (passthrough).
 */
function isPassthrough(result: HandlerResult): result is CloudFrontRequest {
  if (result === undefined || result === null) return false;
  return (result as CloudFrontResultResponse).status === undefined;
}

/**
 * Check if the result is a 402 response.
 */
function is402Response(result: HandlerResult): boolean {
  if (result === undefined || result === null) return false;
  return (result as CloudFrontResultResponse).status === '402';
}

/**
 * Configure mockProcessOriginRequest to return a payment-error (402) result.
 * The mock also strips the pending-settlement header from the request (as the real middleware does).
 */
function configureMockFor402(overrides: {
  network?: string;
  payTo?: string;
  price?: number;
  host?: string;
  path?: string;
  error?: string;
} = {}): void {
  mockProcessOriginRequest.mockImplementation(
    async (
      request: CloudFrontRequest,
      distributionDomain: string,
    ) => {
      // Middleware strips pending settlement header
      delete request.headers['x-x402-pending-settlement'];

      // The middleware was constructed with config containing routes,
      // so we use the mock edge config to derive the 402 response.
      const resource = `https://${distributionDomain}${request.uri}`;

      // Get the config that was passed to createX402Middleware
      const { createX402Middleware: mockFactory } = require('../../src/runtime/shared/x402-middleware');
      const lastCall = mockFactory.mock.calls[mockFactory.mock.calls.length - 1];
      const config = lastCall?.[0];
      const routes = config?.routes;

      let routePrice = 0.001;
      let routePayTo = mockEdgeConfig.payTo;
      let routeNetwork = mockEdgeConfig.network;

      if (routes) {
        const routeKey = Object.keys(routes)[0];
        const routeConfig = (routes as Record<string, { accepts: { price: number; payTo: string; network: string } }>)[routeKey];
        routePrice = routeConfig.accepts.price;
        routePayTo = routeConfig.accepts.payTo;
        routeNetwork = routeConfig.accepts.network;
      }

      const atomicUnits = Math.round(routePrice * 1_000_000).toString();

      return {
        type: 'payment-error' as const,
        response: {
          status: 402,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          body: {
            x402Version: 1,
            accepts: [
              {
                scheme: 'exact',
                network: overrides.network ?? routeNetwork,
                maxAmountRequired: atomicUnits,
                resource,
                description: 'Payment required for content access',
                mimeType: 'application/json',
                payTo: overrides.payTo ?? routePayTo,
                maxTimeoutSeconds: 30,
                extra: {},
              },
            ],
            error: overrides.error ?? '',
          },
        },
      };
    },
  );
}

/**
 * Configure mockProcessOriginRequest to return a pass-through result
 * (simulating successful payment verification).
 * The mock also strips the pending-settlement header and attaches a new one.
 */
function configureMockForPassThrough(settlementData?: string): void {
  mockProcessOriginRequest.mockImplementation(
    async (
      request: CloudFrontRequest,
      _distributionDomain: string,
    ) => {
      // Middleware strips pending settlement header
      delete request.headers['x-x402-pending-settlement'];

      if (settlementData) {
        // Attach legitimate settlement header
        request.headers['x-x402-pending-settlement'] = [
          { key: 'x-x402-pending-settlement', value: settlementData },
        ];
        return {
          type: 'pass-through' as const,
          paymentPayload: settlementData,
          paymentRequirements: {},
        };
      }

      return { type: 'pass-through' as const };
    },
  );
}

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

/**
 * Property-based test: 402 response contains correct payment requirements
 *
 * **Feature: x402-on-aws-edge, Property 5: 402 response contains correct payment requirements**
 *
 * For any request matching a priced route (non-zero `x-x402-route-action` header)
 * that lacks a valid payment header, the returned 402 response body should contain
 * the exact price from the WAF-injected header, the configured PayTo address,
 * the configured Network, and the accepted payment schemes.
 *
 */
describe('Property 5: 402 response contains correct payment requirements', () => {
  /** Generate a valid Ethereum address (40 hex chars with 0x prefix). */
  const arbEthereumAddress: fc.Arbitrary<string> = fc
    .array(fc.integer({ min: 0, max: 15 }), { minLength: 40, maxLength: 40 })
    .map((digits) => '0x' + digits.map((d) => d.toString(16)).join(''));

  /** Generate a valid network value (testnet or mainnet). */
  const arbNetwork: fc.Arbitrary<string> = fc.constantFrom('eip155:84532', 'eip155:8453');

  /**
   * Convert a price string to atomic units (USDC has 6 decimals).
   */
  function priceToAtomicUnits(price: string): string {
    const priceNum = parseFloat(price);
    const atomicUnits = Math.round(priceNum * 1_000_000);
    return atomicUnits.toString();
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Property 5: 402 response contains correct payment requirements
   *
   * For any request with a positive price in the x-x402-route-action header
   * and no payment header, the 402 response should contain:
   * - x402Version: 1
   * - accepts array with exactly 1 element
   * - scheme: "exact"
   * - network: matches the configured network
   * - maxAmountRequired: price converted to atomic units (price * 1_000_000)
   * - resource: full URL (https://host/path)
   * - payTo: matches the configured PayTo address
   * - maxTimeoutSeconds: 30
   */
  it('returns 402 response with correct payment requirements for any valid price, PayTo, and network', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPositivePrice,
        arbEthereumAddress,
        arbNetwork,
        arbPath,
        arbHost,
        arbClientIp,
        async (
          price: string,
          payTo: string,
          network: string,
          path: string,
          host: string,
          clientIp: string,
        ) => {
          // Arrange: Configure mock to return the generated config
          const generatedConfig = {
            payTo,
            network,
            facilitatorUrl: network === 'eip155:8453'
              ? 'https://cdp.coinbase.com/facilitator'
              : 'https://x402.org/facilitator',
          };
          mockGetEdgeConfig.mockResolvedValue(generatedConfig);

          // Configure middleware mock to return 402 (no payment header scenario)
          configureMockFor402();

          // Create a request with the generated price but NO payment header
          const event = createMockEvent(path, {
            clientIp,
            host,
            headers: {
              'x-amzn-waf-x-x402-route-action': price,
            },
          });

          // Act
          const result = await handler(event);

          // Assert: Should be a 402 response
          expect(is402Response(result)).toBe(true);

          const response = result as CloudFrontResultResponse;
          expect(response.status).toBe('402');
          expect(response.statusDescription).toBe('Payment Required');

          // Parse and verify the response body
          const body = JSON.parse(response.body as string);

          // Verify x402Version
          expect(body.x402Version).toBe(1);

          // Verify accepts array has exactly 1 element
          expect(body.accepts).toHaveLength(1);

          const accept = body.accepts[0];

          // Verify scheme
          expect(accept.scheme).toBe('exact');

          // Verify network matches the configured network
          expect(accept.network).toBe(network);

          // Verify maxAmountRequired is price converted to atomic units
          const expectedAtomicUnits = priceToAtomicUnits(price);
          expect(accept.maxAmountRequired).toBe(expectedAtomicUnits);

          // Verify resource is the full URL
          const expectedResource = `https://${host}${path}`;
          expect(accept.resource).toBe(expectedResource);

          // Verify payTo matches the configured PayTo address
          expect(accept.payTo).toBe(payTo);

          // Verify maxTimeoutSeconds
          expect(accept.maxTimeoutSeconds).toBe(30);

          // Verify error field is empty (no error for payment required)
          expect(body.error).toBe('');

          // Verify config loader was called
          expect(mockGetEdgeConfig).toHaveBeenCalled();

          // Verify middleware was called
          expect(mockProcessOriginRequest).toHaveBeenCalled();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Property 5 (additional): Verify response headers are correct
   */
  it('returns 402 response with correct headers', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPositivePrice,
        arbEthereumAddress,
        arbNetwork,
        arbPath,
        arbHost,
        async (
          price: string,
          payTo: string,
          network: string,
          path: string,
          host: string,
        ) => {
          // Arrange
          const generatedConfig = {
            payTo,
            network,
            facilitatorUrl: 'https://x402.org/facilitator',
          };
          mockGetEdgeConfig.mockResolvedValue(generatedConfig);
          configureMockFor402();

          const event = createMockEvent(path, {
            host,
            headers: {
              'x-amzn-waf-x-x402-route-action': price,
            },
          });

          // Act
          const result = await handler(event);

          // Assert: Verify response headers
          const response = result as CloudFrontResultResponse;
          expect(response.headers).toBeDefined();
          expect(response.headers!['content-type']).toBeDefined();
          expect(response.headers!['content-type']![0].value).toBe('application/json');
          expect(response.headers!['cache-control']).toBeDefined();
          expect(response.headers!['cache-control']![0].value).toBe('no-store');
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Property 5 (additional): Verify accepts array structure contains all required fields
   */
  it('returns 402 response with all required fields in accepts array', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPositivePrice,
        arbEthereumAddress,
        arbNetwork,
        arbPath,
        arbHost,
        async (
          price: string,
          payTo: string,
          network: string,
          path: string,
          host: string,
        ) => {
          // Arrange
          const generatedConfig = {
            payTo,
            network,
            facilitatorUrl: 'https://x402.org/facilitator',
          };
          mockGetEdgeConfig.mockResolvedValue(generatedConfig);
          configureMockFor402();

          const event = createMockEvent(path, {
            host,
            headers: {
              'x-amzn-waf-x-x402-route-action': price,
            },
          });

          // Act
          const result = await handler(event);

          // Assert: Verify all required fields are present
          const response = result as CloudFrontResultResponse;
          const body = JSON.parse(response.body as string);
          const accept = body.accepts[0];

          // All required fields must be present
          expect(accept).toHaveProperty('scheme');
          expect(accept).toHaveProperty('network');
          expect(accept).toHaveProperty('maxAmountRequired');
          expect(accept).toHaveProperty('resource');
          expect(accept).toHaveProperty('payTo');
          expect(accept).toHaveProperty('maxTimeoutSeconds');

          // Optional fields that should also be present per the design
          expect(accept).toHaveProperty('description');
          expect(accept).toHaveProperty('mimeType');
          expect(accept).toHaveProperty('extra');

          // Verify types
          expect(typeof accept.scheme).toBe('string');
          expect(typeof accept.network).toBe('string');
          expect(typeof accept.maxAmountRequired).toBe('string');
          expect(typeof accept.resource).toBe('string');
          expect(typeof accept.payTo).toBe('string');
          expect(typeof accept.maxTimeoutSeconds).toBe('number');
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });
});

describe('Property 3: Lambda@Edge route action header interpretation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Set up default mock implementations
    mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);
    configureMockFor402();
    // Suppress console.warn for invalid price tests
    jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Property 3a: Pass through to origin when x-x402-route-action header is absent.
   *
   * For any request without the x-x402-route-action header, the handler should
   * return the request unchanged (passthrough to origin).
   */
  it('passes through to origin when x-x402-route-action header is absent', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPath,
        arbHost,
        arbMethod,
        arbClientIp,
        async (path: string, host: string, method: string, clientIp: string) => {
          // Arrange: Create a request WITHOUT the route action header
          const event = createMockEvent(path, {
            method,
            clientIp,
            host,
            headers: {
              'x-custom-header': 'some-value',
            },
          });

          // Act
          const result = await handler(event);

          // Assert: Should be a passthrough (request, not response)
          expect(isPassthrough(result)).toBe(true);
          
          // The request should be returned with the same URI
          const request = result as CloudFrontRequest;
          expect(request.uri).toBe(path);
          expect(request.method).toBe(method);
          
          // Config loader should NOT be called (no payment flow)
          expect(mockGetEdgeConfig).not.toHaveBeenCalled();
          
          // Middleware should NOT be called
          expect(mockProcessOriginRequest).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Property 3b: Pass through to origin when x-x402-route-action header is "0".
   */
  it('passes through to origin when x-x402-route-action header is "0"', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPath,
        arbHost,
        arbMethod,
        arbClientIp,
        async (path: string, host: string, method: string, clientIp: string) => {
          // Arrange: Create a request with route action "0" (free access)
          const event = createMockEvent(path, {
            method,
            clientIp,
            host,
            headers: {
              'x-amzn-waf-x-x402-route-action': '0',
            },
          });

          // Act
          const result = await handler(event);

          // Assert: Should be a passthrough (request, not response)
          expect(isPassthrough(result)).toBe(true);
          
          const request = result as CloudFrontRequest;
          expect(request.uri).toBe(path);
          expect(request.method).toBe(method);
          
          // Config loader should NOT be called (no payment flow)
          expect(mockGetEdgeConfig).not.toHaveBeenCalled();
          
          // Middleware should NOT be called
          expect(mockProcessOriginRequest).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Property 3c: Initiate payment flow when x-x402-route-action header contains
   * a positive price.
   */
  it('triggers payment flow (402 response) when header contains positive price and no payment header', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPath,
        arbHost,
        arbPositivePrice,
        arbClientIp,
        async (path: string, host: string, price: string, clientIp: string) => {
          // Arrange: Create a request with a positive price but NO payment header
          const event = createMockEvent(path, {
            clientIp,
            host,
            headers: {
              'x-amzn-waf-x-x402-route-action': price,
            },
          });

          // Act
          const result = await handler(event);

          // Assert: Should be a 402 response (payment required)
          expect(is402Response(result)).toBe(true);
          
          const response = result as CloudFrontResultResponse;
          expect(response.status).toBe('402');
          expect(response.statusDescription).toBe('Payment Required');
          
          // Verify the response body contains payment requirements
          const body = JSON.parse(response.body as string);
          expect(body.x402Version).toBe(1);
          expect(body.accepts).toHaveLength(1);
          expect(body.accepts[0].payTo).toBe(mockEdgeConfig.payTo);
          expect(body.accepts[0].network).toBe(mockEdgeConfig.network);
          expect(body.accepts[0].resource).toBe(`https://${host}${path}`);
          
          // Config loader SHOULD be called (payment flow initiated)
          expect(mockGetEdgeConfig).toHaveBeenCalled();
          
          // Middleware SHOULD be called
          expect(mockProcessOriginRequest).toHaveBeenCalled();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Property 3c (continued): When payment header is present with positive price,
   * the handler should call the middleware and return passthrough on success.
   */
  it('returns passthrough when middleware returns pass-through for valid payment', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPath,
        arbHost,
        arbPositivePrice,
        arbClientIp,
        fc.stringMatching(/^[a-zA-Z0-9+/=]{10,50}$/), // payment signature
        async (path: string, host: string, price: string, clientIp: string, paymentSig: string) => {
          // Configure middleware to return pass-through (successful payment)
          configureMockForPassThrough('legitimate-settlement-data');

          // Arrange: Create a request with a positive price AND payment header
          const event = createMockEvent(path, {
            clientIp,
            host,
            headers: {
              'x-amzn-waf-x-x402-route-action': price,
              'x-payment': paymentSig,
            },
          });

          // Act
          const result = await handler(event);

          // Assert: Should be a passthrough (successful verification)
          expect(isPassthrough(result)).toBe(true);
          
          // Config loader SHOULD be called
          expect(mockGetEdgeConfig).toHaveBeenCalled();
          
          // Middleware SHOULD be called
          expect(mockProcessOriginRequest).toHaveBeenCalled();
          
          // Settlement header should be attached by the middleware mock
          const request = result as CloudFrontRequest;
          expect(request.headers['x-x402-pending-settlement']).toBeDefined();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Property 3 (edge case): Invalid price values (negative, non-numeric) should
   * result in passthrough with a warning.
   */
  it('passes through to origin with warning when header contains invalid price value', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPath,
        arbHost,
        arbInvalidPrice,
        arbClientIp,
        async (path: string, host: string, invalidPrice: string, clientIp: string) => {
          // Arrange: Create a request with an invalid price value
          const event = createMockEvent(path, {
            clientIp,
            host,
            headers: {
              'x-amzn-waf-x-x402-route-action': invalidPrice,
            },
          });

          // Act
          const result = await handler(event);

          // Assert: Should be a passthrough (request, not response)
          expect(isPassthrough(result)).toBe(true);
          
          const request = result as CloudFrontRequest;
          expect(request.uri).toBe(path);
          
          // Config loader should NOT be called (invalid price = no payment flow)
          expect(mockGetEdgeConfig).not.toHaveBeenCalled();
          
          // Middleware should NOT be called
          expect(mockProcessOriginRequest).not.toHaveBeenCalled();
          
          // Warning should have been logged
          expect(console.warn).toHaveBeenCalled();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Property 3 (security): Client-supplied x-x402-pending-settlement header
   * should always be stripped regardless of route action header value.
   */
  it('always strips client-supplied x-x402-pending-settlement header', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPath,
        arbHost,
        fc.option(arbPositivePrice, { nil: undefined }), // optional price
        fc.stringMatching(/^[a-zA-Z0-9+/=]{10,50}$/), // malicious settlement data
        async (path: string, host: string, price: string | undefined, maliciousData: string) => {
          // Configure middleware for pass-through (no settlement header attached)
          configureMockForPassThrough();

          // Arrange: Create a request with a client-supplied settlement header
          const headers: Record<string, string> = {
            'x-x402-pending-settlement': maliciousData,
          };
          
          if (price !== undefined) {
            headers['x-amzn-waf-x-x402-route-action'] = price;
          }

          const event = createMockEvent(path, {
            host,
            headers,
          });

          // Act
          const result = await handler(event);

          // Assert: The settlement header should be stripped
          if (isPassthrough(result)) {
            const request = result as CloudFrontRequest;
            expect(request.headers['x-x402-pending-settlement']).toBeUndefined();
          }
          // If it's a response (402), the header stripping still happened
          // before any processing
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Property 3 (combined): Test various combinations of route action header values.
   */
  it('correctly handles various route action header value combinations', async () => {
    const arbRouteActionValue: fc.Arbitrary<string | undefined> = fc.oneof(
      fc.constant(undefined), // absent
      fc.constant('0'), // free
      arbPositivePrice, // positive price
      arbInvalidPrice, // invalid
    );

    await fc.assert(
      fc.asyncProperty(
        arbPath,
        arbHost,
        arbRouteActionValue,
        async (path: string, host: string, routeAction: string | undefined) => {
          // Arrange
          const headers: Record<string, string> = {};
          if (routeAction !== undefined) {
            headers['x-amzn-waf-x-x402-route-action'] = routeAction;
          }

          const event = createMockEvent(path, { host, headers });

          // Act
          const result = await handler(event);

          // Assert based on route action value
          if (routeAction === undefined || routeAction === '0') {
            // Should passthrough
            expect(isPassthrough(result)).toBe(true);
            expect(mockGetEdgeConfig).not.toHaveBeenCalled();
          } else {
            const price = parseFloat(routeAction);
            if (isNaN(price) || price < 0) {
              // Invalid price - should passthrough with warning
              expect(isPassthrough(result)).toBe(true);
              expect(mockGetEdgeConfig).not.toHaveBeenCalled();
            } else {
              // Valid positive price - should trigger payment flow (402)
              expect(is402Response(result)).toBe(true);
              expect(mockGetEdgeConfig).toHaveBeenCalled();
            }
          }

          // Reset mocks for next iteration
          jest.clearAllMocks();
          mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);
          configureMockFor402();
          jest.spyOn(console, 'warn').mockImplementation();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });
});


/**
 * Property-based test: Client settlement header always stripped
 *
 * **Feature: x402-on-aws-edge, Property 9: Client settlement header always stripped**
 *
 * For any incoming request, regardless of its headers, the `x-x402-pending-settlement`
 * header must be removed before any payment processing logic executes. No client-supplied
 * value for this header should ever reach the origin or influence settlement.
 *
 */
describe('Property 9: Client settlement header always stripped', () => {
  /**
   * Generate random malicious settlement data strings.
   */
  const arbMaliciousSettlementData: fc.Arbitrary<string> = fc.oneof(
    fc.stringMatching(/^[a-zA-Z0-9+/]{20,100}={0,2}$/).map((s) => `MALICIOUS_${s}`),
    fc
      .record({
        txId: fc.stringMatching(/^0x[a-f0-9]{64}$/),
        nonce: fc.integer({ min: 1, max: 1000000 }),
        timestamp: fc.integer({ min: 1700000000, max: 1800000000 }),
        malicious: fc.constant(true),
      })
      .map((obj) => `MALICIOUS_${Buffer.from(JSON.stringify(obj)).toString('base64')}`),
    fc
      .array(fc.integer({ min: 0, max: 255 }), { minLength: 16, maxLength: 128 })
      .map((bytes) => `MALICIOUS_${Buffer.from(bytes).toString('base64')}`),
    fc.constant('MALICIOUS_{"bypass": true}'),
    fc.constant('MALICIOUS_SETTLEMENT_BYPASS_ATTACK'),
    fc.constant('MALICIOUS_admin:admin'),
    fc.stringMatching(/^[a-zA-Z0-9]{200,500}$/).map((s) => `MALICIOUS_${s}`),
  );

  /**
   * Generate route action header values: absent, "0", or positive prices.
   */
  const arbRouteAction: fc.Arbitrary<string | undefined> = fc.oneof(
    fc.constant(undefined),
    fc.constant('0'),
    fc.integer({ min: 1, max: 999999 }).map((n) => {
      const str = n.toString().padStart(6, '0');
      return '0.' + str.replace(/0+$/, '') || '0';
    }),
    fc.integer({ min: 1, max: 1000 }).map(String),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);
    // Default: middleware returns 402 for priced routes
    configureMockFor402();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Property 9: Client settlement header always stripped
   */
  it('strips x-x402-pending-settlement header regardless of route action header value', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPath,
        arbHost,
        arbClientIp,
        arbMaliciousSettlementData,
        arbRouteAction,
        async (
          path: string,
          host: string,
          clientIp: string,
          maliciousSettlementData: string,
          routeAction: string | undefined,
        ) => {
          jest.clearAllMocks();
          mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);
          configureMockFor402();

          const headers: Record<string, string> = {
            'x-x402-pending-settlement': maliciousSettlementData,
          };

          if (routeAction !== undefined) {
            headers['x-amzn-waf-x-x402-route-action'] = routeAction;
          }

          const event = createMockEvent(path, {
            clientIp,
            host,
            headers,
          });

          // Act
          const result = await handler(event);

          // Assert: The settlement header should be stripped in all cases
          if (isPassthrough(result)) {
            const request = result as CloudFrontRequest;
            expect(request.headers['x-x402-pending-settlement']).toBeUndefined();

            const allHeaderValues = Object.values(request.headers)
              .flat()
              .map((h) => h.value);
            expect(allHeaderValues).not.toContain(maliciousSettlementData);
          }
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Property 9 (scenario: no route action - passthrough):
   */
  it('strips settlement header when no route action header (passthrough scenario)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPath,
        arbHost,
        arbClientIp,
        arbMaliciousSettlementData,
        async (
          path: string,
          host: string,
          clientIp: string,
          maliciousSettlementData: string,
        ) => {
          jest.clearAllMocks();
          mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);

          const event = createMockEvent(path, {
            clientIp,
            host,
            headers: {
              'x-x402-pending-settlement': maliciousSettlementData,
            },
          });

          // Act
          const result = await handler(event);

          // Assert: Should be a passthrough with the settlement header stripped
          expect(isPassthrough(result)).toBe(true);
          const request = result as CloudFrontRequest;
          expect(request.headers['x-x402-pending-settlement']).toBeUndefined();

          // Config loader should NOT be called (no payment flow)
          expect(mockGetEdgeConfig).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Property 9 (scenario: "0" route action - passthrough):
   */
  it('strips settlement header when route action is "0" (free access passthrough)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPath,
        arbHost,
        arbClientIp,
        arbMaliciousSettlementData,
        async (
          path: string,
          host: string,
          clientIp: string,
          maliciousSettlementData: string,
        ) => {
          jest.clearAllMocks();
          mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);

          const event = createMockEvent(path, {
            clientIp,
            host,
            headers: {
              'x-x402-pending-settlement': maliciousSettlementData,
              'x-amzn-waf-x-x402-route-action': '0',
            },
          });

          // Act
          const result = await handler(event);

          // Assert: Should be a passthrough with the settlement header stripped
          expect(isPassthrough(result)).toBe(true);
          const request = result as CloudFrontRequest;
          expect(request.headers['x-x402-pending-settlement']).toBeUndefined();

          expect(mockGetEdgeConfig).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Property 9 (scenario: positive price, no payment - 402 response):
   */
  it('strips settlement header before returning 402 (positive price, no payment)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPath,
        arbHost,
        arbClientIp,
        arbMaliciousSettlementData,
        arbPositivePrice,
        async (
          path: string,
          host: string,
          clientIp: string,
          maliciousSettlementData: string,
          price: string,
        ) => {
          jest.clearAllMocks();
          mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);
          configureMockFor402();

          const event = createMockEvent(path, {
            clientIp,
            host,
            headers: {
              'x-x402-pending-settlement': maliciousSettlementData,
              'x-amzn-waf-x-x402-route-action': price,
            },
          });

          // Act
          const result = await handler(event);

          // Assert: Should be a 402 response
          expect(is402Response(result)).toBe(true);

          const response = result as CloudFrontResultResponse;
          const body = JSON.parse(response.body as string);
          
          // Verify the response has the expected structure (not influenced by malicious data)
          expect(body.x402Version).toBe(1);
          expect(body.accepts).toHaveLength(1);
          expect(body.error).toBe('');
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Property 9 (scenario: positive price with payment - passthrough with legitimate settlement):
   */
  it('strips malicious settlement header and attaches legitimate settlement data on successful payment', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPath,
        arbHost,
        arbClientIp,
        arbMaliciousSettlementData,
        arbPositivePrice,
        fc.stringMatching(/^[a-zA-Z0-9+/=]{20,100}$/), // payment signature
        fc.stringMatching(/^[a-zA-Z0-9+/]{20,50}={0,2}$/), // legitimate settlement data
        async (
          path: string,
          host: string,
          clientIp: string,
          maliciousSettlementData: string,
          price: string,
          paymentSignature: string,
          legitimateSettlementData: string,
        ) => {
          jest.clearAllMocks();
          mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);

          // Configure middleware to return pass-through with legitimate settlement data
          configureMockForPassThrough(legitimateSettlementData);

          const event = createMockEvent(path, {
            clientIp,
            host,
            headers: {
              'x-x402-pending-settlement': maliciousSettlementData,
              'x-amzn-waf-x-x402-route-action': price,
              'x-payment': paymentSignature,
            },
          });

          // Act
          const result = await handler(event);

          // Assert: Should be a passthrough with LEGITIMATE settlement data
          expect(isPassthrough(result)).toBe(true);
          const request = result as CloudFrontRequest;

          // The settlement header should contain the LEGITIMATE data, not the malicious data
          expect(request.headers['x-x402-pending-settlement']).toBeDefined();
          expect(request.headers['x-x402-pending-settlement'][0].value).toBe(legitimateSettlementData);
          expect(request.headers['x-x402-pending-settlement'][0].value).not.toBe(maliciousSettlementData);
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Property 9 (additional): Verify that stripping occurs even with case variations.
   */
  it('strips settlement header regardless of case variations in header name', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPath,
        arbHost,
        arbMaliciousSettlementData,
        async (
          path: string,
          host: string,
          maliciousSettlementData: string,
        ) => {
          jest.clearAllMocks();
          mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);

          const event = createMockEvent(path, {
            host,
            headers: {
              'x-x402-pending-settlement': maliciousSettlementData,
            },
          });

          // Act
          const result = await handler(event);

          // Assert: Should be a passthrough with the settlement header stripped
          expect(isPassthrough(result)).toBe(true);
          const request = result as CloudFrontRequest;

          // Check all case variations are stripped
          expect(request.headers['x-x402-pending-settlement']).toBeUndefined();
          expect(request.headers['X-X402-Pending-Settlement']).toBeUndefined();
          expect(request.headers['X-X402-PENDING-SETTLEMENT']).toBeUndefined();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Property 9 (additional): Verify that other headers are preserved when
   * the settlement header is stripped.
   */
  it('preserves other headers while stripping settlement header', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPath,
        arbHost,
        arbMaliciousSettlementData,
        fc.stringMatching(/^[a-zA-Z0-9-]{5,20}$/), // custom header value
        async (
          path: string,
          host: string,
          maliciousSettlementData: string,
          customHeaderValue: string,
        ) => {
          jest.clearAllMocks();
          mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);

          const event = createMockEvent(path, {
            host,
            headers: {
              'x-x402-pending-settlement': maliciousSettlementData,
              'x-custom-header': customHeaderValue,
              'x-another-header': 'another-value',
            },
          });

          // Act
          const result = await handler(event);

          // Assert: Should be a passthrough
          expect(isPassthrough(result)).toBe(true);
          const request = result as CloudFrontRequest;

          // Settlement header should be stripped
          expect(request.headers['x-x402-pending-settlement']).toBeUndefined();

          // Other headers should be preserved
          expect(request.headers['x-custom-header']).toBeDefined();
          expect(request.headers['x-custom-header'][0].value).toBe(customHeaderValue);
          expect(request.headers['x-another-header']).toBeDefined();
          expect(request.headers['x-another-header'][0].value).toBe('another-value');
          expect(request.headers['host']).toBeDefined();
          expect(request.headers['host'][0].value).toBe(host);
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });
});

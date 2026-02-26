/**
 * Property-based tests for Origin Response Lambda@Edge Handler
 *
 * Tests Properties 10, 11, and 12 from the design document:
 * - Property 10: Settlement decision based on origin status
 * - Property 11: Pending settlement header stripping on response
 * - Property 12: Settlement header removed from client response
 *
 * Updated to mock x402-middleware (createX402Middleware) instead of
 * the old facilitator-client (settle) and config-loader (getCdpCredentials).
 *
 */

import * as fc from 'fast-check';
import type {
  CloudFrontResponseEvent,
  CloudFrontResponse,
} from 'aws-lambda';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing handler
// ---------------------------------------------------------------------------

const mockProcessOriginResponse = jest.fn();
const mockProcessOriginRequest = jest.fn();

jest.mock('../../src/runtime/shared/x402-middleware', () => ({
  createX402Middleware: jest.fn(() => ({
    processOriginRequest: mockProcessOriginRequest,
    processOriginResponse: mockProcessOriginResponse,
  })),
}));

jest.mock('../../src/runtime/shared/config-loader', () => ({
  getEdgeConfig: jest.fn(),
}));

jest.mock('../../src/runtime/shared/logger', () => {
  const actual = jest.requireActual('../../src/runtime/shared/logger');
  return { ...actual, emitSettlement: jest.fn() };
});

import { handler } from '../../src/runtime/origin-response/handler';
import { getEdgeConfig } from '../../src/runtime/shared/config-loader';

const mockGetEdgeConfig = getEdgeConfig as jest.MockedFunction<typeof getEdgeConfig>;

// ---------------------------------------------------------------------------
// Default mock config
// ---------------------------------------------------------------------------

const mockEdgeConfig = {
  payTo: '0x1234567890abcdef1234567890abcdef12345678',
  network: 'eip155:84532',
  facilitatorUrl: 'https://x402.org/facilitator',
};

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a valid URL path. */
const arbPath: fc.Arbitrary<string> = fc.oneof(
  fc
    .array(fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/), { minLength: 1, maxLength: 4 })
    .map((segments) => '/' + segments.join('/')),
  fc.constant('/'),
);

/** Generate a valid HTTP status code (100-599). */
const arbStatusCode: fc.Arbitrary<number> = fc.integer({ min: 100, max: 599 });

/** Generate a success status code (< 400). */
const arbSuccessStatus: fc.Arbitrary<number> = fc.integer({ min: 100, max: 399 });

/** Generate an error status code (>= 400). */
const arbErrorStatus: fc.Arbitrary<number> = fc.integer({ min: 400, max: 599 });

/** Generate a valid settlement data string (base64-like). */
const arbSettlementData: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-zA-Z0-9+/=]{10,100}$/)
  .filter((s) => s.length >= 10);

/** Generate a valid price string. */
const arbPrice: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: 1, max: 999999 }).map((n) => {
    const str = n.toString().padStart(6, '0');
    return '0.' + str.replace(/0+$/, '') || '0';
  }),
  fc.integer({ min: 1, max: 1000 }).map(String),
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

/** Generate optional bot headers. */
const arbBotHeaders: fc.Arbitrary<Record<string, string>> = fc.oneof(
  fc.constant({}),
  fc.constant({ 'x-amzn-waf-actor-type': 'unverified-bot' }),
  fc.constant({ 'x-amzn-waf-actor-type': 'verified-bot', 'x-amzn-waf-bot-category': 'ai' }),
  fc.constant({ 'x-amzn-waf-actor-type': 'wba-verified-bot' }),
  fc.constant({ 'x-amzn-waf-bot-category': 'search_engine' }),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock CloudFront origin-response event.
 */
function createMockResponseEvent(
  options: {
    uri?: string;
    status?: number;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    clientIp?: string;
  } = {},
): CloudFrontResponseEvent {
  const {
    uri = '/api/data',
    status = 200,
    requestHeaders = {},
    responseHeaders = {},
    clientIp = '192.168.1.1',
  } = options;

  const cfRequestHeaders: Record<string, Array<{ key: string; value: string }>> = {};
  for (const [key, value] of Object.entries(requestHeaders)) {
    cfRequestHeaders[key.toLowerCase()] = [{ key, value }];
  }
  if (!cfRequestHeaders['host']) {
    cfRequestHeaders['host'] = [{ key: 'Host', value: 'example.com' }];
  }

  const cfResponseHeaders: Record<string, Array<{ key: string; value: string }>> = {};
  for (const [key, value] of Object.entries(responseHeaders)) {
    cfResponseHeaders[key.toLowerCase()] = [{ key, value }];
  }
  if (!cfResponseHeaders['content-type']) {
    cfResponseHeaders['content-type'] = [{ key: 'Content-Type', value: 'application/json' }];
  }

  return {
    Records: [
      {
        cf: {
          config: {
            distributionDomainName: 'd123.cloudfront.net',
            distributionId: 'EDFDVBD6EXAMPLE',
            eventType: 'origin-response' as const,
            requestId: 'test-request-id',
          },
          request: {
            clientIp,
            headers: cfRequestHeaders,
            method: 'GET',
            querystring: '',
            uri,
          },
          response: {
            status: status.toString(),
            statusDescription: status < 400 ? 'OK' : 'Error',
            headers: cfResponseHeaders,
          },
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Property 10: Settlement decision based on origin status
// ---------------------------------------------------------------------------

/**
 * **Feature: align-x402-libraries, Property 10: Settlement decision based on origin status**
 *
 * For any origin response, settlement should be attempted if and only if
 * the response status code is less than 400 and the request contains an
 * `x-x402-pending-settlement` header. When the status is 400 or greater,
 * settlement must not be attempted regardless of the header's presence.
 *
 */
describe('Property 10: Settlement decision based on origin status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);
    mockProcessOriginResponse.mockResolvedValue({
      type: 'settled',
      response: { status: '200', statusDescription: 'OK', headers: {} },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Settlement is attempted (middleware called) when status < 400 AND settlement header is present.
   */
  it('calls middleware processOriginResponse when status < 400 and settlement header is present', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSuccessStatus,
        arbSettlementData,
        arbPath,
        arbPrice,
        arbClientIp,
        arbBotHeaders,
        async (
          status: number,
          settlementData: string,
          path: string,
          price: string,
          clientIp: string,
          botHeaders: Record<string, string>,
        ) => {
          jest.clearAllMocks();
          mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);
          mockProcessOriginResponse.mockResolvedValue({
            type: 'settled',
            response: {
              status: status.toString(),
              statusDescription: 'OK',
              headers: { 'content-type': [{ key: 'Content-Type', value: 'application/json' }] },
            },
          });

          const requestHeaders: Record<string, string> = {
            'x-x402-pending-settlement': settlementData,
            'x-amzn-waf-x-x402-route-action': price,
            'x-forwarded-for': clientIp,
            ...botHeaders,
          };

          const event = createMockResponseEvent({
            uri: path,
            status,
            requestHeaders,
          });

          await handler(event);

          // Middleware processOriginResponse SHOULD be called
          expect(mockProcessOriginResponse).toHaveBeenCalledTimes(1);
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Settlement is NOT attempted when status >= 400, even if settlement header is present.
   * The handler skips the middleware entirely for error statuses.
   */
  it('does not call middleware when status >= 400 even with settlement header', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbErrorStatus,
        arbSettlementData,
        arbPath,
        arbPrice,
        arbClientIp,
        async (
          status: number,
          settlementData: string,
          path: string,
          price: string,
          clientIp: string,
        ) => {
          jest.clearAllMocks();
          mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);

          const requestHeaders: Record<string, string> = {
            'x-x402-pending-settlement': settlementData,
            'x-amzn-waf-x-x402-route-action': price,
            'x-forwarded-for': clientIp,
          };

          const event = createMockResponseEvent({
            uri: path,
            status,
            requestHeaders,
          });

          await handler(event);

          // Middleware processOriginResponse should NOT be called
          expect(mockProcessOriginResponse).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Settlement is NOT attempted when settlement header is absent, regardless of status.
   */
  it('does not call middleware when settlement header is absent', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStatusCode,
        arbPath,
        async (status: number, path: string) => {
          jest.clearAllMocks();
          mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);

          const event = createMockResponseEvent({
            uri: path,
            status,
            requestHeaders: {},
          });

          await handler(event);

          // Middleware should NOT be called
          expect(mockProcessOriginResponse).not.toHaveBeenCalled();
          // Config loader should NOT be called either
          expect(mockGetEdgeConfig).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11: Pending settlement header stripping on response
// ---------------------------------------------------------------------------

/**
 * **Feature: align-x402-libraries, Property 11: Pending settlement header stripping on response**
 *
 * For any CloudFront response, after the origin-response handler processes it,
 * the response SHALL not contain the `x-x402-pending-settlement` header.
 * This must hold regardless of whether settlement was attempted, succeeded,
 * failed, or the response originally had the header.
 *
 */
describe('Property 11: Pending settlement header stripping on response', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);
    mockProcessOriginResponse.mockResolvedValue({
      type: 'settled',
      response: {
        status: '200',
        statusDescription: 'OK',
        headers: { 'content-type': [{ key: 'Content-Type', value: 'application/json' }] },
      },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Settlement header is removed from response when no settlement in request.
   */
  it('removes settlement header from response when no settlement in request', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStatusCode,
        arbPath,
        fc.boolean(),
        async (status: number, path: string, responseHasHeader: boolean) => {
          jest.clearAllMocks();

          const responseHeaders: Record<string, string> = {};
          if (responseHasHeader) {
            responseHeaders['x-x402-pending-settlement'] = 'some-leaked-value';
          }

          const event = createMockResponseEvent({
            uri: path,
            status,
            requestHeaders: {},
            responseHeaders,
          });

          const result = await handler(event);

          const cfResponse = result as CloudFrontResponse;
          expect(cfResponse.headers?.['x-x402-pending-settlement']).toBeUndefined();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Settlement header is removed from response after successful settlement.
   */
  it('removes settlement header from response after successful settlement', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSuccessStatus,
        arbSettlementData,
        arbPath,
        arbPrice,
        async (status: number, settlementData: string, path: string, price: string) => {
          jest.clearAllMocks();
          mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);
          // Mock middleware returning settled result — note the response should NOT
          // have the settlement header since the handler removes it before calling middleware
          mockProcessOriginResponse.mockImplementation(async (_req, response) => ({
            type: 'settled' as const,
            response,
          }));

          const event = createMockResponseEvent({
            uri: path,
            status,
            requestHeaders: {
              'x-x402-pending-settlement': settlementData,
              'x-amzn-waf-x-x402-route-action': price,
            },
            responseHeaders: {
              'x-x402-pending-settlement': 'should-be-removed',
            },
          });

          const result = await handler(event);

          const cfResponse = result as CloudFrontResponse;
          expect(cfResponse.headers?.['x-x402-pending-settlement']).toBeUndefined();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Settlement header is removed from response after failed settlement.
   */
  it('removes settlement header from response after failed settlement', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSuccessStatus,
        arbSettlementData,
        arbPath,
        arbPrice,
        async (status: number, settlementData: string, path: string, price: string) => {
          jest.clearAllMocks();
          mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);
          mockProcessOriginResponse.mockImplementation(async (_req, response) => ({
            type: 'settlement-failed' as const,
            response,
            error: 'Settlement failed',
          }));

          const event = createMockResponseEvent({
            uri: path,
            status,
            requestHeaders: {
              'x-x402-pending-settlement': settlementData,
              'x-amzn-waf-x-x402-route-action': price,
            },
            responseHeaders: {
              'x-x402-pending-settlement': 'should-be-removed',
            },
          });

          const result = await handler(event);

          const cfResponse = result as CloudFrontResponse;
          expect(cfResponse.headers?.['x-x402-pending-settlement']).toBeUndefined();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Settlement header is removed from response when origin returns error status.
   */
  it('removes settlement header from response when origin returns error status', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbErrorStatus,
        arbSettlementData,
        arbPath,
        arbPrice,
        async (status: number, settlementData: string, path: string, price: string) => {
          jest.clearAllMocks();

          const event = createMockResponseEvent({
            uri: path,
            status,
            requestHeaders: {
              'x-x402-pending-settlement': settlementData,
              'x-amzn-waf-x-x402-route-action': price,
            },
            responseHeaders: {
              'x-x402-pending-settlement': 'should-be-removed',
            },
          });

          const result = await handler(event);

          const cfResponse = result as CloudFrontResponse;
          expect(cfResponse.headers?.['x-x402-pending-settlement']).toBeUndefined();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Settlement header is removed from response when middleware throws exception.
   */
  it('removes settlement header from response when middleware throws exception', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSuccessStatus,
        arbSettlementData,
        arbPath,
        arbPrice,
        async (status: number, settlementData: string, path: string, price: string) => {
          jest.clearAllMocks();
          mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);
          mockProcessOriginResponse.mockRejectedValue(new Error('Network error'));

          const event = createMockResponseEvent({
            uri: path,
            status,
            requestHeaders: {
              'x-x402-pending-settlement': settlementData,
              'x-amzn-waf-x-x402-route-action': price,
            },
            responseHeaders: {
              'x-x402-pending-settlement': 'should-be-removed',
            },
          });

          const result = await handler(event);

          const cfResponse = result as CloudFrontResponse;
          expect(cfResponse.headers?.['x-x402-pending-settlement']).toBeUndefined();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 12: Settlement header removed from client response
// ---------------------------------------------------------------------------

/**
 * **Feature: align-x402-libraries, Property 12: Settlement header removed from client response**
 *
 * For any response returned to the client, the `x-x402-pending-settlement`
 * header must not be present, regardless of whether settlement was attempted,
 * succeeded, or failed. This is equivalent to Property 11 but framed from
 * the client-facing perspective.
 *
 */
describe('Property 12: Settlement header removed from client response', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);
    mockProcessOriginResponse.mockResolvedValue({
      type: 'settled',
      response: {
        status: '200',
        statusDescription: 'OK',
        headers: { 'content-type': [{ key: 'Content-Type', value: 'application/json' }] },
      },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Settlement header is removed from response when no settlement in request.
   */
  it('removes settlement header from response when no settlement in request', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStatusCode,
        arbPath,
        fc.boolean(),
        async (status: number, path: string, responseHasHeader: boolean) => {
          jest.clearAllMocks();

          const responseHeaders: Record<string, string> = {};
          if (responseHasHeader) {
            responseHeaders['x-x402-pending-settlement'] = 'some-leaked-value';
          }

          const event = createMockResponseEvent({
            uri: path,
            status,
            requestHeaders: {},
            responseHeaders,
          });

          const result = await handler(event);

          const cfResponse = result as CloudFrontResponse;
          expect(cfResponse.headers?.['x-x402-pending-settlement']).toBeUndefined();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Settlement header is removed from response after successful settlement.
   */
  it('removes settlement header from response after successful settlement', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSuccessStatus,
        arbSettlementData,
        arbPath,
        arbPrice,
        async (status: number, settlementData: string, path: string, price: string) => {
          jest.clearAllMocks();
          mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);
          mockProcessOriginResponse.mockImplementation(async (_req, response) => ({
            type: 'settled' as const,
            response,
          }));

          const event = createMockResponseEvent({
            uri: path,
            status,
            requestHeaders: {
              'x-x402-pending-settlement': settlementData,
              'x-amzn-waf-x-x402-route-action': price,
            },
            responseHeaders: {
              'x-x402-pending-settlement': 'should-be-removed',
            },
          });

          const result = await handler(event);

          const cfResponse = result as CloudFrontResponse;
          expect(cfResponse.headers?.['x-x402-pending-settlement']).toBeUndefined();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Settlement header is removed from response after failed settlement.
   */
  it('removes settlement header from response after failed settlement', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSuccessStatus,
        arbSettlementData,
        arbPath,
        arbPrice,
        async (status: number, settlementData: string, path: string, price: string) => {
          jest.clearAllMocks();
          mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);
          mockProcessOriginResponse.mockImplementation(async (_req, response) => ({
            type: 'settlement-failed' as const,
            response,
            error: 'Settlement failed',
          }));

          const event = createMockResponseEvent({
            uri: path,
            status,
            requestHeaders: {
              'x-x402-pending-settlement': settlementData,
              'x-amzn-waf-x-x402-route-action': price,
            },
            responseHeaders: {
              'x-x402-pending-settlement': 'should-be-removed',
            },
          });

          const result = await handler(event);

          const cfResponse = result as CloudFrontResponse;
          expect(cfResponse.headers?.['x-x402-pending-settlement']).toBeUndefined();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Settlement header is removed from response when origin returns error status.
   */
  it('removes settlement header from response when origin returns error status', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbErrorStatus,
        arbSettlementData,
        arbPath,
        arbPrice,
        async (status: number, settlementData: string, path: string, price: string) => {
          jest.clearAllMocks();

          const event = createMockResponseEvent({
            uri: path,
            status,
            requestHeaders: {
              'x-x402-pending-settlement': settlementData,
              'x-amzn-waf-x-x402-route-action': price,
            },
            responseHeaders: {
              'x-x402-pending-settlement': 'should-be-removed',
            },
          });

          const result = await handler(event);

          const cfResponse = result as CloudFrontResponse;
          expect(cfResponse.headers?.['x-x402-pending-settlement']).toBeUndefined();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  /**
   * Settlement header is removed from response when middleware throws exception.
   */
  it('removes settlement header from response when middleware throws exception', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSuccessStatus,
        arbSettlementData,
        arbPath,
        arbPrice,
        async (status: number, settlementData: string, path: string, price: string) => {
          jest.clearAllMocks();
          mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);
          mockProcessOriginResponse.mockRejectedValue(new Error('Network error'));

          const event = createMockResponseEvent({
            uri: path,
            status,
            requestHeaders: {
              'x-x402-pending-settlement': settlementData,
              'x-amzn-waf-x-x402-route-action': price,
            },
            responseHeaders: {
              'x-x402-pending-settlement': 'should-be-removed',
            },
          });

          const result = await handler(event);

          const cfResponse = result as CloudFrontResponse;
          expect(cfResponse.headers?.['x-x402-pending-settlement']).toBeUndefined();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });
});

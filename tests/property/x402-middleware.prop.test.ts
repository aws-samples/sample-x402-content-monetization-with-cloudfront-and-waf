/**
 * Property-based tests: x402 Middleware
 *
 * **Feature: align-x402-libraries, Property 4: Pending settlement header stripping on request**
 *
 * For any CloudFront request that contains an `x-x402-pending-settlement` header,
 * after `processOriginRequest()` is called, the request SHALL no longer contain that header.
 *
 */

import * as fc from 'fast-check';
import type { CloudFrontRequest } from 'aws-lambda';
import { createX402Middleware } from '../../src/runtime/shared/x402-middleware';

// ---------------------------------------------------------------------------
// Mock createX402Server — return a server whose processHTTPRequest()
// always resolves to { type: 'no-payment-required' }
// ---------------------------------------------------------------------------

jest.mock('../../src/runtime/shared/x402-server', () => ({
  createX402Server: jest.fn().mockResolvedValue({
    processHTTPRequest: jest.fn().mockResolvedValue({ type: 'no-payment-required' }),
    processSettlement: jest.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a valid HTTP method. */
const arbMethod = fc.constantFrom('GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS');

/** Generate a valid URI path starting with /. */
const arbUriPath = fc
  .array(fc.stringMatching(/^[a-zA-Z0-9._~-]{1,20}$/), { minLength: 0, maxLength: 5 })
  .map((segments) => '/' + segments.join('/'));

/** Generate a lowercase header name that is NOT the pending settlement header. */
const arbOtherHeaderName = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,19}$/)
  .filter((s) => s.length > 0 && s !== 'x-x402-pending-settlement');

/** Generate a header value (non-empty printable ASCII). */
const arbHeaderValue = fc.stringMatching(/^[\x20-\x7E]{1,50}$/);

/** Generate a non-empty pending settlement header value (simulates arbitrary injected data). */
const arbPendingSettlementValue = fc
  .string({ minLength: 1, maxLength: 100 })
  .map((s) => Buffer.from(s).toString('base64'));

/** Generate additional CloudFront headers (unique keys, excluding the pending settlement header). */
const arbOtherHeaders = fc
  .uniqueArray(fc.tuple(arbOtherHeaderName, arbHeaderValue), {
    minLength: 0,
    maxLength: 5,
    selector: ([k]) => k,
  })
  .map((entries) => {
    const headers: Record<string, Array<{ key: string; value: string }>> = {};
    for (const [name, value] of entries) {
      headers[name] = [{ key: name, value }];
    }
    return headers;
  });

/**
 * Generate a CloudFront request that ALWAYS includes the
 * `x-x402-pending-settlement` header alongside random other headers.
 */
const arbRequestWithPendingSettlement = fc
  .tuple(arbMethod, arbUriPath, arbPendingSettlementValue, arbOtherHeaders)
  .map(([method, uri, pendingValue, otherHeaders]): CloudFrontRequest => ({
    clientIp: '127.0.0.1',
    method,
    uri,
    querystring: '',
    headers: {
      ...otherHeaders,
      'x-x402-pending-settlement': [
        { key: 'x-x402-pending-settlement', value: pendingValue },
      ],
    },
  }));

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

const TEST_MIDDLEWARE_CONFIG = {
  facilitatorUrl: 'https://x402.org/facilitator',
  network: 'eip155:8453',
  routes: { 'GET /*': { accepts: { scheme: 'exact', payTo: '0xabc', price: 0.001, network: 'eip155:8453' } } } as any,
};

describe('Property 4: Pending settlement header stripping on request', () => {
  it('processOriginRequest() removes x-x402-pending-settlement header from the request', async () => {
    const middleware = createX402Middleware(TEST_MIDDLEWARE_CONFIG);

    await fc.assert(
      fc.asyncProperty(
        arbRequestWithPendingSettlement,
        async (request) => {
          // Precondition: the header IS present before the call
          expect(request.headers['x-x402-pending-settlement']).toBeDefined();

          await middleware.processOriginRequest(
            request,
            'example.cloudfront.net',
          );

          // Post-condition: the header MUST be gone
          expect(request.headers['x-x402-pending-settlement']).toBeUndefined();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  it('processOriginRequest() preserves all other headers on the request', async () => {
    const middleware = createX402Middleware(TEST_MIDDLEWARE_CONFIG);

    await fc.assert(
      fc.asyncProperty(
        arbRequestWithPendingSettlement,
        async (request) => {
          // Capture the other header keys before the call
          const otherKeys = Object.keys(request.headers).filter(
            (k) => k !== 'x-x402-pending-settlement',
          );
          const originalValues: Record<string, string> = {};
          for (const key of otherKeys) {
            originalValues[key] = request.headers[key][0].value;
          }

          await middleware.processOriginRequest(
            request,
            'example.cloudfront.net',
          );

          // All other headers should still be present and unchanged
          for (const key of otherKeys) {
            expect(request.headers[key]).toBeDefined();
            expect(request.headers[key][0].value).toBe(originalValues[key]);
          }
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });
});


// ===========================================================================
// Property 5: Pending settlement data encode/decode round-trip
//
// **Feature: align-x402-libraries, Property 5: Pending settlement data encode/decode round-trip**
//
// For any valid PaymentPayload and PaymentRequirements objects, encoding them
// as base64 JSON for the pending settlement header and then decoding SHALL
// produce objects equivalent to the originals.
//
// ===========================================================================

// ---------------------------------------------------------------------------
// Generators for JSON-serializable objects
// ---------------------------------------------------------------------------

/** Leaf values that survive JSON round-trip. */
const arbJsonLeaf: fc.Arbitrary<string | number | boolean | null> = fc.oneof(
  fc.string({ minLength: 0, maxLength: 50 }),
  fc.integer({ min: -1e9, max: 1e9 }),
  fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }).map(
    (v) => (Object.is(v, -0) ? 0 : v), // JSON.stringify(-0) === "0", so normalize
  ),
  fc.boolean(),
  fc.constant(null),
);

/** Recursive JSON-serializable value (objects, arrays, leaves). */
const arbJsonValue: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    arbJsonLeaf,
    fc.array(tie('value'), { minLength: 0, maxLength: 5 }),
    fc.dictionary(
      fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,15}$/),
      tie('value'),
      { minKeys: 0, maxKeys: 5 },
    ),
  ),
})).value;

/** Generate a payload-like object (non-null object with string keys). */
const arbPayload = fc.dictionary(
  fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,15}$/),
  arbJsonValue,
  { minKeys: 1, maxKeys: 8 },
);

/** Generate a requirements-like object (non-null object with string keys). */
const arbRequirements = fc.dictionary(
  fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,15}$/),
  arbJsonValue,
  { minKeys: 1, maxKeys: 8 },
);

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe('Property 5: Pending settlement data encode/decode round-trip', () => {
  it('encoding payload+requirements as base64 JSON and decoding produces equivalent objects', () => {
    fc.assert(
      fc.property(
        arbPayload,
        arbRequirements,
        (payload, requirements) => {
          // Encode — same logic as middleware processOriginRequest (payment-verified branch)
          const pendingData = JSON.stringify({ payload, requirements });
          const encoded = Buffer.from(pendingData).toString('base64');

          // Decode — same logic as middleware processOriginResponse
          const decoded = JSON.parse(
            Buffer.from(encoded, 'base64').toString('utf-8'),
          );

          // Verify round-trip equivalence
          expect(decoded.payload).toEqual(payload);
          expect(decoded.requirements).toEqual(requirements);
        },
      ),
      { numRuns: 150, verbose: true },
    );
  });

  it('encoded string is valid base64 that decodes to valid JSON', () => {
    fc.assert(
      fc.property(
        arbPayload,
        arbRequirements,
        (payload, requirements) => {
          const pendingData = JSON.stringify({ payload, requirements });
          const encoded = Buffer.from(pendingData).toString('base64');

          // Verify it's valid base64 (no error on decode)
          const rawBytes = Buffer.from(encoded, 'base64').toString('utf-8');

          // Verify it's valid JSON (no error on parse)
          const parsed = JSON.parse(rawBytes);

          // Verify structure has both keys
          expect(parsed).toHaveProperty('payload');
          expect(parsed).toHaveProperty('requirements');
        },
      ),
      { numRuns: 150, verbose: true },
    );
  });
});


// ===========================================================================
// Property 6: Settlement skip on error status
//
// **Feature: align-x402-libraries, Property 6: Settlement skip on error status**
//
// For any origin response with a status code >= 400 and a request containing
// a pending settlement header, processOriginResponse() SHALL return the
// response unchanged without attempting settlement.
//
// ===========================================================================

import { createX402Server } from '../../src/runtime/shared/x402-server';

const mockedCreateX402Server = createX402Server as jest.MockedFunction<typeof createX402Server>;

// ---------------------------------------------------------------------------
// Generators for Property 6
// ---------------------------------------------------------------------------

/** Generate an HTTP error status code (400–599). */
const arbErrorStatusCode = fc.integer({ min: 400, max: 599 });

/** Generate a valid base64-encoded pending settlement header value. */
const arbValidPendingSettlement = fc
  .tuple(arbPayload, arbRequirements)
  .map(([payload, requirements]) => {
    const data = JSON.stringify({ payload, requirements });
    return Buffer.from(data).toString('base64');
  });

/** Generate a CloudFront request with a pending settlement header. */
const arbRequestWithSettlement = fc
  .tuple(arbMethod, arbUriPath, arbValidPendingSettlement, arbOtherHeaders)
  .map(([method, uri, pendingValue, otherHeaders]): CloudFrontRequest => ({
    clientIp: '127.0.0.1',
    method,
    uri,
    querystring: '',
    headers: {
      ...otherHeaders,
      'x-x402-pending-settlement': [
        { key: 'x-x402-pending-settlement', value: pendingValue },
      ],
    },
  }));

/** Generate a random CloudFront header name (lowercase, not status-related). */
const arbResponseHeaderName = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,19}$/)
  .filter((s) => s.length > 0 && s !== 'x-x402-pending-settlement');

/** Generate random CloudFront response headers. */
const arbResponseHeaders = fc
  .uniqueArray(fc.tuple(arbResponseHeaderName, arbHeaderValue), {
    minLength: 0,
    maxLength: 5,
    selector: ([k]) => k,
  })
  .map((entries) => {
    const headers: Record<string, Array<{ key: string; value: string }>> = {};
    for (const [name, value] of entries) {
      headers[name] = [{ key: name, value }];
    }
    return headers;
  });

/** Generate a CloudFront origin response with an error status (>= 400). */
const arbErrorResponse = fc
  .tuple(arbErrorStatusCode, arbResponseHeaders)
  .map(([status, headers]) => ({
    status: String(status),
    statusDescription: 'Error',
    headers,
  }));

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe('Property 6: Settlement skip on error status', () => {
  beforeEach(() => {
    // Clear the processSettlement mock call count before each test
    const mockServer = mockedCreateX402Server.mock.results[0]?.value;
    if (mockServer && typeof mockServer.then === 'function') {
      // It's a promise — we'll clear inside the test
    }
  });

  it('processOriginResponse() returns response unchanged for status >= 400 without calling processSettlement()', async () => {
    const middleware = createX402Middleware(TEST_MIDDLEWARE_CONFIG);

    // Get the mock server's processSettlement to verify it's not called
    const mockServerInstance = await mockedCreateX402Server(TEST_MIDDLEWARE_CONFIG);
    const processSettlementMock = mockServerInstance.processSettlement as jest.Mock;

    await fc.assert(
      fc.asyncProperty(
        arbRequestWithSettlement,
        arbErrorResponse,
        async (request, response) => {
          // Clear the mock before each iteration
          processSettlementMock.mockClear();

          // Deep-clone the response to compare later
          const originalResponse = JSON.parse(JSON.stringify(response));

          const result = await middleware.processOriginResponse(
            request,
            response,
          );

          // The result type should be pass-through
          expect(result.type).toBe('pass-through');

          // The response should be returned unchanged
          expect(result.response.status).toBe(originalResponse.status);
          expect(result.response.statusDescription).toBe(originalResponse.statusDescription);
          expect(JSON.stringify(result.response.headers)).toBe(
            JSON.stringify(originalResponse.headers),
          );

          // processSettlement should NOT have been called
          expect(processSettlementMock).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 120, verbose: true },
    );
  });

  it('processOriginResponse() skips settlement for all error status codes (400-599)', async () => {
    const middleware = createX402Middleware(TEST_MIDDLEWARE_CONFIG);

    const mockServerInstance = await mockedCreateX402Server(TEST_MIDDLEWARE_CONFIG);
    const processSettlementMock = mockServerInstance.processSettlement as jest.Mock;

    await fc.assert(
      fc.asyncProperty(
        arbRequestWithSettlement,
        arbErrorStatusCode,
        async (request, statusCode) => {
          processSettlementMock.mockClear();

          const response = {
            status: String(statusCode),
            statusDescription: 'Error',
            headers: {},
          };

          const result = await middleware.processOriginResponse(
            request,
            response,
          );

          expect(result.type).toBe('pass-through');
          expect(result.response.status).toBe(String(statusCode));
          expect(processSettlementMock).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 120, verbose: true },
    );
  });
});


// ===========================================================================
// Property 7: Pass-through without pending settlement header
//
// **Feature: align-x402-libraries, Property 7: Pass-through without pending settlement header**
//
// For any origin response where the corresponding request does not contain
// a pending settlement header, processOriginResponse() SHALL return the
// response unchanged.
//
// ===========================================================================

// ---------------------------------------------------------------------------
// Generators for Property 7
// ---------------------------------------------------------------------------

/** Generate any HTTP status code (200–599). */
const arbAnyStatusCode = fc.integer({ min: 200, max: 599 });

/**
 * Generate a CloudFront request that does NOT contain the
 * `x-x402-pending-settlement` header.
 */
const arbRequestWithoutPendingSettlement = fc
  .tuple(arbMethod, arbUriPath, arbOtherHeaders)
  .map(([method, uri, otherHeaders]): CloudFrontRequest => ({
    clientIp: '127.0.0.1',
    method,
    uri,
    querystring: '',
    headers: { ...otherHeaders },
  }));

/** Generate a CloudFront origin response with any status code (200–599). */
const arbAnyResponse = fc
  .tuple(arbAnyStatusCode, arbResponseHeaders)
  .map(([status, headers]) => ({
    status: String(status),
    statusDescription: status < 400 ? 'OK' : 'Error',
    headers,
  }));

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe('Property 7: Pass-through without pending settlement header', () => {
  it('processOriginResponse() returns response unchanged when request has no pending settlement header', async () => {
    const middleware = createX402Middleware(TEST_MIDDLEWARE_CONFIG);

    const mockServerInstance = await mockedCreateX402Server(TEST_MIDDLEWARE_CONFIG);
    const processSettlementMock = mockServerInstance.processSettlement as jest.Mock;

    await fc.assert(
      fc.asyncProperty(
        arbRequestWithoutPendingSettlement,
        arbAnyResponse,
        async (request, response) => {
          processSettlementMock.mockClear();

          // Deep-clone the response to compare later
          const originalResponse = JSON.parse(JSON.stringify(response));

          // Precondition: no pending settlement header on request
          expect(request.headers['x-x402-pending-settlement']).toBeUndefined();

          const result = await middleware.processOriginResponse(
            request,
            response,
          );

          // The result type should be pass-through
          expect(result.type).toBe('pass-through');

          // The response should be returned unchanged
          expect(result.response.status).toBe(originalResponse.status);
          expect(result.response.statusDescription).toBe(originalResponse.statusDescription);
          expect(JSON.stringify(result.response.headers)).toBe(
            JSON.stringify(originalResponse.headers),
          );

          // processSettlement should NOT have been called
          expect(processSettlementMock).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 120, verbose: true },
    );
  });

  it('processOriginResponse() does not modify the original response object when no pending settlement header', async () => {
    const middleware = createX402Middleware(TEST_MIDDLEWARE_CONFIG);

    await fc.assert(
      fc.asyncProperty(
        arbRequestWithoutPendingSettlement,
        arbAnyResponse,
        async (request, response) => {
          const originalStatus = response.status;
          const originalHeaders = JSON.parse(JSON.stringify(response.headers));

          const result = await middleware.processOriginResponse(
            request,
            response,
          );

          // The returned response should be the same object reference
          expect(result.response).toBe(response);

          // The response should not have been mutated
          expect(response.status).toBe(originalStatus);
          expect(JSON.stringify(response.headers)).toBe(JSON.stringify(originalHeaders));
        },
      ),
      { numRuns: 120, verbose: true },
    );
  });
});

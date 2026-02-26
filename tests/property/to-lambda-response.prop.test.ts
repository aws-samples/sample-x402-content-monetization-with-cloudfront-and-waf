/**
 * Property-based test: toLambdaResponse transformation
 *
 * **Feature: align-x402-libraries, Property 8: toLambdaResponse transformation**
 *
 * For any HTTPResponseInstructions with a numeric status code, a record of string headers,
 * and an optional body, toLambdaResponse() SHALL produce a CloudFront result response where
 * the status is the string representation of the input status, each input header appears in
 * CloudFront multi-value format, and the body is the JSON-serialized input body.
 *
 */

import * as fc from 'fast-check';
import { toLambdaResponse } from '../../src/runtime/shared/to-lambda-response';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a valid HTTP status code (100-599). */
const arbStatusCode = fc.integer({ min: 100, max: 599 });

/** Generate a lowercase header name (alphanumeric with dashes, avoiding reserved keys). */
const arbHeaderName = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,19}$/)
  .filter((s) => s.length > 0 && s !== 'payment-required' && s !== 'cache-control');

/** Generate a header value (printable ASCII, non-empty). */
const arbHeaderValue = fc.stringMatching(/^[\x20-\x7E]{1,50}$/);

/** Generate a record of headers with unique keys. */
const arbHeaders = fc
  .uniqueArray(fc.tuple(arbHeaderName, arbHeaderValue), {
    minLength: 0,
    maxLength: 8,
    selector: ([k]) => k,
  })
  .map((pairs) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of pairs) {
      headers[key] = value;
    }
    return headers;
  });

/** Generate a simple body value (string, number, or small object). */
const arbBody = fc.oneof(
  fc.string({ minLength: 1, maxLength: 30 }),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.record({
    message: fc.string({ minLength: 1, maxLength: 20 }),
    code: fc.integer({ min: 0, max: 9999 }),
  }),
);

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe('Property 8: toLambdaResponse transformation', () => {
  it('output status is the string representation of the input status', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStatusCode,
        arbHeaders,
        arbBody,
        async (status, headers, body) => {
          const result = toLambdaResponse({ status, headers, body });
          expect(result.status).toBe(String(status));
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  it('each input header appears in CloudFront multi-value format', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStatusCode,
        arbHeaders,
        arbBody,
        async (status, headers, body) => {
          const result = toLambdaResponse({ status, headers, body });

          for (const [key, value] of Object.entries(headers)) {
            const lowerKey = key.toLowerCase();
            const cfHeader = result.headers?.[lowerKey];
            expect(cfHeader).toBeDefined();
            expect(Array.isArray(cfHeader)).toBe(true);
            expect(cfHeader!.length).toBeGreaterThanOrEqual(1);
            // At least one entry should have the original value
            const hasValue = cfHeader!.some((entry) => entry.value === value);
            expect(hasValue).toBe(true);
          }
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  it('body is JSON-serialized from the input body', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStatusCode,
        arbHeaders,
        arbBody,
        async (status, headers, body) => {
          const result = toLambdaResponse({ status, headers, body });

          if (typeof body === 'string') {
            // String bodies are passed through as-is
            expect(result.body).toBe(body);
          } else {
            // Non-string bodies are JSON-serialized
            expect(result.body).toBe(JSON.stringify(body));
          }
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  it('cache-control header is added when not present in input', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStatusCode,
        arbHeaders,
        arbBody,
        async (status, headers, body) => {
          // arbHeaders already filters out cache-control
          const result = toLambdaResponse({ status, headers, body });

          const cacheControl = result.headers?.['cache-control'];
          expect(cacheControl).toBeDefined();
          expect(cacheControl![0].value).toBe('no-store');
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  it('empty body produces empty string in output', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStatusCode,
        arbHeaders,
        async (status, headers) => {
          const result = toLambdaResponse({ status, headers, body: undefined });
          expect(result.body).toBe('');
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });
});

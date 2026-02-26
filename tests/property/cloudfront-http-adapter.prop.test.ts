/**
 * Property-based test: CloudFrontHTTPAdapter accessor round-trip
 *
 * **Feature: align-x402-libraries, Property 1: CloudFrontHTTPAdapter accessor round-trip**
 *
 * For any CloudFront request object with arbitrary headers, HTTP method, and URI path,
 * constructing a CloudFrontHTTPAdapter and calling getHeader(name) (with any casing),
 * getMethod(), and getPath() SHALL return the original header value (case-insensitive),
 * method, and URI path respectively.
 *
 */

import * as fc from 'fast-check';
import { CloudFrontHTTPAdapter } from '../../src/runtime/shared/cloudfront-http-adapter';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a valid HTTP method. */
const arbMethod = fc.constantFrom('GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS');

/** Generate a valid URI path starting with /. */
const arbUriPath = fc
  .array(fc.stringMatching(/^[a-zA-Z0-9._~-]{1,20}$/), { minLength: 0, maxLength: 5 })
  .map((segments) => '/' + segments.join('/'));

/** Generate a lowercase header name (CloudFront stores headers with lowercase keys). */
const arbHeaderName = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/).filter((s) => s.length > 0);

/** Generate a header value (non-empty printable ASCII). */
const arbHeaderValue = fc.stringMatching(/^[\x20-\x7E]{1,50}$/);

/** Generate a single CloudFront header entry: { lowercase-key -> [{key, value}] }. */
const arbHeaderEntry = fc.tuple(arbHeaderName, arbHeaderValue).map(([name, value]) => ({
  name,
  value,
}));

/** Generate a set of CloudFront headers (unique keys). */
const arbHeaders = fc
  .uniqueArray(arbHeaderEntry, { minLength: 1, maxLength: 10, selector: (e) => e.name })
  .map((entries) => {
    const headers: Record<string, Array<{ key: string; value: string }>> = {};
    for (const { name, value } of entries) {
      headers[name] = [{ key: name, value }];
    }
    return headers;
  });

/** Generate a CloudFront request object with the given headers, method, and URI. */
const arbCloudFrontRequest = fc
  .tuple(arbHeaders, arbMethod, arbUriPath)
  .map(([headers, method, uri]) => ({
    clientIp: '127.0.0.1',
    method,
    uri,
    querystring: '',
    headers,
  }));


// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe('Property 1: CloudFrontHTTPAdapter accessor round-trip', () => {
  it('getHeader(name) returns the correct value with case-insensitive lookup', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbCloudFrontRequest,
        fc.constant('example.com'),
        async (request, domain) => {
          const adapter = new CloudFrontHTTPAdapter(request as any, domain);

          // For each header in the request, verify getHeader returns the correct value
          for (const [lowerKey, entries] of Object.entries(request.headers)) {
            const expectedValue = entries[0].value;

            // Exact lowercase lookup
            expect(adapter.getHeader(lowerKey)).toBe(expectedValue);

            // Uppercase lookup
            expect(adapter.getHeader(lowerKey.toUpperCase())).toBe(expectedValue);

            // Mixed case lookup
            const mixed = lowerKey
              .split('')
              .map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase()))
              .join('');
            expect(adapter.getHeader(mixed)).toBe(expectedValue);
          }
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  it('getHeader() returns undefined for a header not present in the request', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbCloudFrontRequest,
        fc.constant('example.com'),
        async (request, domain) => {
          const adapter = new CloudFrontHTTPAdapter(request as any, domain);

          // Use a header name guaranteed not to be in the generated set
          expect(adapter.getHeader('x-definitely-not-present-zzz')).toBeUndefined();
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  it('getMethod() returns the original HTTP method', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbCloudFrontRequest,
        fc.constant('example.com'),
        async (request, domain) => {
          const adapter = new CloudFrontHTTPAdapter(request as any, domain);
          expect(adapter.getMethod()).toBe(request.method);
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  it('getPath() returns the original URI path', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbCloudFrontRequest,
        fc.constant('example.com'),
        async (request, domain) => {
          const adapter = new CloudFrontHTTPAdapter(request as any, domain);
          expect(adapter.getPath()).toBe(request.uri);
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: CloudFrontHTTPAdapter URL construction
// ---------------------------------------------------------------------------

/**
 * **Feature: align-x402-libraries, Property 2: CloudFrontHTTPAdapter URL construction**
 *
 * For any distribution domain string, URI path, and querystring, calling getUrl()
 * on a CloudFrontHTTPAdapter SHALL return a URL of the form `https://{domain}{path}`
 * when querystring is empty, or `https://{domain}{path}?{querystring}` when querystring
 * is present.
 *
 */

// Generators for Property 2

/** Generate a valid distribution domain (e.g. d1234abcdef.cloudfront.net). */
const arbDistributionDomain = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9]{3,20}$/),
    fc.constantFrom('.cloudfront.net', '.example.com', '.cdn.test.io'),
  )
  .map(([sub, tld]) => `${sub}${tld}`);

/** Generate a non-empty querystring (key=value pairs joined by &). */
const arbQuerystringPair = fc
  .tuple(
    fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,9}$/),
    fc.stringMatching(/^[a-zA-Z0-9._~-]{1,20}$/),
  )
  .map(([key, value]) => `${key}=${value}`);

const arbNonEmptyQuerystring = fc
  .array(arbQuerystringPair, { minLength: 1, maxLength: 5 })
  .map((pairs) => pairs.join('&'));

/** Build a CloudFront request with a specific querystring. */
function buildRequest(uri: string, querystring: string) {
  return {
    clientIp: '127.0.0.1',
    method: 'GET' as const,
    uri,
    querystring,
    headers: {},
  };
}

describe('Property 2: CloudFrontHTTPAdapter URL construction', () => {
  it('getUrl() returns https://{domain}{path} when querystring is empty', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbDistributionDomain,
        arbUriPath,
        async (domain, path) => {
          const request = buildRequest(path, '');
          const adapter = new CloudFrontHTTPAdapter(request as any, domain);

          expect(adapter.getUrl()).toBe(`https://${domain}${path}`);
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  it('getUrl() returns https://{domain}{path}?{querystring} when querystring is present', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbDistributionDomain,
        arbUriPath,
        arbNonEmptyQuerystring,
        async (domain, path, qs) => {
          const request = buildRequest(path, qs);
          const adapter = new CloudFrontHTTPAdapter(request as any, domain);

          expect(adapter.getUrl()).toBe(`https://${domain}${path}?${qs}`);
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 3: CloudFrontHTTPAdapter querystring parsing
// ---------------------------------------------------------------------------

/**
 * **Feature: align-x402-libraries, Property 3: CloudFrontHTTPAdapter querystring parsing**
 *
 * For any querystring with valid key-value pairs, calling getQueryParams()
 * on a CloudFrontHTTPAdapter SHALL return a record where each key maps to its value(s),
 * and re-serializing the record back to a querystring SHALL produce an equivalent set
 * of key-value pairs.
 *
 */

// Generators for Property 3

/** Generate a valid querystring key (alphanumeric, starting with a letter). */
const arbQsKey = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,9}$/);

/** Generate a valid querystring value (URL-safe characters). */
const arbQsValue = fc.stringMatching(/^[a-zA-Z0-9._~-]{1,20}$/);

/** Generate a list of unique key-value pairs (each key appears exactly once). */
const arbSingleValuePairs = fc
  .uniqueArray(fc.tuple(arbQsKey, arbQsValue), {
    minLength: 1,
    maxLength: 8,
    selector: ([k]) => k,
  });

/** Generate key-value pairs where some keys may repeat (for multi-value testing). */
const arbMultiValuePairs = fc
  .tuple(
    // A key that will appear multiple times
    arbQsKey,
    fc.array(arbQsValue, { minLength: 2, maxLength: 4 }),
    // Additional unique keys
    fc.uniqueArray(fc.tuple(arbQsKey, arbQsValue), {
      minLength: 0,
      maxLength: 5,
      selector: ([k]) => k,
    }),
  )
  .map(([multiKey, multiValues, otherPairs]) => {
    // Filter out any other pair that collides with the multi-value key
    const filtered = otherPairs.filter(([k]) => k !== multiKey);
    const pairs: Array<[string, string]> = multiValues.map((v) => [multiKey, v] as [string, string]);
    pairs.push(...filtered);
    return { multiKey, multiValues, pairs };
  });

/** Build a querystring from key-value pairs. */
function pairsToQuerystring(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

describe('Property 3: CloudFrontHTTPAdapter querystring parsing', () => {
  it('getQueryParams() returns correct record for single-value keys', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSingleValuePairs,
        async (pairs) => {
          const qs = pairsToQuerystring(pairs);
          const request = buildRequest('/test', qs);
          const adapter = new CloudFrontHTTPAdapter(request as any, 'example.com');

          const result = adapter.getQueryParams();

          // Each key should map to its single value (as a string, not array)
          for (const [key, value] of pairs) {
            expect(result[key]).toBe(value);
          }

          // Number of keys should match
          expect(Object.keys(result).length).toBe(pairs.length);
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  it('getQueryParams() returns arrays for multi-value keys', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbMultiValuePairs,
        async ({ multiKey, multiValues, pairs }) => {
          const qs = pairsToQuerystring(pairs);
          const request = buildRequest('/test', qs);
          const adapter = new CloudFrontHTTPAdapter(request as any, 'example.com');

          const result = adapter.getQueryParams();

          // The multi-value key should be an array with all values in order
          expect(result[multiKey]).toEqual(multiValues);

          // Other keys should be single strings
          const otherPairs = pairs.filter(([k]) => k !== multiKey);
          for (const [key, value] of otherPairs) {
            expect(result[key]).toBe(value);
          }
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  it('re-serializing getQueryParams() produces equivalent key-value pairs', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSingleValuePairs,
        async (pairs) => {
          const qs = pairsToQuerystring(pairs);
          const request = buildRequest('/test', qs);
          const adapter = new CloudFrontHTTPAdapter(request as any, 'example.com');

          const result = adapter.getQueryParams();

          // Re-serialize the record back to key-value pairs
          const reserialized: Array<[string, string]> = [];
          for (const [key, value] of Object.entries(result)) {
            if (Array.isArray(value)) {
              for (const v of value) {
                reserialized.push([key, v]);
              }
            } else {
              reserialized.push([key, value]);
            }
          }

          // Sort both sets for comparison (order may differ)
          const sortPairs = (p: Array<[string, string]>) =>
            [...p].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

          expect(sortPairs(reserialized)).toEqual(sortPairs(pairs));
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });

  it('getQueryParams() returns empty record for empty querystring', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbDistributionDomain,
        arbUriPath,
        async (domain, path) => {
          const request = buildRequest(path, '');
          const adapter = new CloudFrontHTTPAdapter(request as any, domain);

          const result = adapter.getQueryParams();
          expect(result).toEqual({});
        },
      ),
      { numRuns: 100, verbose: true },
    );
  });
});

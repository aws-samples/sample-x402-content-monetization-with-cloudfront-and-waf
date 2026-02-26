/**
 * Unit tests for the CloudFrontHTTPAdapter class.
 *
 * Tests that the adapter correctly implements the HTTPAdapter interface
 * by translating CloudFront Lambda@Edge request objects into the
 * interface expected by x402HTTPResourceServer.
 *
 */

import type { CloudFrontRequest } from 'aws-lambda';
import { CloudFrontHTTPAdapter } from '../../src/runtime/shared/cloudfront-http-adapter';

// ---------------------------------------------------------------------------
// Helper: build a minimal CloudFront request
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<CloudFrontRequest> = {}): CloudFrontRequest {
  return {
    clientIp: '203.0.113.178',
    method: 'GET',
    uri: '/api/data',
    querystring: '',
    headers: {},
    ...overrides,
  };
}

const DOMAIN = 'd111111abcdef8.cloudfront.net';

// ---------------------------------------------------------------------------
// getHeader
// ---------------------------------------------------------------------------

describe('CloudFrontHTTPAdapter', () => {
  describe('getHeader', () => {
    it('should return header value with lowercase name', () => {
      const request = makeRequest({
        headers: {
          'content-type': [{ key: 'Content-Type', value: 'application/json' }],
        },
      });
      const adapter = new CloudFrontHTTPAdapter(request, DOMAIN);

      expect(adapter.getHeader('content-type')).toBe('application/json');
    });

    it('should return header value with uppercase name (case-insensitive lookup)', () => {
      const request = makeRequest({
        headers: {
          'content-type': [{ key: 'Content-Type', value: 'application/json' }],
        },
      });
      const adapter = new CloudFrontHTTPAdapter(request, DOMAIN);

      expect(adapter.getHeader('Content-Type')).toBe('application/json');
    });

    it('should return header value with mixed-case name', () => {
      const request = makeRequest({
        headers: {
          'x-custom-header': [{ key: 'X-Custom-Header', value: 'custom-value' }],
        },
      });
      const adapter = new CloudFrontHTTPAdapter(request, DOMAIN);

      expect(adapter.getHeader('X-Custom-Header')).toBe('custom-value');
    });

    it('should return undefined for missing headers', () => {
      const request = makeRequest({ headers: {} });
      const adapter = new CloudFrontHTTPAdapter(request, DOMAIN);

      expect(adapter.getHeader('x-nonexistent')).toBeUndefined();
    });

    it('should return the first value when multiple values exist', () => {
      const request = makeRequest({
        headers: {
          'accept': [
            { key: 'Accept', value: 'text/html' },
            { key: 'Accept', value: 'application/json' },
          ],
        },
      });
      const adapter = new CloudFrontHTTPAdapter(request, DOMAIN);

      expect(adapter.getHeader('accept')).toBe('text/html');
    });
  });

  // ---------------------------------------------------------------------------
  // getMethod
  // ---------------------------------------------------------------------------

  describe('getMethod', () => {
    it('should return the HTTP method from the request', () => {
      const adapter = new CloudFrontHTTPAdapter(makeRequest({ method: 'GET' }), DOMAIN);
      expect(adapter.getMethod()).toBe('GET');
    });

    it('should return POST method', () => {
      const adapter = new CloudFrontHTTPAdapter(makeRequest({ method: 'POST' }), DOMAIN);
      expect(adapter.getMethod()).toBe('POST');
    });

    it('should return DELETE method', () => {
      const adapter = new CloudFrontHTTPAdapter(makeRequest({ method: 'DELETE' }), DOMAIN);
      expect(adapter.getMethod()).toBe('DELETE');
    });
  });

  // ---------------------------------------------------------------------------
  // getPath
  // ---------------------------------------------------------------------------

  describe('getPath', () => {
    it('should return the URI path from the request', () => {
      const adapter = new CloudFrontHTTPAdapter(makeRequest({ uri: '/api/data' }), DOMAIN);
      expect(adapter.getPath()).toBe('/api/data');
    });

    it('should return root path', () => {
      const adapter = new CloudFrontHTTPAdapter(makeRequest({ uri: '/' }), DOMAIN);
      expect(adapter.getPath()).toBe('/');
    });

    it('should return nested path', () => {
      const adapter = new CloudFrontHTTPAdapter(makeRequest({ uri: '/a/b/c/d' }), DOMAIN);
      expect(adapter.getPath()).toBe('/a/b/c/d');
    });
  });

  // ---------------------------------------------------------------------------
  // getUrl
  // ---------------------------------------------------------------------------

  describe('getUrl', () => {
    it('should return full URL without querystring', () => {
      const request = makeRequest({ uri: '/api/data', querystring: '' });
      const adapter = new CloudFrontHTTPAdapter(request, DOMAIN);

      expect(adapter.getUrl()).toBe(`https://${DOMAIN}/api/data`);
    });

    it('should return full URL with querystring', () => {
      const request = makeRequest({ uri: '/api/data', querystring: 'foo=bar&baz=qux' });
      const adapter = new CloudFrontHTTPAdapter(request, DOMAIN);

      expect(adapter.getUrl()).toBe(`https://${DOMAIN}/api/data?foo=bar&baz=qux`);
    });

    it('should handle root path with querystring', () => {
      const request = makeRequest({ uri: '/', querystring: 'key=value' });
      const adapter = new CloudFrontHTTPAdapter(request, DOMAIN);

      expect(adapter.getUrl()).toBe(`https://${DOMAIN}/?key=value`);
    });
  });

  // ---------------------------------------------------------------------------
  // getAcceptHeader
  // ---------------------------------------------------------------------------

  describe('getAcceptHeader', () => {
    it('should always return application/json', () => {
      const adapter = new CloudFrontHTTPAdapter(makeRequest(), DOMAIN);
      expect(adapter.getAcceptHeader()).toBe('application/json');
    });

    it('should return application/json even when accept header is set to something else', () => {
      const request = makeRequest({
        headers: {
          'accept': [{ key: 'Accept', value: 'text/html' }],
        },
      });
      const adapter = new CloudFrontHTTPAdapter(request, DOMAIN);

      expect(adapter.getAcceptHeader()).toBe('application/json');
    });
  });

  // ---------------------------------------------------------------------------
  // getUserAgent
  // ---------------------------------------------------------------------------

  describe('getUserAgent', () => {
    it('should return user-agent header value when present', () => {
      const request = makeRequest({
        headers: {
          'user-agent': [{ key: 'User-Agent', value: 'Mozilla/5.0' }],
        },
      });
      const adapter = new CloudFrontHTTPAdapter(request, DOMAIN);

      expect(adapter.getUserAgent()).toBe('Mozilla/5.0');
    });

    it('should return empty string when user-agent header is absent', () => {
      const request = makeRequest({ headers: {} });
      const adapter = new CloudFrontHTTPAdapter(request, DOMAIN);

      expect(adapter.getUserAgent()).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // getQueryParams
  // ---------------------------------------------------------------------------

  describe('getQueryParams', () => {
    it('should return empty object when querystring is empty', () => {
      const request = makeRequest({ querystring: '' });
      const adapter = new CloudFrontHTTPAdapter(request, DOMAIN);

      expect(adapter.getQueryParams()).toEqual({});
    });

    it('should parse single query parameter', () => {
      const request = makeRequest({ querystring: 'foo=bar' });
      const adapter = new CloudFrontHTTPAdapter(request, DOMAIN);

      expect(adapter.getQueryParams()).toEqual({ foo: 'bar' });
    });

    it('should parse multiple query parameters', () => {
      const request = makeRequest({ querystring: 'foo=bar&baz=qux' });
      const adapter = new CloudFrontHTTPAdapter(request, DOMAIN);

      expect(adapter.getQueryParams()).toEqual({ foo: 'bar', baz: 'qux' });
    });

    it('should return array for multi-value params', () => {
      const request = makeRequest({ querystring: 'tag=a&tag=b&tag=c' });
      const adapter = new CloudFrontHTTPAdapter(request, DOMAIN);

      expect(adapter.getQueryParams()).toEqual({ tag: ['a', 'b', 'c'] });
    });

    it('should handle mix of single and multi-value params', () => {
      const request = makeRequest({ querystring: 'page=1&tag=a&tag=b' });
      const adapter = new CloudFrontHTTPAdapter(request, DOMAIN);

      expect(adapter.getQueryParams()).toEqual({ page: '1', tag: ['a', 'b'] });
    });
  });
});

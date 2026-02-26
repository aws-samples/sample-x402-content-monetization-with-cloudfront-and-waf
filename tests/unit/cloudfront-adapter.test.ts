/**
 * Unit tests for the CloudFront HTTP adapter.
 *
 * Tests header extraction, route-action header parsing,
 * and header manipulation functions.
 *
 */

import type {
  CloudFrontRequestEvent,
  CloudFrontRequest,
  CloudFrontResultResponse,
} from 'aws-lambda';
import {
  extractRequest,
  attachHeader,
  removeHeader,
  removeResponseHeader,
} from '../../src/runtime/shared/cloudfront-adapter';

// ---------------------------------------------------------------------------
// Helper: build a minimal CloudFront origin-request event
// ---------------------------------------------------------------------------

function makeCloudFrontEvent(
  uri: string,
  headers: Record<string, Array<{ key: string; value: string }>>,
): CloudFrontRequestEvent {
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
            method: 'GET',
            uri,
            querystring: '',
            headers,
          },
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// extractRequest
// ---------------------------------------------------------------------------

describe('extractRequest', () => {
  it('should extract path from the CloudFront event URI', () => {
    const event = makeCloudFrontEvent('/api/data', {
      host: [{ key: 'Host', value: 'example.com' }],
    });

    const parsed = extractRequest(event);

    expect(parsed.path).toBe('/api/data');
  });

  it('should extract host header', () => {
    const event = makeCloudFrontEvent('/', {
      host: [{ key: 'Host', value: 'publisher.example.com' }],
    });

    const parsed = extractRequest(event);

    expect(parsed.host).toBe('publisher.example.com');
  });

  it('should default host to empty string when missing', () => {
    const event = makeCloudFrontEvent('/', {});

    const parsed = extractRequest(event);

    expect(parsed.host).toBe('');
  });

  it('should flatten all headers into a lowercase-keyed record', () => {
    const event = makeCloudFrontEvent('/', {
      host: [{ key: 'Host', value: 'example.com' }],
      'content-type': [{ key: 'Content-Type', value: 'application/json' }],
      'accept-encoding': [{ key: 'Accept-Encoding', value: 'gzip' }],
    });

    const parsed = extractRequest(event);

    expect(parsed.headers['host']).toBe('example.com');
    expect(parsed.headers['content-type']).toBe('application/json');
    expect(parsed.headers['accept-encoding']).toBe('gzip');
  });

  describe('payment header extraction', () => {
    it('should extract X-PAYMENT header', () => {
      const event = makeCloudFrontEvent('/api/data', {
        host: [{ key: 'Host', value: 'example.com' }],
        'x-payment': [{ key: 'X-PAYMENT', value: 'payment-sig-123' }],
      });

      const parsed = extractRequest(event);

      expect(parsed.paymentHeader).toBe('payment-sig-123');
    });

    it('should extract X-PAYMENT-SIGNATURE header', () => {
      const event = makeCloudFrontEvent('/api/data', {
        host: [{ key: 'Host', value: 'example.com' }],
        'x-payment-signature': [
          { key: 'X-PAYMENT-SIGNATURE', value: 'sig-456' },
        ],
      });

      const parsed = extractRequest(event);

      expect(parsed.paymentHeader).toBe('sig-456');
    });

    it('should prefer X-PAYMENT over X-PAYMENT-SIGNATURE when both present', () => {
      const event = makeCloudFrontEvent('/api/data', {
        host: [{ key: 'Host', value: 'example.com' }],
        'x-payment': [{ key: 'X-PAYMENT', value: 'primary-sig' }],
        'x-payment-signature': [
          { key: 'X-PAYMENT-SIGNATURE', value: 'secondary-sig' },
        ],
      });

      const parsed = extractRequest(event);

      expect(parsed.paymentHeader).toBe('primary-sig');
    });

    it('should return undefined when no payment header is present', () => {
      const event = makeCloudFrontEvent('/api/data', {
        host: [{ key: 'Host', value: 'example.com' }],
      });

      const parsed = extractRequest(event);

      expect(parsed.paymentHeader).toBeUndefined();
    });
  });

  describe('route action header extraction', () => {
    it('should extract WAF-injected x-amzn-waf-x-x402-route-action header', () => {
      const event = makeCloudFrontEvent('/api/data', {
        host: [{ key: 'Host', value: 'example.com' }],
        'x-amzn-waf-x-x402-route-action': [
          { key: 'x-amzn-waf-x-x402-route-action', value: '0.001' },
        ],
      });

      const parsed = extractRequest(event);

      expect(parsed.routeActionHeader).toBe('0.001');
    });

    it('should extract "0" route action header (free access)', () => {
      const event = makeCloudFrontEvent('/api/data', {
        host: [{ key: 'Host', value: 'example.com' }],
        'x-amzn-waf-x-x402-route-action': [
          { key: 'x-amzn-waf-x-x402-route-action', value: '0' },
        ],
      });

      const parsed = extractRequest(event);

      expect(parsed.routeActionHeader).toBe('0');
    });

    it('should return undefined when route action header is absent', () => {
      const event = makeCloudFrontEvent('/api/data', {
        host: [{ key: 'Host', value: 'example.com' }],
      });

      const parsed = extractRequest(event);

      expect(parsed.routeActionHeader).toBeUndefined();
    });

    it('should ignore the unprefixed x-x402-route-action header', () => {
      const event = makeCloudFrontEvent('/api/data', {
        host: [{ key: 'Host', value: 'example.com' }],
        'x-x402-route-action': [
          { key: 'x-x402-route-action', value: '0.001' },
        ],
      });

      const parsed = extractRequest(event);

      expect(parsed.routeActionHeader).toBeUndefined();
    });
  });

  describe('bot headers extraction', () => {
    it('should extract all x-amzn-waf-* headers into botHeaders', () => {
      const event = makeCloudFrontEvent('/api/data', {
        host: [{ key: 'Host', value: 'example.com' }],
        'x-amzn-waf-actor-type': [
          { key: 'x-amzn-waf-actor-type', value: 'verified-bot' },
        ],
        'x-amzn-waf-bot-category': [
          { key: 'x-amzn-waf-bot-category', value: 'ai' },
        ],
      });

      const parsed = extractRequest(event);

      expect(parsed.botHeaders).toEqual({
        'x-amzn-waf-actor-type': 'verified-bot',
        'x-amzn-waf-bot-category': 'ai',
      });
    });

    it('should return empty botHeaders when no WAF bot headers present', () => {
      const event = makeCloudFrontEvent('/api/data', {
        host: [{ key: 'Host', value: 'example.com' }],
        'content-type': [{ key: 'Content-Type', value: 'text/html' }],
      });

      const parsed = extractRequest(event);

      expect(parsed.botHeaders).toEqual({});
    });

    it('should not include non-WAF headers in botHeaders', () => {
      const event = makeCloudFrontEvent('/api/data', {
        host: [{ key: 'Host', value: 'example.com' }],
        'x-custom-header': [{ key: 'x-custom-header', value: 'custom' }],
        'x-amzn-waf-actor-type': [
          { key: 'x-amzn-waf-actor-type', value: 'verified-bot' },
        ],
      });

      const parsed = extractRequest(event);

      expect(parsed.botHeaders).toEqual({
        'x-amzn-waf-actor-type': 'verified-bot',
      });
      expect(parsed.botHeaders['x-custom-header']).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// attachHeader
// ---------------------------------------------------------------------------

describe('attachHeader', () => {
  it('should add a new header to the request', () => {
    const request: CloudFrontRequest = {
      clientIp: '203.0.113.178',
      method: 'GET',
      uri: '/api/data',
      querystring: '',
      headers: {
        host: [{ key: 'Host', value: 'example.com' }],
      },
    };

    attachHeader(request, 'x-x402-pending-settlement', 'settlement-data-123');

    expect(request.headers['x-x402-pending-settlement']).toEqual([
      { key: 'x-x402-pending-settlement', value: 'settlement-data-123' },
    ]);
  });

  it('should replace an existing header', () => {
    const request: CloudFrontRequest = {
      clientIp: '203.0.113.178',
      method: 'GET',
      uri: '/api/data',
      querystring: '',
      headers: {
        host: [{ key: 'Host', value: 'example.com' }],
        'x-custom': [{ key: 'x-custom', value: 'old-value' }],
      },
    };

    attachHeader(request, 'x-custom', 'new-value');

    expect(request.headers['x-custom']).toEqual([
      { key: 'x-custom', value: 'new-value' },
    ]);
  });

  it('should store the header key in lowercase', () => {
    const request: CloudFrontRequest = {
      clientIp: '203.0.113.178',
      method: 'GET',
      uri: '/api/data',
      querystring: '',
      headers: {},
    };

    attachHeader(request, 'X-Custom-Header', 'value');

    expect(request.headers['x-custom-header']).toEqual([
      { key: 'X-Custom-Header', value: 'value' },
    ]);
    expect(request.headers['X-Custom-Header']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// removeHeader
// ---------------------------------------------------------------------------

describe('removeHeader', () => {
  it('should remove an existing header from the request', () => {
    const request: CloudFrontRequest = {
      clientIp: '203.0.113.178',
      method: 'GET',
      uri: '/api/data',
      querystring: '',
      headers: {
        host: [{ key: 'Host', value: 'example.com' }],
        'x-x402-pending-settlement': [
          { key: 'x-x402-pending-settlement', value: 'data' },
        ],
      },
    };

    removeHeader(request, 'x-x402-pending-settlement');

    expect(request.headers['x-x402-pending-settlement']).toBeUndefined();
    // Other headers should remain
    expect(request.headers['host']).toBeDefined();
  });

  it('should handle case-insensitive key lookup', () => {
    const request: CloudFrontRequest = {
      clientIp: '203.0.113.178',
      method: 'GET',
      uri: '/api/data',
      querystring: '',
      headers: {
        'x-x402-pending-settlement': [
          { key: 'x-x402-pending-settlement', value: 'data' },
        ],
      },
    };

    removeHeader(request, 'X-X402-Pending-Settlement');

    expect(request.headers['x-x402-pending-settlement']).toBeUndefined();
  });

  it('should be a no-op when the header does not exist', () => {
    const request: CloudFrontRequest = {
      clientIp: '203.0.113.178',
      method: 'GET',
      uri: '/api/data',
      querystring: '',
      headers: {
        host: [{ key: 'Host', value: 'example.com' }],
      },
    };

    // Should not throw
    removeHeader(request, 'x-nonexistent');

    expect(request.headers['host']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// removeResponseHeader
// ---------------------------------------------------------------------------

describe('removeResponseHeader', () => {
  it('should remove a header from the response', () => {
    const response: CloudFrontResultResponse = {
      status: '200',
      statusDescription: 'OK',
      headers: {
        'content-type': [{ key: 'Content-Type', value: 'text/html' }],
        'x-x402-pending-settlement': [
          { key: 'x-x402-pending-settlement', value: 'settlement-data' },
        ],
      },
    };

    removeResponseHeader(response, 'x-x402-pending-settlement');

    expect(response.headers!['x-x402-pending-settlement']).toBeUndefined();
    expect(response.headers!['content-type']).toBeDefined();
  });

  it('should handle case-insensitive key lookup', () => {
    const response: CloudFrontResultResponse = {
      status: '200',
      statusDescription: 'OK',
      headers: {
        'x-x402-pending-settlement': [
          { key: 'x-x402-pending-settlement', value: 'data' },
        ],
      },
    };

    removeResponseHeader(response, 'X-X402-Pending-Settlement');

    expect(response.headers!['x-x402-pending-settlement']).toBeUndefined();
  });

  it('should be a no-op when the header does not exist', () => {
    const response: CloudFrontResultResponse = {
      status: '200',
      statusDescription: 'OK',
      headers: {
        'content-type': [{ key: 'Content-Type', value: 'text/html' }],
      },
    };

    removeResponseHeader(response, 'x-nonexistent');

    expect(response.headers!['content-type']).toBeDefined();
  });

  it('should handle response with no headers object', () => {
    const response: CloudFrontResultResponse = {
      status: '200',
      statusDescription: 'OK',
    };

    // Should not throw
    removeResponseHeader(response, 'x-some-header');

    expect(response.headers).toBeUndefined();
  });
});

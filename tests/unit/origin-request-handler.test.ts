/**
 * Unit tests for Origin Request Lambda@Edge Handler Core Logic
 *
 * Tests the core functionality of the origin-request handler:
 * - Stripping client-supplied x-x402-pending-settlement header
 * - Reading and interpreting the WAF-injected x-x402-route-action header
 * - Pass-through behavior for absent or "0" route action headers
 * - Validation of price values in route action headers
 * - Payment flow: 402 response when middleware returns payment-error
 * - Payment flow: pass-through when middleware returns pass-through with payload
 * - Logging and metrics emission
 *
 */

import type {
  CloudFrontRequestEvent,
  CloudFrontRequest,
  CloudFrontResultResponse,
} from 'aws-lambda';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the handler
// ---------------------------------------------------------------------------

jest.mock('../../src/runtime/shared/config-loader', () => ({
  getEdgeConfig: jest.fn(),
}));

jest.mock('../../src/runtime/shared/x402-middleware', () => ({
  createX402Middleware: jest.fn(),
}));

jest.mock('../../src/runtime/shared/to-lambda-response', () => ({
  toLambdaResponse: jest.fn(),
}));

jest.mock('../../src/runtime/shared/logger', () => {
  const actual = jest.requireActual('../../src/runtime/shared/logger');
  return {
    ...actual,
    emitVerification: jest.fn(),
    emitPaymentRequested: jest.fn(),
  };
});

import { handler } from '../../src/runtime/origin-request/handler';
import { getEdgeConfig } from '../../src/runtime/shared/config-loader';
import { createX402Middleware } from '../../src/runtime/shared/x402-middleware';
import { toLambdaResponse } from '../../src/runtime/shared/to-lambda-response';
import { emitVerification, emitPaymentRequested } from '../../src/runtime/shared/logger';

const mockGetEdgeConfig = getEdgeConfig as jest.MockedFunction<typeof getEdgeConfig>;
const mockCreateX402Middleware = createX402Middleware as jest.MockedFunction<typeof createX402Middleware>;
const mockToLambdaResponse = toLambdaResponse as jest.MockedFunction<typeof toLambdaResponse>;
const mockEmitVerification = emitVerification as jest.MockedFunction<typeof emitVerification>;
const mockEmitPaymentRequested = emitPaymentRequested as jest.MockedFunction<typeof emitPaymentRequested>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockEventOptions {
  headers?: Record<string, string>;
  method?: string;
  clientIp?: string;
  querystring?: string;
}

function createMockEvent(
  uri: string,
  options: MockEventOptions = {},
): CloudFrontRequestEvent {
  const {
    headers = {},
    method = 'GET',
    clientIp = '192.168.1.1',
    querystring = '',
  } = options;

  const cfHeaders: Record<string, Array<{ key: string; value: string }>> = {};
  for (const [key, value] of Object.entries(headers)) {
    cfHeaders[key.toLowerCase()] = [{ key, value }];
  }
  if (!cfHeaders['host']) {
    cfHeaders['host'] = [{ key: 'Host', value: 'example.com' }];
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
          request: { clientIp, headers: cfHeaders, method, querystring, uri },
        },
      },
    ],
  };
}

const mockEdgeConfig = {
  payTo: '0x1234567890abcdef1234567890abcdef12345678',
  network: 'eip155:84532',
  facilitatorUrl: 'https://x402.org/facilitator',
};

let mockProcessOriginRequest: jest.Mock;

function setupMiddleware(result: Record<string, unknown>): void {
  mockProcessOriginRequest = jest.fn().mockResolvedValue(result);
  mockCreateX402Middleware.mockReturnValue({
    processOriginRequest: mockProcessOriginRequest,
    processOriginResponse: jest.fn(),
  } as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Origin Request Handler - Core Logic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);
    // Default: middleware returns pass-through (no payment required)
    setupMiddleware({ type: 'pass-through' });
  });

  describe('Security: x-x402-pending-settlement header stripping', () => {
    it('should strip client-supplied x-x402-pending-settlement header', async () => {
      const event = createMockEvent('/api/data', {
        headers: { 'x-x402-pending-settlement': 'malicious-settlement-data' },
      });
      const result = await handler(event);
      const request = result as CloudFrontRequest;
      expect(request.headers['x-x402-pending-settlement']).toBeUndefined();
    });

    it('should strip x-x402-pending-settlement header regardless of case', async () => {
      const event = createMockEvent('/api/data', {
        headers: { 'X-X402-Pending-Settlement': 'malicious-data' },
      });
      const result = await handler(event);
      const request = result as CloudFrontRequest;
      expect(request.headers['x-x402-pending-settlement']).toBeUndefined();
    });

    it('should pass through request without settlement header unchanged', async () => {
      const event = createMockEvent('/api/data', {
        headers: { 'x-custom-header': 'custom-value' },
      });
      const result = await handler(event);
      const request = result as CloudFrontRequest;
      expect(request.headers['x-custom-header']).toBeDefined();
      expect(request.headers['x-custom-header'][0].value).toBe('custom-value');
    });
  });

  describe('Route action header interpretation', () => {
    it('should pass through when x-amzn-waf-x-x402-route-action header is absent', async () => {
      const event = createMockEvent('/api/data');
      const result = await handler(event);
      const request = result as CloudFrontRequest;
      expect(request.uri).toBe('/api/data');
      expect(request.method).toBe('GET');
    });

    it('should pass through when x-amzn-waf-x-x402-route-action header is "0"', async () => {
      const event = createMockEvent('/api/data', {
        headers: { 'x-amzn-waf-x-x402-route-action': '0' },
      });
      const result = await handler(event);
      const request = result as CloudFrontRequest;
      expect(request.uri).toBe('/api/data');
    });

    it('should invoke middleware when price is present', async () => {
      setupMiddleware({ type: 'payment-error', response: { status: 402, headers: {}, body: {} } });
      mockToLambdaResponse.mockReturnValue({ status: '402', statusDescription: 'Payment Required', headers: {}, body: '{}' });

      const event = createMockEvent('/api/data', {
        headers: { 'x-amzn-waf-x-x402-route-action': '0.001' },
      });
      await handler(event);
      expect(mockProcessOriginRequest).toHaveBeenCalled();
    });
  });

  describe('Invalid route action header handling', () => {
    it('should pass through when route action header is non-numeric', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const event = createMockEvent('/api/data', {
        headers: { 'x-amzn-waf-x-x402-route-action': 'invalid' },
      });
      const result = await handler(event);
      const request = result as CloudFrontRequest;
      expect(request.uri).toBe('/api/data');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid x-amzn-waf-x-x402-route-action header value'),
      );
      warnSpy.mockRestore();
    });

    it('should pass through when route action header is negative', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const event = createMockEvent('/api/data', {
        headers: { 'x-amzn-waf-x-x402-route-action': '-0.001' },
      });
      const result = await handler(event);
      const request = result as CloudFrontRequest;
      expect(request.uri).toBe('/api/data');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should pass through when route action header is empty string', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const event = createMockEvent('/api/data', {
        headers: { 'x-amzn-waf-x-x402-route-action': '' },
      });
      const result = await handler(event);
      const request = result as CloudFrontRequest;
      expect(request.uri).toBe('/api/data');
      warnSpy.mockRestore();
    });
  });

  describe('Request preservation', () => {
    it('should preserve original request URI', async () => {
      const event = createMockEvent('/api/premium/data');
      const result = await handler(event);
      expect((result as CloudFrontRequest).uri).toBe('/api/premium/data');
    });

    it('should preserve original request method', async () => {
      const event = createMockEvent('/api/data', { method: 'POST' });
      const result = await handler(event);
      expect((result as CloudFrontRequest).method).toBe('POST');
    });

    it('should preserve other headers when stripping settlement header', async () => {
      const event = createMockEvent('/api/data', {
        headers: {
          'x-x402-pending-settlement': 'malicious-data',
          'authorization': 'Bearer token123',
          'content-type': 'application/json',
        },
      });
      const result = await handler(event);
      const request = result as CloudFrontRequest;
      expect(request.headers['x-x402-pending-settlement']).toBeUndefined();
      expect(request.headers['authorization']).toBeDefined();
      expect(request.headers['content-type']).toBeDefined();
    });

    it('should preserve client IP address', async () => {
      const event = createMockEvent('/api/data', { clientIp: '10.0.0.1' });
      const result = await handler(event);
      expect((result as CloudFrontRequest).clientIp).toBe('10.0.0.1');
    });

    it('should preserve query string', async () => {
      const event = createMockEvent('/api/data', { querystring: 'param1=value1&param2=value2' });
      const result = await handler(event);
      expect((result as CloudFrontRequest).querystring).toBe('param1=value1&param2=value2');
    });
  });

  describe('Payment flow - middleware returns payment-error', () => {
    it('should return 402 via toLambdaResponse when middleware returns payment-error', async () => {
      const mockResponse = { status: 402, headers: { 'x-test': 'val' }, body: { error: 'no payment' } };
      setupMiddleware({ type: 'payment-error', response: mockResponse });
      mockToLambdaResponse.mockReturnValue({
        status: '402',
        statusDescription: 'Payment Required',
        headers: {},
        body: '{"error":"no payment"}',
      });

      const event = createMockEvent('/api/data', {
        headers: { 'x-amzn-waf-x-x402-route-action': '0.001' },
      });
      const result = await handler(event);
      expect(mockToLambdaResponse).toHaveBeenCalledWith(mockResponse);
      expect((result as CloudFrontResultResponse).status).toBe('402');
    });

    it('should log payment requested', async () => {
      setupMiddleware({ type: 'payment-error', response: { status: 402, headers: {}, body: {} } });
      mockToLambdaResponse.mockReturnValue({ status: '402', statusDescription: 'Payment Required', headers: {}, body: '{}' });

      const event = createMockEvent('/api/data', {
        headers: { 'x-amzn-waf-x-x402-route-action': '0.001' },
      });
      await handler(event);
      expect(mockEmitPaymentRequested).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/api/data', price: '0.001' }),
      );
    });

  });

  describe('Payment flow - successful verification', () => {
    it('should forward request to origin when middleware returns pass-through with payload', async () => {
      setupMiddleware({ type: 'pass-through', paymentPayload: { some: 'data' }, paymentRequirements: {} });

      const event = createMockEvent('/api/data', {
        headers: {
          'x-amzn-waf-x-x402-route-action': '0.001',
          'x-payment': 'test-payment-signature',
        },
      });
      const result = await handler(event);
      const request = result as CloudFrontRequest;
      expect(request.uri).toBe('/api/data');
      expect((result as CloudFrontResultResponse).status).toBeUndefined();
    });

    it('should log successful verification', async () => {
      setupMiddleware({ type: 'pass-through', paymentPayload: { some: 'data' }, paymentRequirements: {} });

      const event = createMockEvent('/api/data', {
        headers: {
          'x-amzn-waf-x-x402-route-action': '0.001',
          'x-payment': 'test-payment-signature',
        },
      });
      await handler(event);
      expect(mockEmitVerification).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/api/data' }),
        'success',
        null,
      );
    });

  });

  describe('No logging for passthrough', () => {
    it('should not log when no payment is attempted', async () => {
      setupMiddleware({ type: 'pass-through' });

      const event = createMockEvent('/api/data', {
        headers: { 'x-amzn-waf-x-x402-route-action': '0.001' },
      });
      await handler(event);
      expect(mockEmitVerification).not.toHaveBeenCalled();
    });
  });
});

describe('Origin Request Handler - Verification Failure (payment-error with payment header)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEdgeConfig.mockResolvedValue(mockEdgeConfig);
  });

  it('should log verification failure when payment header present but middleware returns payment-error', async () => {
    setupMiddleware({ type: 'payment-error', response: { status: 402, headers: {}, body: {} } });
    mockToLambdaResponse.mockReturnValue({ status: '402', statusDescription: 'Payment Required', headers: {}, body: '{}' });

    const event = createMockEvent('/api/data', {
      headers: {
        'x-amzn-waf-x-x402-route-action': '0.001',
        'x-payment': 'invalid-payment-proof',
      },
    });
    await handler(event);

    // Should log verification failure, NOT payment-requested
    expect(mockEmitVerification).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/data' }),
      'failure',
      'Payment verification rejected by facilitator',
    );
    expect(mockEmitPaymentRequested).not.toHaveBeenCalled();
  });

  it('should still return 402 response on verification failure', async () => {
    const mockResponse = { status: 402, headers: {}, body: { error: 'bad payment' } };
    setupMiddleware({ type: 'payment-error', response: mockResponse });
    mockToLambdaResponse.mockReturnValue({
      status: '402',
      statusDescription: 'Payment Required',
      headers: {},
      body: '{"error":"bad payment"}',
    });

    const event = createMockEvent('/api/data', {
      headers: {
        'x-amzn-waf-x-x402-route-action': '0.001',
        'x-payment': 'invalid-payment-proof',
      },
    });
    const result = await handler(event);
    expect(mockToLambdaResponse).toHaveBeenCalledWith(mockResponse);
    expect((result as CloudFrontResultResponse).status).toBe('402');
  });
});

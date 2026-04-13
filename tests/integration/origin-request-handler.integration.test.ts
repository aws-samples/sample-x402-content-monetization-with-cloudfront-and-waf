/**
 * Integration Tests for Origin Request Lambda@Edge Handler
 *
 * Tests the full request flow with mocked AWS SDK (SSM, Secrets Manager) and
 * x402 middleware. The handler delegates payment verification to the x402
 * middleware, which is mocked at the module level to control test scenarios.
 *
 * Test scenarios:
 * - No payment required (header absent)
 * - Free access (header "0")
 * - Payment required + no payment header (402)
 * - Payment required + valid payment (forward to origin)
 * - Payment required + invalid payment (402 with error)
 * - Security: settlement header stripping
 * - Config caching behavior
 * - Edge cases (query strings, HTTP methods, deep paths, special characters)
 *
 */

import type {
  CloudFrontRequestEvent,
  CloudFrontRequest,
  CloudFrontResultResponse,
} from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the handler
// ---------------------------------------------------------------------------

// Mock the x402 middleware module
jest.mock('../../src/runtime/shared/x402-middleware', () => ({
  createX402Middleware: jest.fn(),
}));

// Mock the toLambdaResponse helper
jest.mock('../../src/runtime/shared/to-lambda-response', () => ({
  toLambdaResponse: jest.fn(),
}));

// Import the handler and config-loader test helpers
import { handler } from '../../src/runtime/origin-request/handler';
import {
  resetCache,
  _setSsmPrefix,
  _setSsmClient,
} from '../../src/runtime/shared/config-loader';
import { createX402Middleware } from '../../src/runtime/shared/x402-middleware';
import { toLambdaResponse } from '../../src/runtime/shared/to-lambda-response';
import type { OriginRequestResult } from '../../src/runtime/shared/x402-middleware';

const mockCreateX402Middleware = createX402Middleware as jest.MockedFunction<typeof createX402Middleware>;
const mockToLambdaResponse = toLambdaResponse as jest.MockedFunction<typeof toLambdaResponse>;

// Create mock clients
const ssmMock = mockClient(SSMClient);

// ---------------------------------------------------------------------------
// Test Configuration
// ---------------------------------------------------------------------------

const TEST_SSM_PREFIX = '/x402-edge/test-stack/config';

const TESTNET_CONFIG = {
  payTo: '0x1234567890abcdef1234567890abcdef12345678',
  network: 'eip155:84532',
  facilitatorUrl: 'https://x402.org/facilitator',
};

// ---------------------------------------------------------------------------
// Mock middleware helpers
// ---------------------------------------------------------------------------

let mockProcessOriginRequest: jest.Mock;

function setupMiddlewareMock(result: OriginRequestResult): void {
  mockProcessOriginRequest = jest.fn().mockResolvedValue(result);
  mockCreateX402Middleware.mockReturnValue({
    processOriginRequest: mockProcessOriginRequest,
    processOriginResponse: jest.fn(),
  } as any);
}

function passThrough(): OriginRequestResult {
  return { type: 'pass-through' };
}

function paymentVerified(
  payload: unknown = { txHash: '0xabc123' },
  requirements: unknown = { scheme: 'exact', price: '1000' },
): OriginRequestResult {
  return {
    type: 'pass-through',
    paymentPayload: payload,
    paymentRequirements: requirements,
  };
}

function paymentError(
  status = 402,
  headers: Record<string, string> = { 'Content-Type': 'application/json' },
  body?: unknown,
): OriginRequestResult {
  return {
    type: 'payment-error',
    response: { status, headers, body },
  };
}

// ---------------------------------------------------------------------------
// Helper Functions
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
    clientIp = '203.0.113.50',
    querystring = '',
  } = options;

  const cfHeaders: Record<string, Array<{ key: string; value: string }>> = {};

  for (const [key, value] of Object.entries(headers)) {
    cfHeaders[key.toLowerCase()] = [{ key, value }];
  }

  if (!cfHeaders['host']) {
    cfHeaders['host'] = [{ key: 'Host', value: 'api.publisher.example.com' }];
  }
  if (!cfHeaders['user-agent']) {
    cfHeaders['user-agent'] = [{ key: 'User-Agent', value: 'GPTBot/1.0' }];
  }
  if (!cfHeaders['x-forwarded-for']) {
    cfHeaders['x-forwarded-for'] = [{ key: 'X-Forwarded-For', value: clientIp }];
  }

  return {
    Records: [
      {
        cf: {
          config: {
            distributionDomainName: 'd123abc.cloudfront.net',
            distributionId: 'E1EXAMPLE',
            eventType: 'origin-request',
            requestId: `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          },
          request: {
            clientIp,
            headers: cfHeaders,
            method,
            querystring,
            uri,
          },
        },
      },
    ],
  };
}

function setupTestnetSsmMock(): void {
  ssmMock.on(GetParameterCommand, { Name: `${TEST_SSM_PREFIX}/payto` }).resolves({
    Parameter: { Value: TESTNET_CONFIG.payTo },
  });
  ssmMock.on(GetParameterCommand, { Name: `${TEST_SSM_PREFIX}/network` }).resolves({
    Parameter: { Value: TESTNET_CONFIG.network },
  });
  ssmMock.on(GetParameterCommand, { Name: `${TEST_SSM_PREFIX}/facilitator-url` }).resolves({
    Parameter: { Value: TESTNET_CONFIG.facilitatorUrl },
  });
}

import type { CloudFrontRequestResult } from 'aws-lambda';

function isRequest(result: CloudFrontRequestResult): result is CloudFrontRequest {
  return result != null && 'uri' in result && !('status' in result);
}

function isResponse(result: CloudFrontRequestResult): result is CloudFrontResultResponse {
  return result != null && 'status' in result;
}


// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Origin Request Handler Integration Tests', () => {
  beforeEach(() => {
    ssmMock.reset();
    resetCache();
    _setSsmPrefix(TEST_SSM_PREFIX);
    _setSsmClient(new SSMClient({}));
    mockCreateX402Middleware.mockReset();
    mockToLambdaResponse.mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // No payment required (header absent)
  // -----------------------------------------------------------------------
  describe('No payment required (header absent)', () => {
    it('should pass through when x-x402-route-action header is absent', async () => {
      const event = createMockEvent('/api/data');
      const result = await handler(event);

      expect(isRequest(result)).toBe(true);
      expect((result as CloudFrontRequest).uri).toBe('/api/data');
      // Middleware should NOT be called
      expect(mockCreateX402Middleware).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Free access (header "0")
  // -----------------------------------------------------------------------
  describe('Free access (header "0")', () => {
    it('should pass through when x-x402-route-action header is "0"', async () => {
      const event = createMockEvent('/api/free', {
        headers: { 'x-amzn-waf-x-x402-route-action': '0' },
      });
      const result = await handler(event);

      expect(isRequest(result)).toBe(true);
      expect((result as CloudFrontRequest).uri).toBe('/api/free');
      expect(mockCreateX402Middleware).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Payment required + no payment header (402)
  // -----------------------------------------------------------------------
  describe('Payment required + no payment header (402)', () => {
    it('should return 402 when middleware returns payment-error', async () => {
      setupTestnetSsmMock();
      setupMiddlewareMock(paymentError());

      const mock402Response: CloudFrontResultResponse = {
        status: '402',
        statusDescription: 'Payment Required',
        headers: {
          'content-type': [{ key: 'Content-Type', value: 'application/json' }],
        },
        body: JSON.stringify({ error: 'Payment required' }),
      };
      mockToLambdaResponse.mockReturnValue(mock402Response);

      const event = createMockEvent('/api/premium', {
        headers: { 'x-amzn-waf-x-x402-route-action': '0.001' },
      });
      const result = await handler(event);

      expect(isResponse(result)).toBe(true);
      expect((result as CloudFrontResultResponse).status).toBe('402');
      expect(mockCreateX402Middleware).toHaveBeenCalled();
      expect(mockProcessOriginRequest).toHaveBeenCalled();
      expect(mockToLambdaResponse).toHaveBeenCalledWith(
        expect.objectContaining({ status: 402 }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Payment required + valid payment (forward to origin)
  // -----------------------------------------------------------------------
  describe('Payment required + valid payment (forward to origin)', () => {
    it('should forward request to origin when middleware returns pass-through with payload', async () => {
      setupTestnetSsmMock();
      setupMiddlewareMock(paymentVerified());

      const event = createMockEvent('/api/premium', {
        headers: {
          'x-amzn-waf-x-x402-route-action': '0.001',
          'x-payment': 'valid-payment-token',
        },
      });
      const result = await handler(event);

      expect(isRequest(result)).toBe(true);
      expect((result as CloudFrontRequest).uri).toBe('/api/premium');
      expect(mockCreateX402Middleware).toHaveBeenCalled();
      expect(mockProcessOriginRequest).toHaveBeenCalled();
      // toLambdaResponse should NOT be called for pass-through
      expect(mockToLambdaResponse).not.toHaveBeenCalled();
    });

    it('should pass correct RoutesConfig to middleware', async () => {
      setupTestnetSsmMock();
      setupMiddlewareMock(paymentVerified());

      const event = createMockEvent('/api/premium', {
        headers: {
          'x-amzn-waf-x-x402-route-action': '0.005',
          'x-payment': 'valid-payment-token',
        },
      });
      await handler(event);

      // Verify the middleware was constructed with correct config
      expect(mockCreateX402Middleware).toHaveBeenCalledWith(
        expect.objectContaining({
          facilitatorUrl: TESTNET_CONFIG.facilitatorUrl,
          network: TESTNET_CONFIG.network,
          routes: expect.objectContaining({
            'GET /*': expect.objectContaining({
              accepts: expect.objectContaining({
                scheme: 'exact',
                payTo: TESTNET_CONFIG.payTo,
                price: 0.005,
                network: TESTNET_CONFIG.network,
              }),
            }),
          }),
        }),
      );

      // Verify processOriginRequest was called with request and host
      expect(mockProcessOriginRequest).toHaveBeenCalledWith(
        expect.any(Object), // request
        'api.publisher.example.com', // host from headers
      );
    });
  });

  // -----------------------------------------------------------------------
  // Payment required + invalid payment (402 with error)
  // -----------------------------------------------------------------------
  describe('Payment required + invalid payment (402 with error)', () => {
    it('should return 402 when middleware returns payment-error for invalid payment', async () => {
      setupTestnetSsmMock();
      const errorResult = paymentError(402, { 'Content-Type': 'application/json' }, {
        error: 'Invalid payment signature',
      });
      setupMiddlewareMock(errorResult);

      const mock402Response: CloudFrontResultResponse = {
        status: '402',
        statusDescription: 'Payment Required',
        headers: {},
        body: JSON.stringify({ error: 'Invalid payment signature' }),
      };
      mockToLambdaResponse.mockReturnValue(mock402Response);

      const event = createMockEvent('/api/premium', {
        headers: {
          'x-amzn-waf-x-x402-route-action': '0.001',
          'x-payment': 'invalid-payment-token',
        },
      });
      const result = await handler(event);

      expect(isResponse(result)).toBe(true);
      expect((result as CloudFrontResultResponse).status).toBe('402');
      expect(mockToLambdaResponse).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Security: Settlement header stripping
  // -----------------------------------------------------------------------
  describe('Security: Settlement header stripping', () => {
    it('should delegate to middleware which strips the pending settlement header', async () => {
      setupTestnetSsmMock();
      setupMiddlewareMock(passThrough());

      const event = createMockEvent('/api/premium', {
        headers: {
          'x-amzn-waf-x-x402-route-action': '0.001',
          'x-x402-pending-settlement': 'malicious-injected-value',
        },
      });
      await handler(event);

      // The middleware is responsible for stripping the header.
      // Verify middleware was called (it handles stripping internally).
      expect(mockProcessOriginRequest).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Config caching behavior
  // -----------------------------------------------------------------------
  describe('Config caching behavior', () => {
    it('should call SSM on first request and use cache on second', async () => {
      setupTestnetSsmMock();
      setupMiddlewareMock(passThrough());

      const event1 = createMockEvent('/api/data1', {
        headers: { 'x-amzn-waf-x-x402-route-action': '0.001' },
      });
      await handler(event1);

      // SSM should have been called for the 3 config params
      expect(ssmMock.commandCalls(GetParameterCommand).length).toBe(3);

      // Second request — should use cached config
      setupMiddlewareMock(passThrough());
      const event2 = createMockEvent('/api/data2', {
        headers: { 'x-amzn-waf-x-x402-route-action': '0.002' },
      });
      await handler(event2);

      // SSM should NOT have been called again (still 3 total)
      expect(ssmMock.commandCalls(GetParameterCommand).length).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Invalid WAF header values
  // -----------------------------------------------------------------------
  describe('Invalid WAF header values', () => {
    it('should pass through for non-numeric header value', async () => {
      const event = createMockEvent('/api/data', {
        headers: { 'x-amzn-waf-x-x402-route-action': 'not-a-number' },
      });
      const result = await handler(event);

      expect(isRequest(result)).toBe(true);
      expect(mockCreateX402Middleware).not.toHaveBeenCalled();
    });

    it('should pass through for negative price', async () => {
      const event = createMockEvent('/api/data', {
        headers: { 'x-amzn-waf-x-x402-route-action': '-0.5' },
      });
      const result = await handler(event);

      expect(isRequest(result)).toBe(true);
      expect(mockCreateX402Middleware).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Logging and metrics
  // -----------------------------------------------------------------------
  describe('Logging and metrics', () => {
    it('should log payment-requested event when no payment header present', async () => {
      setupTestnetSsmMock();
      setupMiddlewareMock(paymentError());
      mockToLambdaResponse.mockReturnValue({
        status: '402',
        statusDescription: 'Payment Required',
        headers: {},
        body: '',
      });

      const event = createMockEvent('/api/premium', {
        headers: { 'x-amzn-waf-x-x402-route-action': '0.001' },
      });
      await handler(event);

      // No payment header → emitPaymentRequested via console.log (INFO)
      expect(console.log).toHaveBeenCalled();
      const logCall = (console.log as jest.Mock).mock.calls[0][0];
      const logEntry = JSON.parse(logCall);
      expect(logEntry.event).toBe('payment-requested');
      expect(logEntry.path).toBe('/api/premium');
      expect(logEntry.price).toBe('0.001');
    });

    it('should log verification failure when payment header present but rejected', async () => {
      setupTestnetSsmMock();
      setupMiddlewareMock(paymentError());
      mockToLambdaResponse.mockReturnValue({
        status: '402',
        statusDescription: 'Payment Required',
        headers: {},
        body: '',
      });

      const event = createMockEvent('/api/premium', {
        headers: {
          'x-amzn-waf-x-x402-route-action': '0.001',
          'x-payment': 'invalid-payment-token',
        },
      });
      await handler(event);

      // Has payment header + payment error → emitVerification failure via console.error
      expect(console.error).toHaveBeenCalled();
      const logCall = (console.error as jest.Mock).mock.calls[0][0];
      const logEntry = JSON.parse(logCall);
      expect(logEntry.event).toBe('verification');
      expect(logEntry.path).toBe('/api/premium');
      expect(logEntry.price).toBe('0.001');
      expect(logEntry.result).toBe('failure');
    });

    it('should log verification event on successful payment', async () => {
      setupTestnetSsmMock();
      setupMiddlewareMock(paymentVerified());

      const event = createMockEvent('/api/premium', {
        headers: {
          'x-amzn-waf-x-x402-route-action': '0.001',
          'x-payment': 'valid-token',
        },
      });
      await handler(event);

      expect(console.log).toHaveBeenCalled();
      const logCall = (console.log as jest.Mock).mock.calls[0][0];
      const logEntry = JSON.parse(logCall);
      expect(logEntry.event).toBe('verification');
      expect(logEntry.result).toBe('success');
    });

    it('should not log when no payment is attempted (pass-through without payload)', async () => {
      setupTestnetSsmMock();
      setupMiddlewareMock(passThrough());

      const event = createMockEvent('/api/premium', {
        headers: { 'x-amzn-waf-x-x402-route-action': '0.001' },
      });
      await handler(event);

      // No payment was attempted (no payload, no error), so no log
      expect(console.log).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe('Edge cases', () => {
    it('should handle requests with query strings', async () => {
      setupTestnetSsmMock();
      setupMiddlewareMock(passThrough());

      const event = createMockEvent('/api/data', {
        headers: { 'x-amzn-waf-x-x402-route-action': '0.001' },
        querystring: 'page=1&limit=10',
      });
      const result = await handler(event);

      expect(isRequest(result)).toBe(true);
      expect(mockProcessOriginRequest).toHaveBeenCalled();
    });

    it('should handle deep paths', async () => {
      setupTestnetSsmMock();
      setupMiddlewareMock(passThrough());

      const event = createMockEvent('/api/v2/users/123/profile', {
        headers: { 'x-amzn-waf-x-x402-route-action': '0.01' },
      });
      const result = await handler(event);

      expect(isRequest(result)).toBe(true);
      expect(mockProcessOriginRequest).toHaveBeenCalled();
    });

    it('should handle various HTTP methods', async () => {
      setupTestnetSsmMock();
      setupMiddlewareMock(passThrough());

      const event = createMockEvent('/api/data', {
        headers: { 'x-amzn-waf-x-x402-route-action': '0.001' },
        method: 'POST',
      });
      const result = await handler(event);

      expect(isRequest(result)).toBe(true);
      expect(mockProcessOriginRequest).toHaveBeenCalled();
    });

    it('should handle special characters in URI', async () => {
      setupTestnetSsmMock();
      setupMiddlewareMock(passThrough());

      const event = createMockEvent('/api/data%20with%20spaces', {
        headers: { 'x-amzn-waf-x-x402-route-action': '0.001' },
      });
      const result = await handler(event);

      expect(isRequest(result)).toBe(true);
    });
  });
});

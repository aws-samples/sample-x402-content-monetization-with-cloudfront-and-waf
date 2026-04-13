/**
 * Integration Tests for Origin Response Lambda@Edge Handler
 *
 * Tests the full response flow with mocked x402 middleware.
 * These tests validate the interaction between the origin-response handler
 * and its dependencies (config-loader, x402-middleware, logger, metrics).
 *
 * Test scenarios:
 * - No settlement header (passthrough)
 * - Settlement header + success status (settle)
 * - Settlement header + error status (skip settlement)
 * - Settlement success
 * - Settlement failure (log and return origin response)
 * - Response header cleanup
 *
 */

import type {
  CloudFrontResponseEvent,
  CloudFrontResponse,
} from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the handler
// ---------------------------------------------------------------------------

jest.mock('../../src/runtime/shared/x402-middleware', () => ({
  createX402Middleware: jest.fn(),
}));

// Import the handler and config-loader test helpers
import { handler } from '../../src/runtime/origin-response/handler';
import {
  resetCache,
  _setSsmPrefix,
  _setSsmClient,
} from '../../src/runtime/shared/config-loader';
import { createX402Middleware } from '../../src/runtime/shared/x402-middleware';
import type { OriginResponseResult } from '../../src/runtime/shared/x402-middleware';

const mockCreateX402Middleware = createX402Middleware as jest.MockedFunction<typeof createX402Middleware>;

// Create mock clients
const ssmMock = mockClient(SSMClient);

// ---------------------------------------------------------------------------
// Test Configuration
// ---------------------------------------------------------------------------

const TEST_SSM_PREFIX = '/x402-edge/test-stack/config';

/** Realistic mock configuration for testnet deployment. */
const TESTNET_CONFIG = {
  payTo: '0x1234567890abcdef1234567890abcdef12345678',
  network: 'eip155:84532',
  facilitatorUrl: 'https://x402.org/facilitator',
};

// ---------------------------------------------------------------------------
// Mock middleware helpers
// ---------------------------------------------------------------------------

let mockProcessOriginResponse: jest.Mock;

function setupMiddlewareMock(result: OriginResponseResult): void {
  mockProcessOriginResponse = jest.fn().mockResolvedValue(result);
  mockCreateX402Middleware.mockReturnValue({
    processOriginRequest: jest.fn(),
    processOriginResponse: mockProcessOriginResponse,
  } as any);
}

function setupMiddlewareMockThrow(error: Error): void {
  mockProcessOriginResponse = jest.fn().mockRejectedValue(error);
  mockCreateX402Middleware.mockReturnValue({
    processOriginRequest: jest.fn(),
    processOriginResponse: mockProcessOriginResponse,
  } as any);
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

interface MockResponseEventOptions {
  uri?: string;
  status?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  clientIp?: string;
  method?: string;
}

/**
 * Helper function to create a realistic CloudFront origin-response event.
 */
function createMockResponseEvent(
  options: MockResponseEventOptions = {},
): CloudFrontResponseEvent {
  const {
    uri = '/api/data',
    status = 200,
    requestHeaders = {},
    responseHeaders = {},
    clientIp = '203.0.113.50',
    method = 'GET',
  } = options;

  // Build CloudFront request headers
  const cfRequestHeaders: Record<string, Array<{ key: string; value: string }>> = {};
  for (const [key, value] of Object.entries(requestHeaders)) {
    cfRequestHeaders[key.toLowerCase()] = [{ key, value }];
  }
  if (!cfRequestHeaders['host']) {
    cfRequestHeaders['host'] = [{ key: 'Host', value: 'api.publisher.example.com' }];
  }
  if (!cfRequestHeaders['x-forwarded-for']) {
    cfRequestHeaders['x-forwarded-for'] = [{ key: 'X-Forwarded-For', value: clientIp }];
  }

  // Build CloudFront response headers
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
            distributionDomainName: 'd123abc.cloudfront.net',
            distributionId: 'E1EXAMPLE',
            eventType: 'origin-response' as const,
            requestId: `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          },
          request: {
            clientIp,
            headers: cfRequestHeaders,
            method,
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

/** Set up SSM mock to return testnet configuration. */
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

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Origin Response Handler - Integration Tests', () => {
  beforeAll(() => {
    // Configure the config-loader to use test prefixes
    _setSsmPrefix(TEST_SSM_PREFIX);

    // Inject mock clients
    _setSsmClient(ssmMock as unknown as SSMClient);
  });

  beforeEach(() => {
    // Reset all mocks before each test
    ssmMock.reset();
    resetCache();
    mockCreateX402Middleware.mockReset();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: No settlement header (passthrough)
  // -------------------------------------------------------------------------
  describe('Scenario: No settlement header (passthrough)', () => {
    /**
     * When the request does not contain an x-x402-pending-settlement header,
     * the response should pass through unchanged.
     */
    it('should pass through response unchanged when no settlement header in request', async () => {
      const event = createMockResponseEvent({
        uri: '/api/public/data',
        status: 200,
        requestHeaders: {
          'accept': 'application/json',
        },
      });

      const result = await handler(event);

      // Response should pass through
      const cfResponse = result as CloudFrontResponse;
      expect(cfResponse.status).toBe('200');

      // SSM should not be called (no settlement processing needed)
      expect(ssmMock.calls()).toHaveLength(0);

      // Middleware should NOT be called
      expect(mockCreateX402Middleware).not.toHaveBeenCalled();
    });

    it('should preserve all original response headers when passing through', async () => {
      const event = createMockResponseEvent({
        uri: '/api/public/data',
        status: 200,
        requestHeaders: {},
        responseHeaders: {
          'x-custom-response': 'custom-value',
          'cache-control': 'max-age=3600',
        },
      });

      const result = await handler(event);

      const cfResponse = result as CloudFrontResponse;
      expect(cfResponse.headers['x-custom-response']).toBeDefined();
      expect(cfResponse.headers['cache-control']).toBeDefined();
    });

    it('should remove settlement header from response even when not in request', async () => {
      const event = createMockResponseEvent({
        uri: '/api/public/data',
        status: 200,
        requestHeaders: {},
        responseHeaders: {
          'x-x402-pending-settlement': 'leaked-value',
        },
      });

      const result = await handler(event);

      const cfResponse = result as CloudFrontResponse;
      expect(cfResponse.headers['x-x402-pending-settlement']).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Settlement header + success status (settle)
  // -------------------------------------------------------------------------
  describe('Scenario: Settlement header + success status (settle)', () => {
    beforeEach(() => {
      setupTestnetSsmMock();
    });

    /**
     * When the request contains a settlement header and the origin returns
     * a success status (< 400), settlement should be attempted via x402 middleware.
     */
    it('should call x402 middleware when status < 400 and settlement header present', async () => {
      const settlementData = 'base64-encoded-settlement-data-xyz123';

      // Mock middleware to return settled result
      const settledResponse = {
        status: '200',
        statusDescription: 'OK',
        headers: {
          'content-type': [{ key: 'Content-Type', value: 'application/json' }],
        },
      };
      setupMiddlewareMock({
        type: 'settled',
        response: settledResponse,
      });

      const event = createMockResponseEvent({
        uri: '/api/premium/data',
        status: 200,
        requestHeaders: {
          'x-x402-pending-settlement': settlementData,
          'x-amzn-waf-x-x402-route-action': '0.001',
          'x-amzn-waf-actor-type': 'verified-bot',
          'x-amzn-waf-bot-category': 'ai',
        },
      });

      const result = await handler(event);

      // Response should be returned
      const cfResponse = result as CloudFrontResponse;
      expect(cfResponse.status).toBe('200');

      // Middleware should be called
      expect(mockCreateX402Middleware).toHaveBeenCalledTimes(1);
      expect(mockProcessOriginResponse).toHaveBeenCalledTimes(1);

      // Verify middleware was constructed with correct config
      expect(mockCreateX402Middleware).toHaveBeenCalledWith(
        expect.objectContaining({
          facilitatorUrl: TESTNET_CONFIG.facilitatorUrl,
          network: TESTNET_CONFIG.network,
        }),
      );

      // Verify processOriginResponse was called with request and response
      const [reqArg] = mockProcessOriginResponse.mock.calls[0];
      expect(reqArg.uri).toBe('/api/premium/data');

      // Settlement header should be removed from response
      expect(cfResponse.headers['x-x402-pending-settlement']).toBeUndefined();
    });

    it('should settle for various success status codes', async () => {
      const successStatuses = [200, 201, 204, 301, 302, 304];

      for (const status of successStatuses) {
        resetCache();
        ssmMock.reset();
        setupTestnetSsmMock();
        mockCreateX402Middleware.mockReset();

        const settledResponse = {
          status: status.toString(),
          statusDescription: 'OK',
          headers: {
            'content-type': [{ key: 'Content-Type', value: 'application/json' }],
          },
        };
        setupMiddlewareMock({
          type: 'settled',
          response: settledResponse,
        });

        const event = createMockResponseEvent({
          uri: '/api/data',
          status,
          requestHeaders: {
            'x-x402-pending-settlement': 'settlement-data',
            'x-amzn-waf-x-x402-route-action': '0.001',
          },
        });

        const result = await handler(event);

        const cfResponse = result as CloudFrontResponse;
        expect(cfResponse.status).toBe(status.toString());
        expect(mockCreateX402Middleware).toHaveBeenCalledTimes(1);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Settlement header + error status (skip settlement)
  // -------------------------------------------------------------------------
  describe('Scenario: Settlement header + error status (skip settlement)', () => {
    /**
     * When the origin returns an error status (>= 400), settlement should
     * be skipped regardless of the settlement header.
     */
    it('should skip settlement when origin returns 400', async () => {
      const event = createMockResponseEvent({
        uri: '/api/premium/data',
        status: 400,
        requestHeaders: {
          'x-x402-pending-settlement': 'settlement-data',
          'x-amzn-waf-x-x402-route-action': '0.001',
        },
      });

      const result = await handler(event);

      // Response should be returned with original error status
      const cfResponse = result as CloudFrontResponse;
      expect(cfResponse.status).toBe('400');

      // Middleware should NOT be called
      expect(mockCreateX402Middleware).not.toHaveBeenCalled();

      // SSM should NOT be called (no settlement processing)
      expect(ssmMock.calls()).toHaveLength(0);

      // Settlement header should be removed from response
      expect(cfResponse.headers['x-x402-pending-settlement']).toBeUndefined();
    });

    it('should skip settlement for various error status codes', async () => {
      const errorStatuses = [400, 401, 403, 404, 500, 502, 503, 504];

      for (const status of errorStatuses) {
        mockCreateX402Middleware.mockReset();

        const event = createMockResponseEvent({
          uri: '/api/data',
          status,
          requestHeaders: {
            'x-x402-pending-settlement': 'settlement-data',
            'x-amzn-waf-x-x402-route-action': '0.001',
          },
        });

        const result = await handler(event);

        const cfResponse = result as CloudFrontResponse;
        expect(cfResponse.status).toBe(status.toString());
        expect(mockCreateX402Middleware).not.toHaveBeenCalled();
      }
    });

    it('should preserve original error response headers when skipping settlement', async () => {
      const event = createMockResponseEvent({
        uri: '/api/data',
        status: 500,
        requestHeaders: {
          'x-x402-pending-settlement': 'settlement-data',
        },
        responseHeaders: {
          'x-error-code': 'INTERNAL_ERROR',
          'retry-after': '30',
        },
      });

      const result = await handler(event);

      const cfResponse = result as CloudFrontResponse;
      expect(cfResponse.headers['x-error-code']).toBeDefined();
      expect(cfResponse.headers['retry-after']).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Settlement success
  // -------------------------------------------------------------------------
  describe('Scenario: Settlement success', () => {
    beforeEach(() => {
      setupTestnetSsmMock();
    });

    /**
     * When settlement succeeds, the origin response should be returned
     * and the settlement should be logged.
     */
    it('should return middleware response and log success on successful settlement', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const settledResponse = {
        status: '200',
        statusDescription: 'OK',
        headers: {
          'content-type': [{ key: 'Content-Type', value: 'application/json' }],
        },
      };
      setupMiddlewareMock({
        type: 'settled',
        response: settledResponse,
      });

      const event = createMockResponseEvent({
        uri: '/api/premium/data',
        status: 200,
        requestHeaders: {
          'x-x402-pending-settlement': 'settlement-data-xyz',
          'x-amzn-waf-x-x402-route-action': '0.005',
          'x-amzn-waf-actor-type': 'verified-bot',
          'x-amzn-waf-bot-category': 'ai',
        },
      });

      const result = await handler(event);

      // Response should be returned with original status
      const cfResponse = result as CloudFrontResponse;
      expect(cfResponse.status).toBe('200');

      // Verify structured log was emitted
      expect(consoleSpy).toHaveBeenCalled();
      const logCalls = consoleSpy.mock.calls;
      const settlementLog = logCalls.find((call) => {
        try {
          const parsed = JSON.parse(call[0] as string);
          return parsed.event === 'settlement' && parsed.result === 'success';
        } catch {
          return false;
        }
      });
      expect(settlementLog).toBeDefined();

      if (settlementLog) {
        const parsed = JSON.parse(settlementLog[0] as string);
        expect(parsed.path).toBe('/api/premium/data');
        expect(parsed.price).toBe('0.005');
        expect(parsed.network).toBe(TESTNET_CONFIG.network);
        expect(parsed.actorType).toBe('verified-bot');
        expect(parsed.botCategory).toBe('ai');
      }

      consoleSpy.mockRestore();
    });

    it('should extract client IP from x-forwarded-for header', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const settledResponse = {
        status: '200',
        statusDescription: 'OK',
        headers: {
          'content-type': [{ key: 'Content-Type', value: 'application/json' }],
        },
      };
      setupMiddlewareMock({
        type: 'settled',
        response: settledResponse,
      });

      const event = createMockResponseEvent({
        uri: '/api/data',
        status: 200,
        clientIp: '10.20.30.40',
        requestHeaders: {
          'x-x402-pending-settlement': 'settlement-data',
          'x-amzn-waf-x-x402-route-action': '0.001',
          'x-forwarded-for': '203.0.113.50, 10.0.0.1',
        },
      });

      await handler(event);

      // Verify client IP was extracted from x-forwarded-for
      const logCalls = consoleSpy.mock.calls;
      const settlementLog = logCalls.find((call) => {
        try {
          const parsed = JSON.parse(call[0] as string);
          return parsed.event === 'settlement';
        } catch {
          return false;
        }
      });

      if (settlementLog) {
        const parsed = JSON.parse(settlementLog[0] as string);
        expect(parsed.clientIp).toBe('203.0.113.50');
      }

      consoleSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 5: Settlement failure (log and return origin response)
  // -------------------------------------------------------------------------
  describe('Scenario: Settlement failure (log and return origin response)', () => {
    beforeEach(() => {
      setupTestnetSsmMock();
    });

    /**
     * When settlement fails, the origin response should be returned
     * unchanged and the failure should be logged.
     */
    it('should return origin response and log failure when middleware returns settlement-failed', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const errorMessage = 'Settlement transaction reverted';
      const failedResponse = {
        status: '200',
        statusDescription: 'OK',
        headers: {
          'content-type': [{ key: 'Content-Type', value: 'application/json' }],
        },
      };
      setupMiddlewareMock({
        type: 'settlement-failed',
        response: failedResponse,
        error: errorMessage,
      });

      const event = createMockResponseEvent({
        uri: '/api/premium/data',
        status: 200,
        requestHeaders: {
          'x-x402-pending-settlement': 'settlement-data',
          'x-amzn-waf-x-x402-route-action': '0.001',
          'x-amzn-waf-actor-type': 'wba-verified-bot',
        },
      });

      const result = await handler(event);

      // Response should be returned
      const cfResponse = result as CloudFrontResponse;
      expect(cfResponse.status).toBe('200');

      // Settlement header should be removed
      expect(cfResponse.headers['x-x402-pending-settlement']).toBeUndefined();

      // Verify failure was logged via console.error
      const logCalls = consoleErrorSpy.mock.calls;
      const failureLog = logCalls.find((call) => {
        try {
          const parsed = JSON.parse(call[0] as string);
          return parsed.event === 'settlement' && parsed.result === 'failure';
        } catch {
          return false;
        }
      });
      expect(failureLog).toBeDefined();

      if (failureLog) {
        const parsed = JSON.parse(failureLog[0] as string);
        expect(parsed.error).toBe(errorMessage);
        expect(parsed.path).toBe('/api/premium/data');
      }

      consoleErrorSpy.mockRestore();
    });

    it('should return origin response when middleware throws an exception', async () => {
      jest.spyOn(console, 'error').mockImplementation();

      setupMiddlewareMockThrow(new TypeError('fetch failed'));

      const event = createMockResponseEvent({
        uri: '/api/data',
        status: 200,
        requestHeaders: {
          'x-x402-pending-settlement': 'settlement-data',
          'x-amzn-waf-x-x402-route-action': '0.001',
        },
      });

      const result = await handler(event);

      // Response should still be returned (settlement failure is non-fatal)
      const cfResponse = result as CloudFrontResponse;
      expect(cfResponse.status).toBe('200');

      // Settlement header should be removed
      expect(cfResponse.headers['x-x402-pending-settlement']).toBeUndefined();

      jest.restoreAllMocks();
    });

    it('should return origin response when middleware throws a timeout error', async () => {
      jest.spyOn(console, 'error').mockImplementation();

      const timeoutError = new DOMException('The operation was aborted', 'TimeoutError');
      setupMiddlewareMockThrow(timeoutError);

      const event = createMockResponseEvent({
        uri: '/api/data',
        status: 200,
        requestHeaders: {
          'x-x402-pending-settlement': 'settlement-data',
          'x-amzn-waf-x-x402-route-action': '0.001',
        },
      });

      const result = await handler(event);

      // Response should still be returned
      const cfResponse = result as CloudFrontResponse;
      expect(cfResponse.status).toBe('200');

      jest.restoreAllMocks();
    });

    it('should handle various settlement error messages from middleware', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const errorMessages = [
        'Insufficient gas',
        'Transaction reverted',
        'Nonce too low',
        'Contract execution failed',
      ];

      for (const errorMessage of errorMessages) {
        resetCache();
        ssmMock.reset();
        setupTestnetSsmMock();
        mockCreateX402Middleware.mockReset();

        const failedResponse = {
          status: '200',
          statusDescription: 'OK',
          headers: {
            'content-type': [{ key: 'Content-Type', value: 'application/json' }],
          },
        };
        setupMiddlewareMock({
          type: 'settlement-failed',
          response: failedResponse,
          error: errorMessage,
        });

        const event = createMockResponseEvent({
          uri: '/api/data',
          status: 200,
          requestHeaders: {
            'x-x402-pending-settlement': 'settlement-data',
            'x-amzn-waf-x-x402-route-action': '0.001',
          },
        });

        const result = await handler(event);

        const cfResponse = result as CloudFrontResponse;
        expect(cfResponse.status).toBe('200');
      }

      consoleSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 6: Response header cleanup
  // -------------------------------------------------------------------------
  describe('Scenario: Response header cleanup', () => {
    beforeEach(() => {
      setupTestnetSsmMock();
    });

    /**
     * The x-x402-pending-settlement header must be removed from the response
     * in all scenarios.
     */
    it('should remove settlement header from response in all scenarios', async () => {
      // Scenario A: No settlement (passthrough)
      const eventA = createMockResponseEvent({
        status: 200,
        requestHeaders: {},
        responseHeaders: { 'x-x402-pending-settlement': 'leaked' },
      });
      const resultA = await handler(eventA);
      expect((resultA as CloudFrontResponse).headers['x-x402-pending-settlement']).toBeUndefined();

      // Scenario B: Settlement + success
      resetCache();
      ssmMock.reset();
      setupTestnetSsmMock();
      mockCreateX402Middleware.mockReset();

      const settledResponse = {
        status: '200',
        statusDescription: 'OK',
        headers: {
          'content-type': [{ key: 'Content-Type', value: 'application/json' }],
        },
      };
      setupMiddlewareMock({
        type: 'settled',
        response: settledResponse,
      });

      const eventB = createMockResponseEvent({
        status: 200,
        requestHeaders: { 'x-x402-pending-settlement': 'data' },
        responseHeaders: { 'x-x402-pending-settlement': 'leaked' },
      });
      const resultB = await handler(eventB);
      expect((resultB as CloudFrontResponse).headers['x-x402-pending-settlement']).toBeUndefined();

      // Scenario C: Settlement + error status (skip)
      const eventC = createMockResponseEvent({
        status: 500,
        requestHeaders: { 'x-x402-pending-settlement': 'data' },
        responseHeaders: { 'x-x402-pending-settlement': 'leaked' },
      });
      const resultC = await handler(eventC);
      expect((resultC as CloudFrontResponse).headers['x-x402-pending-settlement']).toBeUndefined();
    });
  });
});

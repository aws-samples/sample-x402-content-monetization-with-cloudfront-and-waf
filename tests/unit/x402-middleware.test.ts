/**
 * Unit tests for the x402 middleware factory.
 *
 * Tests verify that createX402Middleware correctly handles:
 * - processOriginRequest: no-payment-required, payment-verified, payment-error
 * - processOriginResponse: no pending header, error status skip, successful settlement,
 *   failed settlement, malformed base64 handling
 *
 */

import type { CloudFrontRequest, CloudFrontResultResponse } from 'aws-lambda';
import type { RoutesConfig } from '@x402/core/server';
import type { Network } from '@x402/core/types';
import type { X402ServerConfig } from '../../src/runtime/shared/x402-server';

// ---------------------------------------------------------------------------
// Mock spies
// ---------------------------------------------------------------------------

const mockProcessHTTPRequest = jest.fn();
const mockProcessSettlement = jest.fn();
const mockInitialize = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/runtime/shared/x402-server', () => ({
  createX402Server: jest.fn().mockImplementation(() =>
    Promise.resolve({
      processHTTPRequest: mockProcessHTTPRequest,
      processSettlement: mockProcessSettlement,
      initialize: mockInitialize,
    }),
  ),
}));

// Import after mocks
import { createX402Middleware } from '../../src/runtime/shared/x402-middleware';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_NETWORK: Network = 'eip155:84532' as Network;
const TEST_FACILITATOR_URL = 'https://x402.org/facilitator';
const TEST_ROUTES: RoutesConfig = {
  'GET /*': {
    accepts: {
      scheme: 'exact',
      payTo: '0xTestAddress',
      price: 0.001,
      network: TEST_NETWORK,
    },
  },
} as unknown as RoutesConfig;

const TEST_CONFIG: X402ServerConfig = {
  facilitatorUrl: TEST_FACILITATOR_URL,
  network: TEST_NETWORK as string,
  routes: TEST_ROUTES,
};

const DISTRIBUTION_DOMAIN = 'example.cloudfront.net';

function makeRequest(overrides: Partial<CloudFrontRequest> = {}): CloudFrontRequest {
  return {
    clientIp: '1.2.3.4',
    method: 'GET',
    uri: '/api/data',
    querystring: '',
    headers: {},
    ...overrides,
  } as CloudFrontRequest;
}

function makeResponse(
  status: string = '200',
  headers: CloudFrontResultResponse['headers'] = {},
): CloudFrontResultResponse {
  return {
    status,
    statusDescription: status === '200' ? 'OK' : 'Error',
    headers,
  };
}

function encodePendingSettlement(payload: unknown, requirements: unknown): string {
  return Buffer.from(JSON.stringify({ payload, requirements })).toString('base64');
}

// ---------------------------------------------------------------------------
// Tests: processOriginRequest
// ---------------------------------------------------------------------------

describe('createX402Middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('processOriginRequest', () => {
    it('should strip the pending settlement header from the request', async () => {
      mockProcessHTTPRequest.mockResolvedValueOnce({ type: 'no-payment-required' });

      const request = makeRequest({
        headers: {
          'x-x402-pending-settlement': [
            { key: 'x-x402-pending-settlement', value: 'injected-value' },
          ],
        },
      });

      const middleware = createX402Middleware(TEST_CONFIG);
      await middleware.processOriginRequest(request, DISTRIBUTION_DOMAIN);

      expect(request.headers['x-x402-pending-settlement']).toBeUndefined();
    });

    it('should return pass-through for no-payment-required result', async () => {
      mockProcessHTTPRequest.mockResolvedValueOnce({ type: 'no-payment-required' });

      const middleware = createX402Middleware(TEST_CONFIG);
      const result = await middleware.processOriginRequest(
        makeRequest(),
        DISTRIBUTION_DOMAIN,
      );

      expect(result.type).toBe('pass-through');
      expect(result.response).toBeUndefined();
      expect(result.paymentPayload).toBeUndefined();
      expect(result.paymentRequirements).toBeUndefined();
    });

    it('should attach pending settlement header for payment-verified result', async () => {
      const mockPayload = { signature: '0xabc', payload: { amount: '1000' } };
      const mockRequirements = { scheme: 'exact', network: 'eip155:84532' };

      mockProcessHTTPRequest.mockResolvedValueOnce({
        type: 'payment-verified',
        paymentPayload: mockPayload,
        paymentRequirements: mockRequirements,
      });

      const request = makeRequest();
      const middleware = createX402Middleware(TEST_CONFIG);
      const result = await middleware.processOriginRequest(
        request,
        DISTRIBUTION_DOMAIN,
      );

      expect(result.type).toBe('pass-through');
      expect(result.paymentPayload).toEqual(mockPayload);
      expect(result.paymentRequirements).toEqual(mockRequirements);

      // Verify the pending settlement header was attached with base64-encoded data
      const headerValue = request.headers['x-x402-pending-settlement']?.[0]?.value;
      expect(headerValue).toBeDefined();

      const decoded = JSON.parse(Buffer.from(headerValue!, 'base64').toString('utf-8'));
      expect(decoded.payload).toEqual(mockPayload);
      expect(decoded.requirements).toEqual(mockRequirements);
    });

    it('should return payment-error with response instructions', async () => {
      const mockResponse = {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
        body: { error: 'Payment required' },
      };

      mockProcessHTTPRequest.mockResolvedValueOnce({
        type: 'payment-error',
        response: mockResponse,
      });

      const middleware = createX402Middleware(TEST_CONFIG);
      const result = await middleware.processOriginRequest(
        makeRequest(),
        DISTRIBUTION_DOMAIN,
      );

      expect(result.type).toBe('payment-error');
      expect(result.response).toEqual(mockResponse);
    });

    it('should create CloudFrontHTTPAdapter with correct domain', async () => {
      mockProcessHTTPRequest.mockResolvedValueOnce({ type: 'no-payment-required' });

      const middleware = createX402Middleware(TEST_CONFIG);
      await middleware.processOriginRequest(
        makeRequest(),
        DISTRIBUTION_DOMAIN,
      );

      // Verify processHTTPRequest was called with a context containing the correct path/method
      expect(mockProcessHTTPRequest).toHaveBeenCalledTimes(1);
      const context = mockProcessHTTPRequest.mock.calls[0][0];
      expect(context.path).toBe('/api/data');
      expect(context.method).toBe('GET');
    });
  });

  // -------------------------------------------------------------------------
  // Tests: processOriginResponse
  // -------------------------------------------------------------------------

  describe('processOriginResponse', () => {
    it('should pass through when no pending settlement header is present', async () => {
      const request = makeRequest();
      const response = makeResponse('200');

      const middleware = createX402Middleware(TEST_CONFIG);
      const result = await middleware.processOriginResponse(request, response);

      expect(result.type).toBe('pass-through');
      expect(result.response).toBe(response);
      expect(mockProcessSettlement).not.toHaveBeenCalled();
    });

    it('should skip settlement when origin status >= 400', async () => {
      const pendingData = encodePendingSettlement(
        { signature: '0xabc' },
        { scheme: 'exact' },
      );
      const request = makeRequest({
        headers: {
          'x-x402-pending-settlement': [
            { key: 'x-x402-pending-settlement', value: pendingData },
          ],
        },
      });
      const response = makeResponse('500');

      const middleware = createX402Middleware(TEST_CONFIG);
      const result = await middleware.processOriginResponse(request, response);

      expect(result.type).toBe('pass-through');
      expect(result.response).toBe(response);
      expect(mockProcessSettlement).not.toHaveBeenCalled();
    });

    it('should skip settlement when origin status is 404', async () => {
      const pendingData = encodePendingSettlement(
        { signature: '0xabc' },
        { scheme: 'exact' },
      );
      const request = makeRequest({
        headers: {
          'x-x402-pending-settlement': [
            { key: 'x-x402-pending-settlement', value: pendingData },
          ],
        },
      });
      const response = makeResponse('404');

      const middleware = createX402Middleware(TEST_CONFIG);
      const result = await middleware.processOriginResponse(request, response);

      expect(result.type).toBe('pass-through');
      expect(result.response).toBe(response);
      expect(mockProcessSettlement).not.toHaveBeenCalled();
    });

    it('should add settlement headers on successful settlement', async () => {
      const payload = { signature: '0xabc', payload: { amount: '1000' } };
      const requirements = { scheme: 'exact', network: 'eip155:84532' };
      const pendingData = encodePendingSettlement(payload, requirements);

      const request = makeRequest({
        headers: {
          'x-x402-pending-settlement': [
            { key: 'x-x402-pending-settlement', value: pendingData },
          ],
        },
      });
      const response = makeResponse('200');

      mockProcessSettlement.mockResolvedValueOnce({
        success: true,
        headers: {
          'X-Payment-Receipt': 'receipt-value',
          'X-Transaction-Hash': '0xdef',
        },
      });

      const middleware = createX402Middleware(TEST_CONFIG);
      const result = await middleware.processOriginResponse(request, response);

      expect(result.type).toBe('settled');
      expect(result.response.headers?.['x-payment-receipt']).toEqual([
        { key: 'X-Payment-Receipt', value: 'receipt-value' },
      ]);
      expect(result.response.headers?.['x-transaction-hash']).toEqual([
        { key: 'X-Transaction-Hash', value: '0xdef' },
      ]);

      // Verify processSettlement was called with decoded payload and requirements
      expect(mockProcessSettlement).toHaveBeenCalledWith(payload, requirements);
    });

    it('should return settlement-failed on failed settlement', async () => {
      const payload = { signature: '0xabc' };
      const requirements = { scheme: 'exact' };
      const pendingData = encodePendingSettlement(payload, requirements);

      const request = makeRequest({
        headers: {
          'x-x402-pending-settlement': [
            { key: 'x-x402-pending-settlement', value: pendingData },
          ],
        },
      });
      const response = makeResponse('200');

      mockProcessSettlement.mockResolvedValueOnce({
        success: false,
        errorReason: 'Insufficient funds for settlement',
      });

      const middleware = createX402Middleware(TEST_CONFIG);
      const result = await middleware.processOriginResponse(request, response);

      expect(result.type).toBe('settlement-failed');
      expect(result.error).toBe('Insufficient funds for settlement');
    });

    it('should throw on malformed base64 in pending settlement header', async () => {
      const request = makeRequest({
        headers: {
          'x-x402-pending-settlement': [
            { key: 'x-x402-pending-settlement', value: '!!!not-valid-base64!!!' },
          ],
        },
      });
      const response = makeResponse('200');

      const middleware = createX402Middleware(TEST_CONFIG);

      // The middleware does a JSON.parse on the decoded base64 — malformed data will throw
      await expect(
        middleware.processOriginResponse(request, response),
      ).rejects.toThrow();
    });
  });
});

/**
 * Unit tests for the toLambdaResponse helper function.
 *
 * Tests that HTTPResponseInstructions are correctly converted into
 * CloudFront Lambda@Edge result response format, including header
 * conversion, body serialization, PAYMENT-REQUIRED decoding, and
 * cache-control defaults.
 *
 */

import { toLambdaResponse } from '../../src/runtime/shared/to-lambda-response';

jest.mock('@x402/core/http', () => ({
  decodePaymentRequiredHeader: jest.fn((encoded: string) => ({
    decoded: true,
    original: encoded,
    paymentRequirements: { amount: '1000', token: 'USDC' },
  })),
}));

import { decodePaymentRequiredHeader } from '@x402/core/http';

const mockedDecode = decodePaymentRequiredHeader as jest.MockedFunction<typeof decodePaymentRequiredHeader>;

describe('toLambdaResponse', () => {
  beforeEach(() => {
    mockedDecode.mockClear();
  });

  // -------------------------------------------------------------------------
  // Basic conversion: status, headers, body
  // -------------------------------------------------------------------------

  describe('basic conversion', () => {
    it('should convert status to string', () => {
      const result = toLambdaResponse({
        status: 200,
        headers: {},
        body: { ok: true },
      });

      expect(result.status).toBe('200');
    });

    it('should set statusDescription to "Payment Required" for 402', () => {
      const result = toLambdaResponse({
        status: 402,
        headers: {},
      });

      expect(result.statusDescription).toBe('Payment Required');
    });

    it('should set statusDescription to "Error" for non-402 status', () => {
      const result = toLambdaResponse({
        status: 500,
        headers: {},
      });

      expect(result.statusDescription).toBe('Error');
    });

    it('should convert headers to CloudFront multi-value format with lowercase keys', () => {
      const result = toLambdaResponse({
        status: 200,
        headers: {
          'X-Custom': 'value1',
          'Content-Type': 'text/plain',
        },
        body: 'hello',
      });

      expect(result.headers!['x-custom']).toEqual([{ key: 'X-Custom', value: 'value1' }]);
      expect(result.headers!['content-type']).toEqual([{ key: 'Content-Type', value: 'text/plain' }]);
    });

    it('should JSON-serialize object body', () => {
      const result = toLambdaResponse({
        status: 200,
        headers: {},
        body: { message: 'hello' },
      });

      expect(result.body).toBe(JSON.stringify({ message: 'hello' }));
    });
  });

  // -------------------------------------------------------------------------
  // 402 response with PAYMENT-REQUIRED header decoding
  // -------------------------------------------------------------------------

  describe('PAYMENT-REQUIRED header decoding', () => {
    it('should decode PAYMENT-REQUIRED header and use as body', () => {
      const encodedHeader = 'base64-encoded-payment-data';
      const result = toLambdaResponse({
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodedHeader },
      });

      expect(mockedDecode).toHaveBeenCalledWith(encodedHeader);
      const parsed = JSON.parse(result.body!);
      expect(parsed.decoded).toBe(true);
      expect(parsed.original).toBe(encodedHeader);
    });

    it('should set content-type to application/json when PAYMENT-REQUIRED is present', () => {
      const result = toLambdaResponse({
        status: 402,
        headers: { 'PAYMENT-REQUIRED': 'some-encoded-value' },
      });

      expect(result.headers!['content-type']).toEqual([
        { key: 'Content-Type', value: 'application/json' },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // cache-control header
  // -------------------------------------------------------------------------

  describe('cache-control header', () => {
    it('should add cache-control: no-store when not present', () => {
      const result = toLambdaResponse({
        status: 402,
        headers: {},
      });

      expect(result.headers!['cache-control']).toEqual([
        { key: 'Cache-Control', value: 'no-store' },
      ]);
    });

    it('should preserve existing cache-control header', () => {
      const result = toLambdaResponse({
        status: 200,
        headers: { 'Cache-Control': 'max-age=3600' },
        body: 'ok',
      });

      expect(result.headers!['cache-control']).toEqual([
        { key: 'Cache-Control', value: 'max-age=3600' },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Empty body handling
  // -------------------------------------------------------------------------

  describe('empty body handling', () => {
    it('should return empty string when body is undefined', () => {
      const result = toLambdaResponse({
        status: 204,
        headers: {},
      });

      expect(result.body).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // String body passthrough
  // -------------------------------------------------------------------------

  describe('string body passthrough', () => {
    it('should pass through string body without JSON serialization', () => {
      const result = toLambdaResponse({
        status: 200,
        headers: {},
        body: 'plain text response',
      });

      expect(result.body).toBe('plain text response');
    });
  });
});

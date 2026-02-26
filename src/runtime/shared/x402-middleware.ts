/**
 * x402 Middleware Factory
 *
 * Creates x402 middleware functions for Lambda@Edge, following the upstream
 * cloudfront-lambda-edge example pattern. The server instance is cached
 * per Lambda container so initialize() only runs once.
 *
 * @see https://github.com/coinbase/x402/tree/main/examples/typescript/servers/cloudfront-lambda-edge
 */

import type { CloudFrontRequest, CloudFrontResultResponse } from 'aws-lambda';
import type { x402HTTPResourceServer, HTTPResponseInstructions } from '@x402/core/server';
import { CloudFrontHTTPAdapter } from './cloudfront-http-adapter';
import { createX402Server, type X402ServerConfig } from './x402-server';
import { removeHeader, attachHeader } from './cloudfront-adapter';
import {
  Headers,
  RequestResultType,
  ResponseResultType,
  HttpStatus,
} from './constants';

export interface OriginRequestResult {
  type: typeof RequestResultType.PASS_THROUGH | typeof RequestResultType.PAYMENT_ERROR;
  response?: HTTPResponseInstructions;
  paymentPayload?: unknown;
  paymentRequirements?: unknown;
}

export interface OriginResponseResult {
  type: typeof ResponseResultType.PASS_THROUGH | typeof ResponseResultType.SETTLED | typeof ResponseResultType.SETTLEMENT_FAILED;
  response: CloudFrontResultResponse;
  error?: string;
  transactionHash?: string | null;
}

export function createX402Middleware(config: X402ServerConfig) {
  // Cache the server promise so initialize() runs once per Lambda container
  let serverPromise: Promise<x402HTTPResourceServer> | null = null;

  const getServer = async (): Promise<x402HTTPResourceServer> => {
    if (!serverPromise) {
      serverPromise = createX402Server(config);
    }
    return serverPromise;
  };

  return {
    async processOriginRequest(
      request: CloudFrontRequest,
      distributionDomain: string,
    ): Promise<OriginRequestResult> {
      // Strip pending settlement header for security
      removeHeader(request, Headers.PENDING_SETTLEMENT);

      const server = await getServer();
      const adapter = new CloudFrontHTTPAdapter(request, distributionDomain);
      const context = {
        adapter,
        path: adapter.getPath(),
        method: adapter.getMethod(),
        paymentHeader: adapter.getHeader(Headers.PAYMENT_SIGNATURE),
      };

      const result = await server.processHTTPRequest(context);

      switch (result.type) {
        case 'no-payment-required':
          return { type: RequestResultType.PASS_THROUGH };

        case 'payment-verified': {
          const pendingData = JSON.stringify({
            payload: result.paymentPayload,
            requirements: result.paymentRequirements,
          });
          const encoded = Buffer.from(pendingData).toString('base64');
          attachHeader(request, Headers.PENDING_SETTLEMENT, encoded);
          return {
            type: RequestResultType.PASS_THROUGH,
            paymentPayload: result.paymentPayload,
            paymentRequirements: result.paymentRequirements,
          };
        }

        case 'payment-error':
          return {
            type: RequestResultType.PAYMENT_ERROR,
            response: result.response,
          };
      }
    },

    async processOriginResponse(
      request: CloudFrontRequest,
      response: CloudFrontResultResponse,
    ): Promise<OriginResponseResult> {
      // Read pending settlement header from request
      const pendingHeader =
        request.headers[Headers.PENDING_SETTLEMENT]?.[0]?.value;

      // If absent: return response unchanged
      if (!pendingHeader) {
        return { type: ResponseResultType.PASS_THROUGH, response };
      }

      // If origin status >= 400: skip settlement
      const statusCode = parseInt(response.status, 10);
      if (statusCode >= HttpStatus.ERROR_THRESHOLD) {
        return { type: ResponseResultType.PASS_THROUGH, response };
      }

      // Decode base64 JSON pending settlement data
      const decoded = JSON.parse(
        Buffer.from(pendingHeader, 'base64').toString('utf-8'),
      );

      // Settle payment
      const server = await getServer();
      const settleResult = await server.processSettlement(
        decoded.payload,
        decoded.requirements,
      );

      if (settleResult.success) {
        // Add settlement headers to response
        if (!response.headers) {
          response.headers = {};
        }
        for (const [key, value] of Object.entries(settleResult.headers)) {
          response.headers[key.toLowerCase()] = [{ key, value }];
        }
        // Extract transaction hash from settlement response headers
        const transactionHash = settleResult.headers[Headers.PAYMENT_RESPONSE]
          ? (() => {
              try {
                const parsed = JSON.parse(settleResult.headers[Headers.PAYMENT_RESPONSE]);
                return parsed.transaction ?? parsed.transactionHash ?? null;
              } catch {
                return null;
              }
            })()
          : null;
        return { type: ResponseResultType.SETTLED, response, transactionHash };
      }

      // Settlement failed — return error details
      return {
        type: ResponseResultType.SETTLEMENT_FAILED,
        response,
        error: settleResult.errorReason,
      };
    },
  };
}

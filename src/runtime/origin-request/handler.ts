/**
 * Origin Request Lambda@Edge Handler
 *
 * Entry point for the CloudFront origin-request trigger. This handler:
 * 1. Reads the WAF-injected `x-x402-route-action` header
 * 2. If header absent or value is "0" → passes through to origin (no payment required)
 * 3. If header contains a valid price → proceeds to payment flow:
 *    - Load EdgeConfig via config loader (PayTo, Network)
 *    - Construct a dynamic RoutesConfig from WAF price + SSM config
 *    - Delegate to x402 middleware for payment verification
 *    - On pass-through → forward request to origin
 *    - On payment-error → return 402 via toLambdaResponse
 * 4. Log verification event via structured logger
 *
 */

import type {
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
} from 'aws-lambda';
import type { RoutesConfig } from '@x402/core/server';
import type { Network } from '@x402/core/types';
import { extractRequest, removeHeader } from '../shared/cloudfront-adapter';
import { getEdgeConfig } from '../shared/config-loader';
import { createCdpFacilitatorConfig } from '../shared/cdp-auth';
import { emitVerification, emitPaymentRequested, emitPassthrough } from '../shared/logger';
import type { LogContext } from '../shared/logger';
import { createX402Middleware } from '../shared/x402-middleware';
import { toLambdaResponse } from '../shared/to-lambda-response';
import { Headers, RouteDefaults } from '../shared/constants';

/**
 * Extract client IP from CloudFront request headers.
 */
function extractClientIp(headers: Record<string, string>): string {
  const forwardedFor = headers[Headers.FORWARDED_FOR];
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }
  return RouteDefaults.UNKNOWN_CLIENT;
}

/**
 * Origin Request Lambda@Edge handler.
 *
 * WAF is the single source of truth for route resolution — this handler only
 * reads the WAF-injected price header and drives the payment flow via the
 * x402 middleware (following the upstream cloudfront-lambda-edge pattern).
 *
 */
export const handler = async (
  event: CloudFrontRequestEvent,
): Promise<CloudFrontRequestResult> => {
  const request = event.Records[0].cf.request;
  const parsedRequest = extractRequest(event);
  const routeActionHeader = parsedRequest.routeActionHeader;

  // Security: Always strip client-supplied pending settlement header
  removeHeader(request, Headers.PENDING_SETTLEMENT);

  // If header is absent or "0" → pass through (no payment required)
  if (!routeActionHeader || routeActionHeader === RouteDefaults.FREE_PRICE) {
    emitPassthrough(parsedRequest.path, extractClientIp(parsedRequest.headers), parsedRequest.botHeaders);
    return request;
  }

  // Validate that the route action header contains a valid price
  const price = parseFloat(routeActionHeader);
  if (isNaN(price) || price < 0 || price > Number.MAX_SAFE_INTEGER) {
    console.warn(
      `Invalid ${Headers.WAF_ROUTE_ACTION} header value: ${routeActionHeader}. Passing through to origin.`,
    );
    return request;
  }

  // Load EdgeConfig from SSM Parameter Store (with TTL caching)
  const edgeConfig = await getEdgeConfig();

  // Construct dynamic RoutesConfig from WAF price + SSM config
  const routes: RoutesConfig = {
    [RouteDefaults.CATCH_ALL_PATTERN]: {
      accepts: {
        scheme: 'exact',
        payTo: edgeConfig.payTo,
        price: parseFloat(routeActionHeader),
        network: edgeConfig.network as Network,
      },
    },
  };

  // Create middleware following upstream pattern — config at construction,
  // server instance cached per Lambda container via serverPromise.
  // Routes are dynamic (WAF price varies per request), so middleware is
  // constructed per-request, but the facilitator handshake is cached.
  const middleware = createX402Middleware({
    facilitatorUrl: edgeConfig.facilitatorUrl,
    network: edgeConfig.network,
    routes,
    facilitatorConfig: edgeConfig.cdpCredentials
      ? createCdpFacilitatorConfig(edgeConfig.cdpCredentials.apiKeyName, edgeConfig.cdpCredentials.apiKeyPrivateKey)
      : undefined,
  });

  const logCtx: LogContext = {
    path: parsedRequest.path,
    price: routeActionHeader,
    clientIp: extractClientIp(parsedRequest.headers),
    botHeaders: parsedRequest.botHeaders,
    network: edgeConfig.network,
  };

  // Delegate to x402 middleware for payment verification
  const result = await middleware.processOriginRequest(
    request,
    parsedRequest.host,
  );

  const paymentVerified =
    result.type === 'pass-through' && result.paymentPayload !== undefined;
  const isPaymentError = result.type === 'payment-error';
  const hasPaymentHeader = !!parsedRequest.paymentHeader;

  if (isPaymentError && !hasPaymentHeader) {
    emitPaymentRequested(logCtx);
  }

  if (isPaymentError && hasPaymentHeader) {
    emitVerification(logCtx, 'failure', 'Payment verification rejected by facilitator');
  }

  if (paymentVerified) {
    emitVerification(logCtx, 'success', null);
  }

  // On payment-error → return 402 response
  if (result.type === 'payment-error') {
    return toLambdaResponse(result.response!);
  }

  // Pass through to origin
  return request;
};

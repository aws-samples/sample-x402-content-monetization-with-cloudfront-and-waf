/**
 * Origin Response Lambda@Edge Handler
 *
 * Entry point for the CloudFront origin-response trigger. This handler:
 * 1. Checks for `x-x402-pending-settlement` header in the request
 * 2. Removes the settlement header from the response (client-facing cleanup)
 * 3. If not present → passes through response unchanged
 * 4. If present + origin status >= 400 → skips settlement, logs failure
 * 5. If present + origin status < 400 → delegates to x402 middleware for settlement
 * 6. Logs settlement result via structured logger
 *
 */

import type {
  CloudFrontResponseEvent,
  CloudFrontResponseResult,
  CloudFrontHeaders,
} from 'aws-lambda';
import { removeResponseHeader } from '../shared/cloudfront-adapter';
import { getEdgeConfig } from '../shared/config-loader';
import { createCdpFacilitatorConfig } from '../shared/cdp-auth';
import { emitSettlement } from '../shared/logger';
import type { LogContext } from '../shared/logger';
import { createX402Middleware } from '../shared/x402-middleware';
import { buildExactRoutesConfig } from '../shared/payment-config';
import {
  Headers,
  RouteDefaults,
  HttpStatus,
  ResponseResultType,
} from '../shared/constants';

/**
 * Extract the value of a header from CloudFront request headers.
 *
 * @param headers - CloudFront request headers (multi-value format)
 * @param key - Header name (will be lowercased for lookup)
 * @returns Header value or undefined if not present
 */
function getRequestHeader(
  headers: CloudFrontHeaders,
  key: string,
): string | undefined {
  const lowerKey = key.toLowerCase();
  const values = headers[lowerKey];
  if (values && values.length > 0) {
    return values[0].value;
  }
  return undefined;
}

/**
 * Extract bot headers from CloudFront request headers.
 * Bot headers are those matching the `x-amzn-waf-*` pattern.
 *
 * @param headers - CloudFront request headers (multi-value format)
 * @returns Map of bot header keys to values
 */
function extractBotHeaders(
  headers: CloudFrontHeaders,
): Record<string, string> {
  const botHeaders: Record<string, string> = {};
  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase().startsWith(Headers.WAF_PREFIX) && values && values.length > 0) {
      botHeaders[key.toLowerCase()] = values[0].value;
    }
  }
  return botHeaders;
}

/**
 * Extract client IP from CloudFront request headers.
 * CloudFront adds the client IP in the x-forwarded-for header.
 *
 * @param headers - CloudFront request headers (multi-value format)
 * @returns Client IP address or "[unknown]" if not available
 */
function extractClientIp(
  headers: CloudFrontHeaders,
): string {
  const forwardedFor = getRequestHeader(headers, Headers.FORWARDED_FOR);
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }
  return RouteDefaults.UNKNOWN_CLIENT;
}

/**
 * Extract the price from the WAF-injected route action header.
 *
 * @param headers - CloudFront request headers (multi-value format)
 * @returns Price string or "0" if not available
 */
function extractPrice(
  headers: CloudFrontHeaders,
): string {
  const routeAction = getRequestHeader(headers, Headers.WAF_ROUTE_ACTION);
  return routeAction ?? RouteDefaults.FREE_PRICE;
}

/**
 * Origin Response Lambda@Edge handler.
 *
 * Processes CloudFront origin responses to settle payments when the origin
 * returns a successful response. Settlement is only attempted when:
 * - The request contains an `x-x402-pending-settlement` header (set by origin-request)
 * - The origin response status code is less than 400
 *
 * Uses the x402 middleware for settlement instead of direct facilitator calls.
 * The `x-x402-pending-settlement` header is always removed from the response
 * before returning to the client, regardless of settlement outcome.
 *
 * @param event - CloudFront origin-response event
 * @returns CloudFront response (with settlement header removed)
 *
 */
export const handler = async (
  event: CloudFrontResponseEvent,
): Promise<CloudFrontResponseResult> => {
  const response = event.Records[0].cf.response;
  const request = event.Records[0].cf.request;

  // Step 1: Check for x-x402-pending-settlement header in the REQUEST
  const settlementData = getRequestHeader(request.headers, Headers.PENDING_SETTLEMENT);

  // Step 2: Always remove the settlement header from the RESPONSE before returning to client
  removeResponseHeader(response, Headers.PENDING_SETTLEMENT);

  // Step 3: If no settlement header in request → pass through response unchanged
  if (!settlementData) {
    return response;
  }

  // Step 4: Check origin response status code
  const statusCode = parseInt(response.status, 10);

  const logCtx: LogContext = {
    path: request.uri,
    price: extractPrice(request.headers),
    clientIp: extractClientIp(request.headers),
    botHeaders: extractBotHeaders(request.headers),
    network: '',
  };

  // Step 5: If origin status >= 400 → skip settlement, return error response
  if (statusCode >= HttpStatus.ERROR_THRESHOLD) {
    emitSettlement(logCtx, 'failure', { error: `Settlement skipped: origin returned status ${statusCode}` });
    return response;
  }

  // Step 6: Origin status < 400 → delegate to x402 middleware for settlement
  try {
    const edgeConfig = await getEdgeConfig();

    const routes = buildExactRoutesConfig(
      logCtx.price,
      edgeConfig.payTo,
      edgeConfig.network,
    );

    const middleware = createX402Middleware({
      facilitatorUrl: edgeConfig.facilitatorUrl,
      network: edgeConfig.network,
      routes,
      facilitatorConfig: edgeConfig.cdpCredentials
        ? createCdpFacilitatorConfig(edgeConfig.cdpCredentials.apiKeyName, edgeConfig.cdpCredentials.apiKeyPrivateKey)
        : undefined,
    });
    const settleResult = await middleware.processOriginResponse(request, response);

    logCtx.network = edgeConfig.network;

    switch (settleResult.type) {
      case ResponseResultType.SETTLED:
        emitSettlement(logCtx, 'success', { transactionHash: settleResult.transactionHash });
        break;
      case ResponseResultType.SETTLEMENT_FAILED:
        emitSettlement(logCtx, 'failure', { error: settleResult.error ?? 'Settlement failed' });
        break;
      case ResponseResultType.PASS_THROUGH:
        break;
    }

    return settleResult.response;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    emitSettlement(logCtx, 'failure', { error: `Settlement error: ${errorMessage}` });
  }

  // Return the origin response (with settlement header already removed)
  return response;
};

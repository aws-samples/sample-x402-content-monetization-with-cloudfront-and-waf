/**
 * CloudFront HTTP Adapter
 *
 * Translates between CloudFront event objects and the internal HTTP interface.
 * Provides functions to extract parsed requests from CloudFront events
 * and manipulate headers on requests and responses.
 *
 */

import type {
  CloudFrontRequest,
  CloudFrontResultResponse,
  CloudFrontRequestEvent,
} from 'aws-lambda';
import type { ParsedRequest } from './types';
import { Headers } from './constants';

/**
 * Extract a ParsedRequest from a CloudFront origin-request event.
 *
 * Parses the CloudFront event to produce a clean internal representation
 * including the request path, host, flattened headers, payment header
 * (X-PAYMENT or X-PAYMENT-SIGNATURE), WAF-injected route action header,
 * and all WAF bot headers (x-amzn-waf-*).
 *
 * @param event - CloudFront origin-request event
 * @returns Parsed request with extracted fields
 *
 */
export function extractRequest(event: CloudFrontRequestEvent): ParsedRequest {
  const request = event.Records[0].cf.request;
  const cfHeaders = request.headers;

  // Flatten CloudFront headers (multi-value) into a simple Record<string, string>
  // CloudFront headers are keyed by lowercase header name, each value is an array
  // of { key, value } objects. We take the first value for each header.
  const headers: Record<string, string> = {};
  for (const [key, values] of Object.entries(cfHeaders)) {
    if (values && values.length > 0) {
      headers[key.toLowerCase()] = values[0].value;
    }
  }

  // Extract the host header
  const host = headers[Headers.HOST] ?? '';

  // Extract payment header: X-PAYMENT (v1) or PAYMENT-SIGNATURE (v2) (case-insensitive)
  const paymentHeader =
    headers[Headers.X_PAYMENT] ?? headers[Headers.PAYMENT_SIGNATURE] ?? undefined;

  // Extract WAF-injected route action header.
  // WAF auto-prefixes headers inserted via Count action InsertHeaders with
  // "x-amzn-waf-", so the actual header arriving at Lambda@Edge is the
  // prefixed version. We read ONLY the prefixed name — the guard rule in
  // WAF blocks any request that arrives with the raw unprefixed header.
  const routeActionHeader = headers[Headers.WAF_ROUTE_ACTION] ?? undefined;

  // Extract all WAF bot headers (x-amzn-waf-*)
  const botHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith(Headers.WAF_PREFIX)) {
      botHeaders[key] = value;
    }
  }

  return {
    path: request.uri,
    host,
    headers,
    paymentHeader,
    routeActionHeader,
    botHeaders,
  };
}

/**
 * Attach a header to a CloudFront request.
 *
 * Adds or replaces a header on the CloudFront request object.
 * Header keys are stored in lowercase as per CloudFront convention.
 *
 * @param request - CloudFront request object to modify
 * @param key - Header name (will be lowercased for storage)
 * @param value - Header value
 *
 */
export function attachHeader(
  request: CloudFrontRequest,
  key: string,
  value: string,
): void {
  const lowerKey = key.toLowerCase();
  request.headers[lowerKey] = [{ key, value }];
}

/**
 * Remove a header from a CloudFront request.
 *
 * Deletes a header from the CloudFront request object by its
 * lowercase key name.
 *
 * @param request - CloudFront request object to modify
 * @param key - Header name to remove (will be lowercased for lookup)
 *
 */
export function removeHeader(request: CloudFrontRequest, key: string): void {
  const lowerKey = key.toLowerCase();
  delete request.headers[lowerKey];
}

/**
 * Remove a header from a CloudFront result response.
 *
 * Deletes a header from the CloudFront response object by its
 * lowercase key name. Used to strip internal headers (like
 * x-x402-pending-settlement) before returning responses to clients.
 *
 * @param response - CloudFront result response object to modify
 * @param key - Header name to remove (will be lowercased for lookup)
 *
 */
export function removeResponseHeader(
  response: CloudFrontResultResponse,
  key: string,
): void {
  const lowerKey = key.toLowerCase();
  if (response.headers) {
    delete response.headers[lowerKey];
  }
}

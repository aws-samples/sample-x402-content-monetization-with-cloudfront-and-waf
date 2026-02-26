/**
 * x402 on AWS Edge - Shared module entry point
 *
 * This module exports shared types, utilities, and interfaces used across
 * the origin-request, origin-response, and waf-sync Lambda functions.
 */

// Re-export config loader
export {
  getEdgeConfig,
  resetCache,
  _setTtl,
  _setSsmPrefix,
  _setSsmClient,
  _getCache,
} from './config-loader';

// Re-export CloudFront HTTP adapter
export {
  extractRequest,
  attachHeader,
  removeHeader,
  removeResponseHeader,
} from './cloudfront-adapter';

// Re-export structured logger and bot header derivation
export { emitVerification, emitSettlement, emitPaymentRequested, deriveActorType, deriveBotCategory, deriveBotName } from './logger';
export type { LogContext } from './logger';

// Re-export CloudFront HTTP adapter class
export { CloudFrontHTTPAdapter } from './cloudfront-http-adapter';

// Re-export x402 server factory and middleware
export { createX402Server } from './x402-server';
export type { X402ServerConfig } from './x402-server';
export { createX402Middleware } from './x402-middleware';
export type { OriginRequestResult, OriginResponseResult } from './x402-middleware';

// Re-export response utilities
export { toLambdaResponse } from './to-lambda-response';

// Re-export runtime-only types
export type { EdgeConfig } from './types';

// Re-export constants
export {
  Headers,
  ContentType,
  CacheControl,
  EventType,
  RequestResultType,
  ResponseResultType,
  BotDefaults,
  RouteDefaults,
  HttpStatus,
  SsmConfig,
  EnvVars,
} from './constants';

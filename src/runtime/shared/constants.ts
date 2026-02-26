/**
 * x402 on AWS Edge - Runtime Shared Constants
 *
 * Centralizes all magic strings used across runtime Lambda@Edge handlers.
 * Import from this module instead of using inline string literals.
 */

// ---------------------------------------------------------------------------
// HTTP Headers
// ---------------------------------------------------------------------------

export const Headers = {
  /** WAF-prefixed route action header (as it arrives at Lambda@Edge). */
  WAF_ROUTE_ACTION: 'x-amzn-waf-x-x402-route-action',

  /** Internal route action header name (before WAF prefixing). */
  ROUTE_ACTION: 'x-x402-route-action',

  /** Pending settlement data passed between origin-request and origin-response. */
  PENDING_SETTLEMENT: 'x-x402-pending-settlement',

  /** Payment signature header (x402 v2 protocol). */
  PAYMENT_SIGNATURE: 'payment-signature',

  /** Payment header (x402 v1 protocol). */
  X_PAYMENT: 'x-payment',

  /** Settlement response header from the facilitator. */
  PAYMENT_RESPONSE: 'x-payment-response',

  /** Standard X-Forwarded-For header for client IP extraction. */
  FORWARDED_FOR: 'x-forwarded-for',

  /** Standard Host header. */
  HOST: 'host',

  /** Standard User-Agent header. */
  USER_AGENT: 'user-agent',

  /** Standard Content-Type header. */
  CONTENT_TYPE: 'content-type',

  /** Standard Cache-Control header. */
  CACHE_CONTROL: 'cache-control',

  /** Payment-Required header in x402 responses. */
  PAYMENT_REQUIRED: 'PAYMENT-REQUIRED',

  /** WAF bot actor type header. */
  WAF_ACTOR_TYPE: 'x-amzn-waf-actor-type',

  /** WAF bot category header. */
  WAF_BOT_CATEGORY: 'x-amzn-waf-bot-category',

  /** WAF bot name header. */
  WAF_BOT_NAME: 'x-amzn-waf-bot-name',

  /** WAF header prefix used for filtering bot headers. */
  WAF_PREFIX: 'x-amzn-waf-',
} as const;

// ---------------------------------------------------------------------------
// Content Types
// ---------------------------------------------------------------------------

export const ContentType = {
  JSON: 'application/json',
} as const;

// ---------------------------------------------------------------------------
// Cache Control Values
// ---------------------------------------------------------------------------

export const CacheControl = {
  NO_STORE: 'no-store',
} as const;

// ---------------------------------------------------------------------------
// Event Types (structured logging)
// ---------------------------------------------------------------------------

export const EventType = {
  SETTLEMENT: 'settlement',
  VERIFICATION: 'verification',
  PAYMENT_REQUESTED: 'payment-requested',
  PASSTHROUGH: 'passthrough',
} as const;

// ---------------------------------------------------------------------------
// Middleware Result Types
// ---------------------------------------------------------------------------

export const RequestResultType = {
  PASS_THROUGH: 'pass-through',
  PAYMENT_ERROR: 'payment-error',
} as const;

export const ResponseResultType = {
  PASS_THROUGH: 'pass-through',
  SETTLED: 'settled',
  SETTLEMENT_FAILED: 'settlement-failed',
} as const;

// ---------------------------------------------------------------------------
// Bot Signal Defaults
// ---------------------------------------------------------------------------

export const BotDefaults = {
  ACTOR_TYPE: 'human',
  CATEGORY: 'none',
  NAME: 'unknown',
} as const;

// ---------------------------------------------------------------------------
// Route Defaults
// ---------------------------------------------------------------------------

export const RouteDefaults = {
  /** Default catch-all route pattern used in dynamic RoutesConfig. */
  CATCH_ALL_PATTERN: 'GET /*',

  /** Price value indicating free access (no payment required). */
  FREE_PRICE: '0',

  /** Fallback value when client IP cannot be determined. */
  UNKNOWN_CLIENT: '[unknown]',
} as const;

// ---------------------------------------------------------------------------
// HTTP Status
// ---------------------------------------------------------------------------

export const HttpStatus = {
  PAYMENT_REQUIRED: 402,
  PAYMENT_REQUIRED_DESCRIPTION: 'Payment Required',
  ERROR_DESCRIPTION: 'Error',
  /** Origin status threshold above which settlement is skipped. */
  ERROR_THRESHOLD: 400,
} as const;

// ---------------------------------------------------------------------------
// SSM Configuration
// ---------------------------------------------------------------------------

export const SsmConfig = {
  PREFIX: '/x402-edge/',
  SUFFIX_CONFIG: '/config',
  KEY_PAYTO: '/payto',
  KEY_NETWORK: '/network',
  KEY_FACILITATOR_URL: '/facilitator-url',
} as const;

// ---------------------------------------------------------------------------
// CDP (Coinbase Developer Platform) Configuration
// ---------------------------------------------------------------------------

export const CdpConfig = {
  FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402',
  FACILITATOR_HOST: 'api.cdp.coinbase.com',
  FACILITATOR_ROUTE: '/platform/v2/x402',
  /** Secrets Manager name pattern for CDP credentials. Full name: x402-edge/{stack}/cdp-credentials */
  SECRET_PREFIX: 'x402-edge/',
  SECRET_SUFFIX: '/cdp-credentials',
} as const;

// ---------------------------------------------------------------------------
// Environment Variables
// ---------------------------------------------------------------------------

export const EnvVars = {
  LAMBDA_FUNCTION_NAME: 'AWS_LAMBDA_FUNCTION_NAME',
} as const;

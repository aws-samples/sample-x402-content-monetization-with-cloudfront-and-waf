/**
 * x402 on AWS Edge - Runtime TypeScript Interfaces and Types
 *
 * Runtime-specific type definitions used by Lambda@Edge handlers.
 * Shared domain types (RouteConfig, WAF types) live in src/shared/types.ts.
 */

// ---------------------------------------------------------------------------
// Edge Configuration Types (Lambda@Edge Runtime)
// ---------------------------------------------------------------------------

/**
 * CDP API key credentials fetched from Secrets Manager.
 * Only present when the CDP facilitator is selected.
 */
export interface CdpCredentials {
  /** CDP API key name/ID. */
  apiKeyName: string;
  /** CDP API key private key (PEM PKCS#8). */
  apiKeyPrivateKey: string;
}

/**
 * Configuration fetched from SSM Parameter Store by Lambda@Edge at runtime.
 * Contains the publisher's wallet address, blockchain network, and facilitator
 * URL. Cached in memory with a configurable TTL.
 *
 */
export interface EdgeConfig {
  /** Publisher's Ethereum wallet address that receives USDC payments. */
  payTo: string;

  /**
   * Blockchain network for payment settlement.
   * - `"eip155:84532"` — Base Sepolia testnet
   * - `"eip155:8453"` — Base Mainnet
   */
  network: string;

  /** Facilitator service URL for payment verification and settlement. */
  facilitatorUrl: string;

  /** CDP API key credentials. Only present when CDP facilitator is used. */
  cdpCredentials?: CdpCredentials;
}

// ---------------------------------------------------------------------------
// Facilitator Communication Types
// ---------------------------------------------------------------------------

/**
 * Payment requirements sent to the facilitator verify endpoint and
 * included in 402 Payment Required responses. Describes what payment
 * is needed for a specific resource.
 *
 */
export interface PaymentRequirements {
  /** Price in USD as a string (e.g., `"0.001"`, `"0.01"`). */
  price: string;

  /** Publisher's Ethereum wallet address that receives payment. */
  payTo: string;

  /** Blockchain network identifier (e.g., `"eip155:84532"`). */
  network: string;
}

// ---------------------------------------------------------------------------
// Config Caching Types (Lambda@Edge)
// ---------------------------------------------------------------------------

/**
 * In-memory cache for Lambda@Edge configuration. Stores both SSM
 * Parameter Store values and Secrets Manager credentials with a
 * configurable TTL to minimize API calls from edge locations.
 *
 */
export interface ConfigCache {
  /** Cached edge configuration (PayTo, Network, Facilitator URL), or null if not yet fetched. */
  edgeConfig: EdgeConfig | null;

  /** Timestamp (ms since epoch) when the cache was last populated. */
  lastFetched: number;

  /** Cache time-to-live in milliseconds. */
  ttl: number;
}

// ---------------------------------------------------------------------------
// CloudFront HTTP Adapter Types
// ---------------------------------------------------------------------------

/**
 * Parsed representation of an incoming CloudFront request, extracted
 * from the CloudFront event object. Provides a clean interface for
 * the origin-request handler to work with.
 *
 */
export interface ParsedRequest {
  /** URL path of the request (e.g., `/api/data`). */
  path: string;

  /** Host header value from the request. */
  host: string;

  /** Flattened map of all request headers (lowercase keys). */
  headers: Record<string, string>;

  /**
   * Value of the `X-PAYMENT` or `X-PAYMENT-SIGNATURE` header, if present.
   * Contains the cryptographic payment proof from the paying client.
   */
  paymentHeader?: string;

  /**
   * Value of the WAF-injected `x-amzn-waf-x-x402-route-action` header, if present.
   * WAF auto-prefixes headers inserted via Count action InsertHeaders with
   * `x-amzn-waf-`, so Lambda@Edge reads the prefixed version. Contains the
   * resolved price from WAF route evaluation, or is absent if the request
   * did not match any priced route.
   */
  routeActionHeader?: string;

  /**
   * Map of all WAF bot-related headers (keys matching `x-amzn-waf-*`).
   * Used for bot filter evaluation and actor type derivation.
   */
  botHeaders: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Structured Logging Types
// ---------------------------------------------------------------------------

/**
 * Structured log entry emitted for each payment settlement event.
 * Written to CloudWatch Logs by the origin-response Lambda@Edge function.
 *
 */
export interface SettlementLogEntry {
  /** Event type identifier, always `"settlement"`. */
  event: 'settlement';

  /** URL path of the request (e.g., `/api/premium/data`). */
  path: string;

  /** Price in USD that was settled (e.g., `"0.01"`). */
  price: string;

  /** Blockchain network used for settlement (e.g., `"eip155:84532"`). */
  network: string;

  /** Derived actor type from WAF bot signal headers (e.g., `"verified-bot"`, `"human"`). */
  actorType: string;

  /** Bot category from WAF Bot Control (e.g., `"ai"`, `"search_engine"`) or `"none"`. */
  botCategory: string;

  /** Bot organization from WAF Bot Control (e.g., `"anthropic"`, `"google"`) or `"unknown"`. */
  botOrganization: string;

  /** Bot name from WAF Bot Control (e.g., `"claudebot"`, `"perplexitybot"`) or `"unknown"`. */
  botName: string;

  /** Client IP address (may be anonymized). */
  clientIp: string;

  /** Settlement result: `"success"` or `"failure"`. */
  result: 'success' | 'failure';

  /** On-chain transaction hash, present only on successful settlement. */
  transactionHash: string | null;

  /** Error message, present only on failed settlement. */
  error: string | null;
}

/**
 * Structured log entry emitted for each payment verification event.
 * Written to CloudWatch Logs by the origin-request Lambda@Edge function.
 *
 */
export interface VerificationLogEntry {
  /** Event type identifier, always `"verification"`. */
  event: 'verification';
  path: string;
  matchedRoute: string;
  price: string;
  clientIp: string;
  result: 'success' | 'failure';
  error: string | null;
  actorType: string;
  /** Bot category from WAF Bot Control (e.g., `"ai"`, `"search_engine"`) or `"none"`. */
  botCategory: string;
  /** Bot organization from WAF Bot Control (e.g., `"anthropic"`, `"google"`) or `"unknown"`. */
  botOrganization: string;
  /** Bot name from WAF Bot Control (e.g., `"claudebot"`, `"perplexitybot"`) or `"unknown"`. */
  botName: string;
  /** Blockchain network (e.g., `"eip155:84532"`). */
  network: string;
  /** Always null for verification events (only present on settlement). */
  transactionHash: null;
}

/**
 * Structured log entry emitted when a 402 payment-required response is returned.
 * This is step 1 of the payment flow: the server requests payment from the client.
 *
 */
export interface PaymentRequestedLogEntry {
  /** Event type identifier, always `"payment-requested"`. */
  event: 'payment-requested';
  path: string;
  price: string;
  clientIp: string;
  actorType: string;
  /** Bot category from WAF Bot Control (e.g., `"ai"`, `"search_engine"`) or `"none"`. */
  botCategory: string;
  /** Bot organization from WAF Bot Control (e.g., `"anthropic"`, `"google"`) or `"unknown"`. */
  botOrganization: string;
  /** Bot name from WAF Bot Control (e.g., `"claudebot"`, `"perplexitybot"`) or `"unknown"`. */
  botName: string;
  /** Blockchain network (e.g., `"eip155:84532"`). */
  network: string;
  /** Always null for payment-requested events (only present on settlement). */
  transactionHash: null;
}

export interface PassthroughLogEntry {
  /** Event type identifier, always `"passthrough"`. */
  event: 'passthrough';
  path: string;
  clientIp: string;
  actorType: string;
  /** Bot category from WAF Bot Control (e.g., `"ai"`, `"search_engine"`) or `"none"`. */
  botCategory: string;
  /** Bot organization from WAF Bot Control (e.g., `"anthropic"`, `"google"`) or `"unknown"`. */
  botOrganization: string;
  /** Bot name from WAF Bot Control (e.g., `"claudebot"`, `"perplexitybot"`) or `"unknown"`. */
  botName: string;
}

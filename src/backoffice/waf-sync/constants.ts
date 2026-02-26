/**
 * x402 on AWS Edge - WAF Sync Constants
 *
 * Centralizes all magic strings used by the WAF sync backoffice function.
 */

// ---------------------------------------------------------------------------
// WAF Label Prefixes
// ---------------------------------------------------------------------------

const WAF_LABEL_BASE = 'awswaf:managed:aws:bot-control:bot';

export const WafLabels = {
  /** Prefix for bot category labels. */
  CATEGORY: `${WAF_LABEL_BASE}:category:`,

  /** Prefix for bot organization labels. */
  ORGANIZATION: `${WAF_LABEL_BASE}:organization:`,

  /** Prefix for bot name labels. */
  NAME: `${WAF_LABEL_BASE}:name:`,

  /** Exact label for verified bots. */
  VERIFIED: `${WAF_LABEL_BASE}:verified`,

  /** Exact label for WBA-verified bots. */
  WBA_VERIFIED: `${WAF_LABEL_BASE}:web_bot_auth:verified`,
} as const;

// ---------------------------------------------------------------------------
// WAF Actor Types
// ---------------------------------------------------------------------------

export const ActorType = {
  UNVERIFIED_BOT: 'unverified-bot',
  VERIFIED_BOT: 'verified-bot',
  WBA_VERIFIED_BOT: 'wba-verified-bot',
} as const;

// ---------------------------------------------------------------------------
// WAF Signal Header Names (unprefixed, used in Count InsertHeaders)
// ---------------------------------------------------------------------------

export const BotSignalHeaders = {
  ACTOR_TYPE: 'actor-type',
  BOT_CATEGORY: 'bot-category',
  BOT_NAME: 'bot-name',
} as const;

// ---------------------------------------------------------------------------
// WAF Scope & Operators
// ---------------------------------------------------------------------------

export const WafScope = {
  CLOUDFRONT: 'CLOUDFRONT',
} as const;

export const WafTextTransformation = {
  NONE: 'NONE',
} as const;

export const WafComparisonOperator = {
  GE: 'GE',
} as const;

// ---------------------------------------------------------------------------
// WAF Label Match Scopes
// ---------------------------------------------------------------------------

export const LabelMatchScope = {
  LABEL: 'LABEL',
  NAMESPACE: 'NAMESPACE',
} as const;

// ---------------------------------------------------------------------------
// Route Action Constants
// ---------------------------------------------------------------------------

export const RouteAction = {
  BLOCK: 'block',
  FREE: '0',
} as const;

// ---------------------------------------------------------------------------
// Guard Rule
// ---------------------------------------------------------------------------

export const GuardRule = {
  NAME: 'guard-block-spoofed-headers',
} as const;

// ---------------------------------------------------------------------------
// WAF Rule Labels
// ---------------------------------------------------------------------------

export const RouteMatchedLabel = {
  KEY: 'x402:route-matched',
} as const;

// ---------------------------------------------------------------------------
// SSM Parameter Types
// ---------------------------------------------------------------------------

export const SsmParameterType = {
  STRING: 'String',
} as const;

// ---------------------------------------------------------------------------
// AWS Error Names
// ---------------------------------------------------------------------------

export const AwsErrors = {
  PARAMETER_NOT_FOUND: 'ParameterNotFound',
} as const;

// ---------------------------------------------------------------------------
// Environment Variables (WAF Sync specific)
// ---------------------------------------------------------------------------

export const WafEnvVars = {
  SSM_ROUTES_PATH: 'SSM_ROUTES_PATH',
  SSM_HASH_PATH: 'SSM_HASH_PATH',
  WAF_RULE_GROUP_NAME: 'WAF_RULE_GROUP_NAME',
  WAF_RULE_GROUP_ID: 'WAF_RULE_GROUP_ID',
} as const;

// ---------------------------------------------------------------------------
// Default Condition
// ---------------------------------------------------------------------------

export const DefaultCondition = {
  VALUE: 'default',
} as const;

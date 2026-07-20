/**
 * x402 on AWS Edge - WAF Sync Constants
 *
 * Centralizes all magic strings used by the WAF sync backoffice function.
 */

// ---------------------------------------------------------------------------
// WAF Scope & Operators
// ---------------------------------------------------------------------------

export const WafScope = {
  CLOUDFRONT: 'CLOUDFRONT',
} as const;

export const WafTextTransformation = {
  NONE: 'NONE',
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

/** Native AWS WAF monetization uses a $0.001 USDC base price. */
export const Monetization = {
  BASE_PRICE_USDC: '0.001',
  PRICE_SCALE: 1000,
  MAX_MULTIPLIER: 100,
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

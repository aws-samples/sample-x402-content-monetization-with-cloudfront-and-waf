/**
 * x402 on AWS Edge - Route Config Validator
 *
 * Validates Route_Config JSON objects against the expected schema.
 * Returns a typed `RouteConfig` on success or a descriptive validation
 * error on failure.
 *
 */

import type { RouteConfig, RouteEntry, AccessPolicy, ConditionExpression } from './types';

// ---------------------------------------------------------------------------
// Validation Result Type
// ---------------------------------------------------------------------------

/** Result of a Route_Config validation attempt. */
export type ValidationResult =
  | { success: true; config: RouteConfig }
  | { success: false; error: string };

// ---------------------------------------------------------------------------
// Price pattern: a non-negative decimal number (e.g., "0", "0.001", "10", "1.5")
// ---------------------------------------------------------------------------

const PRICE_PATTERN = /^\d+(\.\d+)?$/;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum nesting depth for condition expressions (WAF nesting limit). */
const MAX_CONDITION_DEPTH = 5;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a JSON string as a Route_Config.
 *
 * @param json - The raw JSON string to parse and validate
 * @returns A `ValidationResult` with either the typed `RouteConfig` or a descriptive error
 */
export function parseRouteConfig(json: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return fail(`Invalid JSON: ${(e as Error).message}`);
  }
  return validateRouteConfig(parsed);
}

// ---------------------------------------------------------------------------
// Internal Validators
// ---------------------------------------------------------------------------

function validateRouteConfig(input: unknown): ValidationResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return fail('Route config must be a non-null object');
  }

  const obj = input as Record<string, unknown>;

  if (!Array.isArray(obj.routes)) {
    return fail('"routes" must be an array');
  }

  const routes: RouteEntry[] = [];

  for (let i = 0; i < obj.routes.length; i++) {
    const routeResult = validateRouteEntry(obj.routes[i], i);
    if (routeResult.success === false) {
      return { success: false as const, error: routeResult.error };
    }
    routes.push(routeResult.entry);
  }

  return { success: true, config: { routes } };
}

type RouteEntryResult =
  | { success: true; entry: RouteEntry }
  | { success: false; error: string };

function validateRouteEntry(input: unknown, index: number): RouteEntryResult {
  const prefix = `routes[${index}]`;

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return fail(`${prefix}: must be a non-null object`);
  }

  const obj = input as Record<string, unknown>;

  if (typeof obj.pattern !== 'string') {
    return fail(`${prefix}.pattern: must be a string`);
  }
  if (obj.pattern.length === 0) {
    return fail(`${prefix}.pattern: must not be empty`);
  }

  if (!Array.isArray(obj.policies)) {
    return fail(`${prefix}.policies: must be an array`);
  }
  if (obj.policies.length === 0) {
    return fail(`${prefix}.policies: must not be empty`);
  }

  const policies: AccessPolicy[] = [];
  for (let j = 0; j < obj.policies.length; j++) {
    const policyResult = validateAccessPolicy(obj.policies[j], `${prefix}.policies[${j}]`);
    if (policyResult.success === false) {
      return { success: false as const, error: policyResult.error };
    }
    policies.push(policyResult.policy);
  }

  return { success: true, entry: { pattern: obj.pattern, policies } };
}

type AccessPolicyResult =
  | { success: true; policy: AccessPolicy }
  | { success: false; error: string };

function validateAccessPolicy(input: unknown, prefix: string): AccessPolicyResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return fail(`${prefix}: must be a non-null object`);
  }

  const obj = input as Record<string, unknown>;

  const condition = obj.condition;
  if (condition === undefined || condition === null) {
    return fail(`${prefix}.condition: is required`);
  }

  const condResult = validateConditionExpression(condition, `${prefix}.condition`, 0);
  if (condResult.success === false) {
    return { success: false as const, error: condResult.error };
  }

  const action = obj.action;
  if (typeof action !== 'string') {
    return fail(`${prefix}.action: must be a string`);
  }
  if (action !== 'block' && !PRICE_PATTERN.test(action)) {
    return fail(
      `${prefix}.action: must be "block" or a non-negative price string (e.g., "0", "0.001", "10"), got "${action}"`,
    );
  }

  return {
    success: true,
    policy: {
      condition: condResult.condition as AccessPolicy['condition'],
      action,
    },
  };
}

// ---------------------------------------------------------------------------
// Condition Expression Validator
// ---------------------------------------------------------------------------

type ConditionExpressionResult =
  | { success: true; condition: ConditionExpression | 'default' }
  | { success: false; error: string };

/**
 * Recursively validate a condition expression.
 *
 * Supports:
 * - `string` — single WAF label or "default"
 * - `string[]` — array of WAF labels (AND logic)
 * - `{ and: [...] }` — all sub-conditions must match
 * - `{ or: [...] }` — at least one sub-condition must match
 * - `{ not: <condition> }` — inverts the inner condition
 * - `{ namespace: string }` — WAF namespace prefix match
 */
function validateConditionExpression(
  input: unknown,
  prefix: string,
  depth: number = 0,
): ConditionExpressionResult {
  if (depth > MAX_CONDITION_DEPTH) {
    return fail(`${prefix}: condition nesting exceeds maximum depth of ${MAX_CONDITION_DEPTH}`);
  }

  // String — single label or "default"
  if (typeof input === 'string') {
    if (input.length === 0) {
      return fail(`${prefix}: must not be an empty string`);
    }
    return { success: true, condition: input };
  }

  // String array — AND of labels
  if (Array.isArray(input)) {
    if (input.length === 0) {
      return fail(`${prefix}: array must not be empty`);
    }
    for (let k = 0; k < input.length; k++) {
      if (typeof input[k] !== 'string') {
        return fail(`${prefix}[${k}]: must be a string`);
      }
      if ((input[k] as string).length === 0) {
        return fail(`${prefix}[${k}]: must not be an empty string`);
      }
    }
    return { success: true, condition: input as string[] };
  }

  // Object with and/or/not/namespace
  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>;
    const keys = Object.keys(obj);

    if (keys.length !== 1 || !['and', 'or', 'not', 'namespace'].includes(keys[0])) {
      return fail(
        `${prefix}: condition object must have exactly one key: "and", "or", "not", or "namespace"`,
      );
    }

    const key = keys[0];

    if (key === 'namespace') {
      if (typeof obj.namespace !== 'string') {
        return fail(`${prefix}.namespace: must be a string`);
      }
      if (obj.namespace.length === 0) {
        return fail(`${prefix}.namespace: must not be an empty string`);
      }
      return { success: true, condition: { namespace: obj.namespace } };
    }

    if (key === 'not') {
      const subResult = validateConditionExpression(obj.not, `${prefix}.not`, depth + 1);
      if (!subResult.success) {
        return subResult;
      }
      return {
        success: true,
        condition: { not: subResult.condition as ConditionExpression },
      };
    }

    // and/or: validate array of sub-conditions
    const arr = obj[key];
    if (!Array.isArray(arr)) {
      return fail(`${prefix}.${key}: must be a non-empty array`);
    }
    if (arr.length === 0) {
      return fail(`${prefix}.${key}: must be a non-empty array`);
    }

    const subConditions: ConditionExpression[] = [];
    for (let i = 0; i < arr.length; i++) {
      const subResult = validateConditionExpression(
        arr[i],
        `${prefix}.${key}[${i}]`,
        depth + 1,
      );
      if (!subResult.success) {
        return subResult;
      }
      subConditions.push(subResult.condition as ConditionExpression);
    }

    if (key === 'and') {
      return { success: true, condition: { and: subConditions } };
    }
    return { success: true, condition: { or: subConditions } };
  }

  return fail(`${prefix}: invalid condition type`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(error: string): { success: false; error: string } {
  return { success: false, error };
}

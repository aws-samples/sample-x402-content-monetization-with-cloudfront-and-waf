/**
 * x402 on AWS Edge - WCU (WAF Capacity Unit) Calculator
 *
 * Calculates the WCU cost of WAF rules to ensure they fit within
 * the rule group's capacity limit. Each statement type has a fixed
 * WCU cost per AWS WAF pricing:
 *
 * - ByteMatch (EXACTLY / STARTS_WITH): 1 WCU
 * - RegexMatch: 3 WCU
 * - LabelMatch: 1 WCU per entry
 * - SizeConstraint: 1 WCU
 * - AND/OR/NOT wrappers: 0 WCU (they wrap existing statements)
 */

import type { WafRule, WafStatement } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum WCU capacity of the WAF Rule Group. */
export const RULE_GROUP_CAPACITY = 500;

/** Number of guarded headers in the guard rule (OR of SizeConstraint statements). */
export const GUARD_RULE_HEADER_COUNT = 8;

/** Number of actor-type bot signal rules. */
export const BOT_SIGNAL_ACTOR_TYPE_COUNT = 3;

/** Number of bot category signal rules. */
export const BOT_SIGNAL_CATEGORY_COUNT = 16;

/** Number of bot organization signal rules. */
export const BOT_SIGNAL_ORG_COUNT = 129;

/** Number of bot name signal rules. */
export const BOT_SIGNAL_NAME_COUNT = 31;

/** WCU consumed by the guard rule (OR of SizeConstraint statements, 1 WCU each). */
export const GUARD_RULE_WCU = GUARD_RULE_HEADER_COUNT;

/** WCU consumed by all bot signal forwarding rules (1 LabelMatch each = 1 WCU each). */
export const BOT_SIGNAL_WCU =
  BOT_SIGNAL_ACTOR_TYPE_COUNT +
  BOT_SIGNAL_CATEGORY_COUNT +
  BOT_SIGNAL_ORG_COUNT +
  BOT_SIGNAL_NAME_COUNT;

/** Total fixed overhead WCU (guard rule + bot signal rules). */
export const FIXED_OVERHEAD_WCU = GUARD_RULE_WCU + BOT_SIGNAL_WCU;

// ---------------------------------------------------------------------------
// WCU Calculation Functions
// ---------------------------------------------------------------------------

/**
 * Calculate the WCU cost of a single WafStatement.
 *
 * - byteMatchStatement → 1 WCU
 * - regexMatchStatement → 3 WCU
 * - labelMatchStatements → 1 WCU per entry
 * - andStatement → sum of children (AND wrapper is free)
 * - orStatement → sum of children (OR wrapper is free)
 * - notStatement → WCU of inner statement (NOT wrapper is free)
 */
export function calculateStatementWcu(statement: WafStatement): number {
  if (statement.byteMatchStatement) {
    return 1;
  }

  if (statement.regexMatchStatement) {
    return 3;
  }

  if (statement.labelMatchStatements && statement.labelMatchStatements.length > 0) {
    return statement.labelMatchStatements.length;
  }

  if (statement.andStatement) {
    return statement.andStatement.statements.reduce(
      (sum, child) => sum + calculateStatementWcu(child),
      0,
    );
  }

  if (statement.orStatement) {
    return statement.orStatement.statements.reduce(
      (sum, child) => sum + calculateStatementWcu(child),
      0,
    );
  }

  if (statement.notStatement) {
    return calculateStatementWcu(statement.notStatement.statement);
  }

  return 0;
}

/**
 * Calculate the WCU cost of a single WAF rule.
 */
export function calculateRuleWcu(rule: WafRule): number {
  return calculateStatementWcu(rule.statement);
}

/**
 * Calculate the total WCU for a set of route rules, including fixed overhead.
 */
export function calculateTotalWcu(rules: WafRule[]): {
  routeRulesWcu: number;
  fixedOverheadWcu: number;
  totalWcu: number;
} {
  const routeRulesWcu = rules.reduce((sum, rule) => sum + calculateRuleWcu(rule), 0);
  return {
    routeRulesWcu,
    fixedOverheadWcu: FIXED_OVERHEAD_WCU,
    totalWcu: routeRulesWcu + FIXED_OVERHEAD_WCU,
  };
}

/**
 * Validate that the total WCU of route rules plus fixed overhead
 * fits within the rule group capacity.
 */
export function validateWcuCapacity(rules: WafRule[]): {
  valid: boolean;
  totalWcu: number;
  capacity: number;
  routeRulesWcu: number;
  fixedOverheadWcu: number;
} {
  const { routeRulesWcu, fixedOverheadWcu, totalWcu } = calculateTotalWcu(rules);
  return {
    valid: totalWcu <= RULE_GROUP_CAPACITY,
    totalWcu,
    capacity: RULE_GROUP_CAPACITY,
    routeRulesWcu,
    fixedOverheadWcu,
  };
}

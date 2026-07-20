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

/** Maximum WCU capacity of the WAF Rule Group. Must match Capacity in template.yaml. */
export const RULE_GROUP_CAPACITY = 300;

/** Native terminating actions require no guard or header-forwarding rules. */
export const FIXED_OVERHEAD_WCU = 0;

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

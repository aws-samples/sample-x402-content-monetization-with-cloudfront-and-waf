/**
 * Editor-side WCU (WAF Capacity Unit) estimator.
 *
 * Mirrors the backend WCU calculation logic but operates on
 * the editor's data model (EditorState) rather than WafRule[].
 */

import type { EditorState, EditorPolicy } from './types';
import type { RuleGroupType } from 'react-querybuilder';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RULE_GROUP_CAPACITY = 350;
export const FIXED_OVERHEAD_WCU = 62;

// ---------------------------------------------------------------------------
// Pattern WCU Estimation
// ---------------------------------------------------------------------------

/**
 * Estimate WCU cost for a URL pattern.
 *
 * Mirrors route-pattern-translator.ts logic:
 * - Ends with `/**` and no prior wildcards → 1 (STARTS_WITH ByteMatch)
 * - Contains `*` → 3 (RegexMatch)
 * - Else → 1 (EXACTLY ByteMatch)
 */
export function estimatePatternWcu(pattern: string): number {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    if (!prefix.includes('*')) return 1;
  }
  if (pattern.includes('*')) return 3;
  return 1;
}

// ---------------------------------------------------------------------------
// Condition WCU Estimation
// ---------------------------------------------------------------------------

/**
 * Count the number of leaf statements in a query tree.
 * Each leaf is a LabelMatch (1 WCU).
 */
function countQueryLeaves(query: RuleGroupType): number {
  let count = 0;
  for (const rule of query.rules) {
    if ('rules' in rule) {
      count += countQueryLeaves(rule as RuleGroupType);
    } else {
      count += 1;
    }
  }
  return count;
}

/**
 * Estimate WCU for a policy's condition.
 *
 * - Default condition: 0 extra WCU (no label match needed)
 * - Non-default: 1 WCU per leaf condition in the query tree
 */
export function estimateConditionWcu(query: RuleGroupType, isDefault: boolean): number {
  if (isDefault) return 0;
  return countQueryLeaves(query);
}

// ---------------------------------------------------------------------------
// Per-Policy WCU Estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the total WCU for a single policy within a route.
 *
 * Each policy rule consists of:
 * - URI pattern match: patternWcu (1 or 3)
 * - Scope-down NOT(LabelMatch): 1 WCU
 * - Condition leaves: 1 WCU each
 */
export function estimatePolicyWcu(pattern: string, policy: EditorPolicy): number {
  const patternWcu = estimatePatternWcu(pattern);
  const scopeDownWcu = 1; // NOT(LabelMatch(x402:route-matched))
  const conditionWcu = estimateConditionWcu(policy.query, policy.isDefault);
  return patternWcu + scopeDownWcu + conditionWcu;
}

// ---------------------------------------------------------------------------
// Total WCU Estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the total WCU usage for the entire editor state.
 */
export function estimateTotalWcu(state: EditorState): {
  routeRulesWcu: number;
  fixedOverheadWcu: number;
  totalWcu: number;
  capacity: number;
} {
  let routeRulesWcu = 0;

  for (const route of state.routes) {
    for (const policy of route.policies) {
      routeRulesWcu += estimatePolicyWcu(route.pattern, policy);
    }
  }

  return {
    routeRulesWcu,
    fixedOverheadWcu: FIXED_OVERHEAD_WCU,
    totalWcu: routeRulesWcu + FIXED_OVERHEAD_WCU,
    capacity: RULE_GROUP_CAPACITY,
  };
}

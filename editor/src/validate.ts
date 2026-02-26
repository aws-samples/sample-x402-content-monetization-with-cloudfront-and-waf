import type { EditorState, ValidationErrors } from './types';
import type { RuleGroupType, RuleType } from 'react-querybuilder';
import { estimateTotalWcu, RULE_GROUP_CAPACITY } from './wcu-calculator';

export const MAX_CONDITION_DEPTH = 5;
export const MAX_TOTAL_POLICIES = 100;
export const MAX_POLICIES_PER_ROUTE = 20;
/** Max leaf conditions in a single AND/OR group. WAF has no hard limit but WCU grows linearly. */
export const MAX_CHILDREN_PER_GROUP = 10;
/** Max total leaf statements per policy condition. Each ≈ 1 WCU; the rule also has URI match + scope-down overhead. */
export const MAX_STATEMENTS_PER_CONDITION = 20;

export function validate(state: EditorState): ValidationErrors {
  const errors: ValidationErrors = {};
  const globalErrors: string[] = [];

  // Global: total policy count
  const totalPolicies = state.routes.reduce((sum, r) => sum + r.policies.length, 0);
  if (totalPolicies > MAX_TOTAL_POLICIES) {
    globalErrors.push(`Total policies (${totalPolicies}) exceeds limit of ${MAX_TOTAL_POLICIES}.`);
  }

  // WCU capacity check
  const wcuEstimate = estimateTotalWcu(state);
  if (wcuEstimate.totalWcu > RULE_GROUP_CAPACITY) {
    globalErrors.push(`Estimated WCU usage (${wcuEstimate.totalWcu}) exceeds rule group capacity (${RULE_GROUP_CAPACITY}). Remove routes/policies or simplify conditions.`);
  }

  // Duplicate route patterns
  const patternCounts = new Map<string, number>();
  for (const route of state.routes) {
    const p = route.pattern.trim();
    if (p) patternCounts.set(p, (patternCounts.get(p) || 0) + 1);
  }
  for (const [pattern, count] of patternCounts) {
    if (count > 1) {
      globalErrors.push(`Duplicate route pattern "${pattern}" appears ${count} times. Each pattern should be unique.`);
    }
  }

  for (const route of state.routes) {
    if (!route.pattern.trim()) {
      errors[`${route.id}-pattern`] = 'Pattern is required';
    }

    if (route.policies.length > MAX_POLICIES_PER_ROUTE) {
      errors[`${route.id}-policies`] = `Too many policies (${route.policies.length}). Max ${MAX_POLICIES_PER_ROUTE} per route.`;
    }

    // Default policy placement
    const defaultIndices = route.policies
      .map((p, i) => p.isDefault ? i : -1)
      .filter(i => i >= 0);
    if (defaultIndices.length > 1) {
      errors[`${route.id}-defaults`] = 'Only one default policy allowed per route';
    }
    if (defaultIndices.length === 1 && defaultIndices[0] !== route.policies.length - 1) {
      errors[`${route.id}-default-pos`] = 'Default policy must be the last policy (policies after it are unreachable)';
    }

    // Duplicate conditions within the same route
    const conditionKeys: string[] = [];
    for (const policy of route.policies) {
      if (!policy.isDefault) {
        const key = queryFingerprint(policy.query);
        if (key) conditionKeys.push(key);
      }
    }
    const condCounts = new Map<string, number>();
    for (const k of conditionKeys) condCounts.set(k, (condCounts.get(k) || 0) + 1);
    for (const [, count] of condCounts) {
      if (count > 1) {
        errors[`${route.id}-dup-condition`] = `Route has duplicate conditions. Each policy within a route should have a unique condition.`;
        break;
      }
    }

    for (const policy of route.policies) {
      const a = policy.action.trim();
      if (a !== 'block' && a !== '0' && (isNaN(Number(a)) || Number(a) < 0)) {
        errors[`${policy.id}-action`] = 'Action must be a price (e.g. "0.01"), "0", or "block"';
      }
      if (a !== 'block' && a !== '0' && !isNaN(Number(a)) && Number(a) > 0 && Number(a) < 0.000001) {
        errors[`${policy.id}-action`] = 'Price too small. Minimum practical price is 0.000001 USDC.';
      }

      if (!policy.isDefault) {
        const depth = queryDepth(policy.query);
        if (depth > MAX_CONDITION_DEPTH) {
          errors[`${policy.id}-depth`] = `Condition nesting depth (${depth}) exceeds WAF limit of ${MAX_CONDITION_DEPTH}`;
        }
        if (policy.query.rules.length === 0) {
          errors[`${policy.id}-empty`] = 'Condition has no rules. Add at least one condition or use "Default" instead.';
        }
        const stmtCount = queryStatementCount(policy.query);
        if (stmtCount > MAX_STATEMENTS_PER_CONDITION) {
          errors[`${policy.id}-statements`] = `Condition has ${stmtCount} statements (max ${MAX_STATEMENTS_PER_CONDITION}). Each adds ~1 WCU to the rule. Simplify or split into multiple policies.`;
        }
        checkGroupChildren(policy.query, policy.id, errors);
      }
    }
  }

  if (globalErrors.length > 0) {
    errors['global'] = globalErrors.join(' ');
  }

  return errors;
}

function queryDepth(query: RuleGroupType): number {
  if (query.rules.length === 0) return 0;
  let max = 0;
  for (const rule of query.rules) {
    if ('rules' in rule) {
      max = Math.max(max, queryDepth(rule as RuleGroupType));
    }
  }
  return 1 + max;
}

/** Produce a stable string fingerprint of a query for duplicate detection. */
function queryFingerprint(query: RuleGroupType): string {
  const parts = query.rules.map(r => {
    if ('rules' in r) return `(${query.combinator} ${queryFingerprint(r as RuleGroupType)})`;
    const rule = r as RuleType;
    return `${rule.field}:${rule.value}`;
  });
  parts.sort();
  const base = `${query.combinator}[${parts.join(',')}]`;
  return query.not ? `NOT(${base})` : base;
}

/** Count total leaf statements in a query tree (proxy for WCU cost). */
function queryStatementCount(query: RuleGroupType): number {
  let count = 0;
  for (const rule of query.rules) {
    if ('rules' in rule) {
      count += queryStatementCount(rule as RuleGroupType);
    } else {
      count += 1;
    }
  }
  return count;
}

/** Warn if any single AND/OR group has too many direct children. */
function checkGroupChildren(query: RuleGroupType, policyId: string, errors: ValidationErrors): void {
  if (query.rules.length > MAX_CHILDREN_PER_GROUP && !errors[`${policyId}-children`]) {
    errors[`${policyId}-children`] = `A condition group has ${query.rules.length} direct children (recommended max ${MAX_CHILDREN_PER_GROUP}). Large AND/OR groups increase WCU cost. Consider simplifying with namespace matching.`;
  }
  for (const rule of query.rules) {
    if ('rules' in rule) {
      checkGroupChildren(rule as RuleGroupType, policyId, errors);
    }
  }
}

/**
 * x402 on AWS Edge - AWS WAF Rule Translator
 *
 * Translates a Route_Config into an ordered list of AWS WAF rules for the
 * WAF_Rule_Group. Each route + policy combination becomes a single WAF rule:
 *
 * - **Block actions** → WAF Block rule
 * - **Price actions** (including "0") → WAF Count rule with `InsertHeader`
 *   custom request header `x-x402-route-action: <price>` and a
 *   `x402:route-matched` label. Subsequent rules include a scope-down
 *   NOT LabelMatch so only the first matching rule captures the request.
 *
 * Rules are assigned priorities in route order then policy order so that
 * the first matching policy wins (consistent with WAF evaluation semantics).
 *
 * Each rule combines a URI path byte-match statement (from the route pattern
 * translator) with WAF label-match statements for the condition.
 *
 */

import type { ConditionExpression, RouteConfig, WafRule, WafStatement } from './types';
import { toWafStatement } from './route-pattern-translator';
import {
  LabelMatchScope,
  RouteAction,
  RouteMatchedLabel,
  DefaultCondition,
} from './constants';
import { Headers } from '../../runtime/shared/constants';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Priority gap between rules. Using a gap allows future manual insertion
 * of rules between generated ones without re-numbering everything.
 */
const PRIORITY_GAP = 1;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Translate a complete Route_Config into an ordered list of WAF rules.
 *
 * For each route in the config, and for each policy within that route,
 * a WAF rule is generated that combines:
 * 1. A URI path byte-match statement (from the route's glob pattern)
 * 2. WAF label-match statements for the policy's condition
 *
 * Priorities are assigned sequentially across all routes and policies,
 * ensuring first-match-wins semantics consistent with the Access_Policy
 * list order.
 *
 * @param config - The Route_Config to translate
 * @returns An ordered array of WAF rules ready for the WAF_Rule_Group
 *
 */
export function translateRouteConfig(config: RouteConfig): WafRule[] {
  const rules: WafRule[] = [];
  let priority = PRIORITY_GAP;

  for (let routeIndex = 0; routeIndex < config.routes.length; routeIndex++) {
    const route = config.routes[routeIndex];
    const uriStatement = toWafStatement(route.pattern);

    for (let policyIndex = 0; policyIndex < route.policies.length; policyIndex++) {
      const policy = route.policies[policyIndex];

      const name = buildRuleName(routeIndex, policyIndex, policy.action);
      const baseStatement = buildStatement(uriStatement, policy.condition);
      const action = buildAction(policy.action);

      // Every rule gets scope-down NOT(LabelMatch(x402:route-matched))
      // so that once a request is labeled by an earlier Count rule,
      // all subsequent rules (including block rules) skip it.
      const statement = wrapWithScopeDown(baseStatement);

      const rule: WafRule = {
        name,
        priority,
        statement,
        action,
      };

      // Non-block rules get the route-matched label for scope-down exclusion
      if (action !== 'block') {
        rule.ruleLabels = [RouteMatchedLabel.KEY];
      }

      rules.push(rule);

      priority += PRIORITY_GAP;
    }
  }

  return rules;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a statement with a scope-down NOT LabelMatch so that requests
 * already captured by an earlier Count rule (labeled `x402:route-matched`)
 * are excluded from this rule's evaluation.
 *
 * The resulting statement is:
 *   AND( NOT(LabelMatch(x402:route-matched)), <originalStatement> )
 *
 * If the original statement is already an AND, we flatten its children
 * into the new AND to avoid nested AND-inside-AND, which WAF rejects
 * with WAFInvalidParameterException (nested statement not valid).
 */
function wrapWithScopeDown(originalStatement: WafStatement): WafStatement {
  const notAlreadyMatched: WafStatement = {
    notStatement: {
      statement: {
        labelMatchStatements: [{ scope: LabelMatchScope.LABEL, key: RouteMatchedLabel.KEY }],
      },
    },
  };

  // Flatten: if original is AND, merge its children to avoid AND(NOT, AND(...))
  if (originalStatement.andStatement) {
    return {
      andStatement: {
        statements: [notAlreadyMatched, ...originalStatement.andStatement.statements],
      },
    };
  }

  return {
    andStatement: {
      statements: [notAlreadyMatched, originalStatement],
    },
  };
}

/**
 * Build a descriptive WAF rule name from route/policy indices and action.
 *
 * Format: `route-{routeIndex}-policy-{policyIndex}-{actionType}`
 * where actionType is "block", "free", or "price-{sanitized}"
 */
function buildRuleName(routeIndex: number, policyIndex: number, action: string): string {
  const prefix = `route-${routeIndex}-policy-${policyIndex}`;

  if (action === RouteAction.BLOCK) {
    return `${prefix}-block`;
  }

  if (action === RouteAction.FREE) {
    return `${prefix}-free`;
  }

  // Sanitize price for use in WAF rule name (replace dots with dashes)
  const sanitizedPrice = action.replace(/\./g, '-');
  return `${prefix}-price-${sanitizedPrice}`;
}

/**
 * Recursively translate a ConditionExpression into a WAF statement.
 *
 * - **String** → single `LabelMatchStatement`
 * - **String array** → `AndStatement` of `LabelMatchStatement` entries (AND logic)
 * - **{ and: [...] }** → `AndStatement` of recursively translated sub-conditions
 * - **{ or: [...] }** → `OrStatement` of recursively translated sub-conditions
 * - **{ not: <cond> }** → `NotStatement` wrapping recursively translated sub-condition
 *
 */
function buildConditionStatement(condition: ConditionExpression): WafStatement {
  // String → single LabelMatchStatement
  if (typeof condition === 'string') {
    return { labelMatchStatements: [{ scope: LabelMatchScope.LABEL, key: condition }] };
  }

  // String array → AND of LabelMatchStatements (AND logic)
  if (Array.isArray(condition)) {
    const statements = condition.map(label => ({
      labelMatchStatements: [{ scope: LabelMatchScope.LABEL, key: label }],
    }));
    return { andStatement: { statements } };
  }

  // { namespace: "<value>" } → single LabelMatchStatement with NAMESPACE scope
  if ('namespace' in condition) {
    return { labelMatchStatements: [{ scope: LabelMatchScope.NAMESPACE, key: condition.namespace }] };
  }

  // { and: [...] }
  if ('and' in condition) {
    const statements = condition.and.map(sub => buildConditionStatement(sub));
    return { andStatement: { statements } };
  }

  // { or: [...] }
  if ('or' in condition) {
    const statements = condition.or.map(sub => buildConditionStatement(sub));
    return { orStatement: { statements } };
  }

  // { not: <condition> }
  if ('not' in condition) {
    return { notStatement: { statement: buildConditionStatement(condition.not) } };
  }

  // Should never reach here if validation is correct
  throw new Error('Invalid condition expression');
}

/**
 * Build the composite WAF statement combining URI path matching with
 * optional label condition matching.
 *
 * - **"default" condition**: Only the URI path statement is used
 *   (matches any request to that path).
 * - **Non-default conditions**: AND statement combining URI match + the
 *   translated condition statement from `buildConditionStatement`.
 *
 * The URI statement may be a byte-match or regex-match depending on the
 * glob pattern. Both are passed through as-is since WafStatement already
 * supports both fields.
 */
function buildStatement(
  uriStatement: ReturnType<typeof toWafStatement>,
  condition: ConditionExpression | 'default',
): WafStatement {
  // "default" condition — match any request to this URI path
  if (condition === DefaultCondition.VALUE) {
    return uriStatement;
  }

  // Translate the condition expression into a WAF statement
  const conditionStatement = buildConditionStatement(condition);

  // Combine URI match + condition into an AND statement
  return {
    andStatement: {
      statements: [uriStatement, conditionStatement],
    },
  };
}

/**
 * Build the WAF rule action from the policy action string.
 *
 * - `"block"` → WAF Block action
 * - Any other string (price, including "0") → WAF Allow with InsertHeader
 */
function buildAction(action: string): WafRule['action'] {
  if (action === RouteAction.BLOCK) {
    return RouteAction.BLOCK;
  }

  return {
    insertHeader: {
      name: Headers.ROUTE_ACTION,
      value: action,
    },
  };
}

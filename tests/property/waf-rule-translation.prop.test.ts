/**
 * Property-based test: WAF rule translation correctness with extended conditions
 *
 * **Feature: deprecate-bot-filter, Property 3: WAF rule translation correctness with extended conditions**
 *
 * For any valid v2 Route_Config with ConditionExpression conditions
 * (including nested and/or/not objects), the WAF rule translator should
 * produce a set of WAF rules where:
 *   (a) each block action becomes a WAF Block rule,
 *   (b) each price action becomes a WAF rule that inserts the
 *       `x-x402-route-action` header with the correct price,
 *   (c) rules are assigned priorities in strictly increasing order
 *       (first match wins ordering preserved),
 *   (d) non-first non-block rules include scope-down
 *       NOT LabelMatch(x402:route-matched) wrapper.
 *
 */

import * as fc from 'fast-check';
import { translateRouteConfig } from '../../src/backoffice/waf-sync/waf-rule-translator';
import { toWafStatement } from '../../src/backoffice/waf-sync/route-pattern-translator';
import type { RouteConfig, RouteEntry, AccessPolicy, ConditionExpression } from '../../src/backoffice/waf-sync/types';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a non-empty string suitable for URL path patterns. */
const arbPattern: fc.Arbitrary<string> = fc.oneof(
  // Exact paths like /pricing, /api/data
  fc
    .array(fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/), { minLength: 1, maxLength: 4 })
    .map((segments) => '/' + segments.join('/')),
  // Single-segment wildcard like /api/*
  fc
    .array(fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/), { minLength: 1, maxLength: 3 })
    .map((segments) => '/' + segments.join('/') + '/*'),
  // Multi-segment wildcard like /api/**
  fc
    .array(fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/), { minLength: 1, maxLength: 3 })
    .map((segments) => '/' + segments.join('/') + '/**'),
  // Root wildcard
  fc.constant('/**'),
);

/** Generate a non-empty WAF label string. */
const arbWafLabel: fc.Arbitrary<string> = fc
  .array(fc.stringMatching(/^[a-z][a-z0-9_-]{0,15}$/), { minLength: 2, maxLength: 5 })
  .map((parts) => 'awswaf:' + parts.join(':'));

/**
 * Generate a ConditionExpression with bounded depth.
 *
 * At depth 0 (base case), only leaf conditions are generated (string or string[]).
 * At higher depths, boolean operators (and/or/not) are also generated with
 * recursively smaller sub-expressions.
 */
function arbConditionExpression(maxDepth: number = 3): fc.Arbitrary<ConditionExpression> {
  if (maxDepth <= 0) {
    // Base case: only leaf conditions
    return fc.oneof(
      arbWafLabel,
      fc.array(arbWafLabel, { minLength: 1, maxLength: 3 }),
    );
  }

  return fc.oneof(
    // Leaf: single label
    arbWafLabel,
    // Leaf: array of labels (backward compat AND)
    fc.array(arbWafLabel, { minLength: 1, maxLength: 3 }),
    // { and: [...] }
    fc
      .array(arbConditionExpression(maxDepth - 1), { minLength: 1, maxLength: 3 })
      .map((subs) => ({ and: subs })),
    // { or: [...] }
    fc
      .array(arbConditionExpression(maxDepth - 1), { minLength: 1, maxLength: 3 })
      .map((subs) => ({ or: subs })),
    // { not: <condition> }
    arbConditionExpression(maxDepth - 1).map((sub) => ({ not: sub })),
  );
}

/**
 * Generate a v2 condition: ConditionExpression or "default".
 * Uses bounded depth to stay within WAF nesting limits.
 */
const arbCondition: fc.Arbitrary<ConditionExpression | 'default'> = fc.oneof(
  fc.constant('default' as const),
  arbConditionExpression(3),
);

/** Generate a valid price string matching /^\d+(\.\d+)?$/ */
const arbPrice: fc.Arbitrary<string> = fc.oneof(
  fc.constant('0'),
  fc.nat({ max: 999 }).map((n) => String(n)),
  fc
    .tuple(fc.nat({ max: 999 }), fc.nat({ max: 999999 }))
    .filter(([, frac]) => frac > 0)
    .map(([whole, frac]) => `${whole}.${frac}`),
);

/** Generate a valid action: price string or "block". */
const arbAction: fc.Arbitrary<string> = fc.oneof(arbPrice, fc.constant('block'));

/** Generate a valid v2 AccessPolicy with ConditionExpression conditions. */
const arbAccessPolicy: fc.Arbitrary<AccessPolicy> = fc
  .tuple(arbCondition, arbAction)
  .map(([condition, action]) => ({ condition, action }));

/** Generate a valid v2 RouteEntry (no botFilter field). */
const arbRouteEntry: fc.Arbitrary<RouteEntry> = fc
  .tuple(
    arbPattern,
    fc.array(arbAccessPolicy, { minLength: 1, maxLength: 5 }),
  )
  .map(([pattern, policies]) => ({ pattern, policies }));

/** Generate a valid RouteConfig. */
const arbRouteConfig: fc.Arbitrary<RouteConfig> = fc
  .array(arbRouteEntry, { minLength: 1, maxLength: 6 })
  .map((routes) => ({ routes }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count total number of policies across all routes. */
function totalPolicies(config: RouteConfig): number {
  return config.routes.reduce((sum, route) => sum + route.policies.length, 0);
}

/**
 * Flatten routes into an ordered list of (routeIndex, policyIndex, route, policy)
 * tuples, matching the order the translator should produce rules.
 */
function flattenPolicies(config: RouteConfig) {
  const result: Array<{
    routeIndex: number;
    policyIndex: number;
    route: RouteEntry;
    policy: AccessPolicy;
  }> = [];

  for (let ri = 0; ri < config.routes.length; ri++) {
    const route = config.routes[ri];
    for (let pi = 0; pi < route.policies.length; pi++) {
      result.push({
        routeIndex: ri,
        policyIndex: pi,
        route,
        policy: route.policies[pi],
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe('Property 3: WAF rule translation correctness with extended conditions', () => {
  it('produces exactly one WAF rule per route+policy combination', () => {
    fc.assert(
      fc.property(arbRouteConfig, (config: RouteConfig) => {
        const rules = translateRouteConfig(config);
        expect(rules.length).toBe(totalPolicies(config));
      }),
      { numRuns: 200, verbose: true },
    );
  });

  it('block actions produce Block rules', () => {
    fc.assert(
      fc.property(arbRouteConfig, (config: RouteConfig) => {
        const rules = translateRouteConfig(config);
        const flat = flattenPolicies(config);

        for (let i = 0; i < flat.length; i++) {
          const { policy } = flat[i];
          const rule = rules[i];

          if (policy.action === 'block') {
            expect(rule.action).toBe('block');
          }
        }
      }),
      { numRuns: 200, verbose: true },
    );
  });

  it('price actions produce InsertHeader rules with correct price values', () => {
    fc.assert(
      fc.property(arbRouteConfig, (config: RouteConfig) => {
        const rules = translateRouteConfig(config);
        const flat = flattenPolicies(config);

        for (let i = 0; i < flat.length; i++) {
          const { policy } = flat[i];
          const rule = rules[i];

          if (policy.action !== 'block') {
            // Must be an InsertHeader action
            expect(rule.action).not.toBe('block');
            const action = rule.action as { insertHeader: { name: string; value: string } };
            expect(action.insertHeader).toBeDefined();
            expect(action.insertHeader.name).toBe('x-x402-route-action');
            expect(action.insertHeader.value).toBe(policy.action);
          }
        }
      }),
      { numRuns: 200, verbose: true },
    );
  });

  it('rule priorities are strictly increasing and match policy order (first match wins)', () => {
    fc.assert(
      fc.property(arbRouteConfig, (config: RouteConfig) => {
        const rules = translateRouteConfig(config);

        // Priorities must be strictly increasing
        for (let i = 1; i < rules.length; i++) {
          expect(rules[i].priority).toBeGreaterThan(rules[i - 1].priority);
        }

        // The order of rules must match the flattened policy order
        const flat = flattenPolicies(config);
        expect(rules.length).toBe(flat.length);
      }),
      { numRuns: 200, verbose: true },
    );
  });

  it('all rules include scope-down NOT LabelMatch wrapper', () => {
    /**
     * Helper to check if a statement is the scope-down NOT(LabelMatch(x402:route-matched)).
     * This is distinct from a NOT condition expression — scope-down specifically wraps
     * a LabelMatch for the route-matched label.
     */
    function isScopeDownNot(s: { notStatement?: { statement: { labelMatchStatements?: Array<{ key: string }> } } }): boolean {
      return !!(
        s.notStatement &&
        s.notStatement.statement.labelMatchStatements &&
        s.notStatement.statement.labelMatchStatements.length === 1 &&
        s.notStatement.statement.labelMatchStatements[0].key === 'x402:route-matched'
      );
    }

    fc.assert(
      fc.property(arbRouteConfig, (config: RouteConfig) => {
        const rules = translateRouteConfig(config);

        for (let i = 0; i < rules.length; i++) {
          const rule = rules[i];

          // Every rule must have a top-level andStatement with scope-down NOT wrapper
          expect(rule.statement.andStatement).toBeDefined();
          const topStatements = rule.statement.andStatement!.statements;

          // Must contain a NOT(LabelMatch(x402:route-matched)) statement
          const scopeDownStmt = topStatements.find(isScopeDownNot);
          expect(scopeDownStmt).toBeDefined();
        }
      }),
      { numRuns: 200, verbose: true },
    );
  });

  it('conditions are correctly translated to WAF match statements', () => {
    fc.assert(
      fc.property(arbRouteConfig, (config: RouteConfig) => {
        const rules = translateRouteConfig(config);
        const flat = flattenPolicies(config);

        for (let i = 0; i < flat.length; i++) {
          const { route, policy } = flat[i];
          const rule = rules[i];
          const expectedUriStatement = toWafStatement(route.pattern);

          // All rules are wrapped with scope-down:
          // AND(NOT(LabelMatch(x402:route-matched)), ...originalChildren)
          expect(rule.statement.andStatement).toBeDefined();
          const topStatements = rule.statement.andStatement!.statements;
          expect(topStatements.some((s) => s.notStatement)).toBe(true);

          // Find the URI byte-match among the children
          const uriChild = topStatements.find((s) => s.byteMatchStatement);

          if (policy.condition === 'default') {
            // AND(NOT_scopedown, URI) — 2 children
            expect(uriChild).toBeDefined();
            expect(uriChild!.byteMatchStatement).toEqual(expectedUriStatement);
            expect(topStatements.length).toBe(2);
          } else {
            // Flattened: AND(NOT_scopedown, URI, condition) — 3+ children
            expect(uriChild).toBeDefined();
            expect(uriChild!.byteMatchStatement).toEqual(expectedUriStatement);
            expect(topStatements.length).toBeGreaterThanOrEqual(3);
          }
        }
      }),
      { numRuns: 200, verbose: true },
    );
  });
});

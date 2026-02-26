/**
 * Property-based test: Route_Config v2 round-trip serialization
 *
 * **Feature: deprecate-bot-filter, Property 2: Route config round-trip serialization**
 *
 * For any valid v2 Route_Config object with ConditionExpression conditions
 * (including nested and/or/not objects), serializing it to JSON and then
 * parsing it back via parseRouteConfig should produce a deep-equal
 * RouteConfig object. This validates that the validator correctly accepts
 * all valid v2 condition formats and that no data is lost during serialization.
 *
 */

import * as fc from 'fast-check';
import { parseRouteConfig } from '../../src/backoffice/waf-sync/route-config-validator';
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
const arbV2Condition: fc.Arbitrary<ConditionExpression | 'default'> = fc.oneof(
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
  .tuple(arbV2Condition, arbAction)
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
// Property Test
// ---------------------------------------------------------------------------

describe('Property 2: Route config round-trip serialization', () => {
  it('serializing a RouteConfig to JSON and parsing it back produces a deep-equal RouteConfig', () => {
    fc.assert(
      fc.property(arbRouteConfig, (config: RouteConfig) => {
        // Serialize to JSON
        const json = JSON.stringify(config);

        // Parse back via the parseRouteConfig function
        const result = parseRouteConfig(json);

        // Must succeed
        expect(result.success).toBe(true);
        if (!result.success) {
          throw new Error(`parseRouteConfig failed: ${result.error}`);
        }

        // Deep equality
        expect(result.config).toEqual(config);
      }),
      { numRuns: 200, verbose: true },
    );
  });

  it('parseRouteConfig round-trip: parse a RouteConfig, re-serialize, re-parse, assert equality', () => {
    fc.assert(
      fc.property(arbRouteConfig, (config: RouteConfig) => {
        // First parse pass
        const json1 = JSON.stringify(config);
        const result1 = parseRouteConfig(json1);
        expect(result1.success).toBe(true);
        if (!result1.success) {
          throw new Error(`First parse failed: ${result1.error}`);
        }

        // Re-serialize the parsed config and parse again
        const json2 = JSON.stringify(result1.config);
        const result2 = parseRouteConfig(json2);
        expect(result2.success).toBe(true);
        if (!result2.success) {
          throw new Error(`Second parse failed: ${result2.error}`);
        }

        // Both parsed configs should be deep-equal
        expect(result2.config).toEqual(result1.config);
      }),
      { numRuns: 200, verbose: true },
    );
  });
});

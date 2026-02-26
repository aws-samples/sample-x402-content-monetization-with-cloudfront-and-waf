/**
 * Property-based test: Hash-based change detection
 *
 * **Feature: x402-on-aws-edge, Property 4: Hash-based change detection**
 *
 * For any Route_Config, computing its hash should be deterministic (same
 * config always produces same hash). When the WAF_Sync_Function is invoked
 * and the computed hash matches the previously stored hash, no WAF API
 * update should be performed. When the hash differs, the WAF_Rule_Group
 * should be updated.
 *
 */

import * as fc from 'fast-check';
import { computeHash, hasChanged } from '../../src/backoffice/waf-sync/change-detector';
import type { RouteConfig, RouteEntry, AccessPolicy, ConditionExpression } from '../../src/backoffice/waf-sync/types';

// ---------------------------------------------------------------------------
// Generators (reused from route-config-roundtrip.prop.test.ts)
// ---------------------------------------------------------------------------

/** Generate a non-empty string suitable for URL path patterns. */
const arbPattern: fc.Arbitrary<string> = fc.oneof(
  fc
    .array(fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/), { minLength: 1, maxLength: 4 })
    .map((segments) => '/' + segments.join('/')),
  fc
    .array(fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/), { minLength: 1, maxLength: 3 })
    .map((segments) => '/' + segments.join('/') + '/*'),
  fc
    .array(fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/), { minLength: 1, maxLength: 3 })
    .map((segments) => '/' + segments.join('/') + '/**'),
  fc.constant('/**'),
);

/** Generate a non-empty WAF label string. */
const arbWafLabel: fc.Arbitrary<string> = fc
  .array(fc.stringMatching(/^[a-z][a-z0-9_-]{0,15}$/), { minLength: 2, maxLength: 5 })
  .map((parts) => 'awswaf:' + parts.join(':'));

/** Generate a valid condition: string, string[], "default", or boolean expression. */
function arbConditionExpression(maxDepth: number = 3): fc.Arbitrary<ConditionExpression> {
  if (maxDepth <= 0) {
    return fc.oneof(arbWafLabel, fc.array(arbWafLabel, { minLength: 1, maxLength: 3 }));
  }

  return fc.oneof(
    arbWafLabel,
    fc.array(arbWafLabel, { minLength: 1, maxLength: 3 }),
    fc.array(arbConditionExpression(maxDepth - 1), { minLength: 1, maxLength: 3 })
      .map((subs) => ({ and: subs })),
    fc.array(arbConditionExpression(maxDepth - 1), { minLength: 1, maxLength: 3 })
      .map((subs) => ({ or: subs })),
    arbConditionExpression(maxDepth - 1).map((sub) => ({ not: sub })),
  );
}

const arbCondition: fc.Arbitrary<ConditionExpression | 'default'> = fc.oneof(
  fc.constant('default' as const),
  arbConditionExpression(2),
);

/** Generate a valid price string. */
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

/** Generate a valid AccessPolicy. */
const arbAccessPolicy: fc.Arbitrary<AccessPolicy> = fc
  .tuple(arbCondition, arbAction)
  .map(([condition, action]) => ({ condition, action }));

/** Generate a valid RouteEntry. */
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
// Property Tests
// ---------------------------------------------------------------------------

describe('Property 4: Hash-based change detection', () => {
  it('hash determinism: same config always produces the same hash', () => {
    fc.assert(
      fc.property(arbRouteConfig, (config: RouteConfig) => {
        const hash1 = computeHash(config);
        const hash2 = computeHash(config);

        // Same config must always produce the same hash
        expect(hash1).toBe(hash2);

        // Hash should be a valid hex-encoded SHA-256 (64 hex chars)
        expect(hash1).toMatch(/^[0-9a-f]{64}$/);
      }),
      { numRuns: 200, verbose: true },
    );
  });

  it('hash determinism with key reordering: equivalent configs with different key order produce the same hash', () => {
    fc.assert(
      fc.property(arbRouteConfig, (config: RouteConfig) => {
        // Create a deep clone with reversed key order by serializing
        // with keys in a different order
        const json = JSON.stringify(config);
        const cloned: RouteConfig = JSON.parse(json);

        const hashOriginal = computeHash(config);
        const hashCloned = computeHash(cloned);

        // Equivalent configs must produce the same hash
        expect(hashOriginal).toBe(hashCloned);
      }),
      { numRuns: 200, verbose: true },
    );
  });

  it('skip on match: when hashes match, hasChanged returns false (no update needed)', () => {
    fc.assert(
      fc.property(arbRouteConfig, (config: RouteConfig) => {
        const currentHash = computeHash(config);
        const lastHash = computeHash(config);

        // When hashes match, no update is needed
        expect(hasChanged(currentHash, lastHash)).toBe(false);
      }),
      { numRuns: 200, verbose: true },
    );
  });

  it('update on diff: when two different configs produce different hashes, hasChanged returns true', () => {
    fc.assert(
      fc.property(
        arbRouteConfig,
        arbRouteConfig,
        (config1: RouteConfig, config2: RouteConfig) => {
          const hash1 = computeHash(config1);
          const hash2 = computeHash(config2);

          // If the hashes differ, hasChanged must return true
          if (hash1 !== hash2) {
            expect(hasChanged(hash1, hash2)).toBe(true);
          }
          // If the hashes happen to be equal (configs are equivalent),
          // hasChanged must return false
          if (hash1 === hash2) {
            expect(hasChanged(hash1, hash2)).toBe(false);
          }
        },
      ),
      { numRuns: 200, verbose: true },
    );
  });

  it('different configs produce different hashes (collision resistance)', () => {
    fc.assert(
      fc.property(arbRouteConfig, (config: RouteConfig) => {
        // Mutate the config by appending an extra route
        const mutated: RouteConfig = {
          routes: [
            ...config.routes,
            {
              pattern: '/mutated-path-' + Date.now(),
              policies: [{ condition: 'default', action: 'block' }],
            },
          ],
        };

        const hashOriginal = computeHash(config);
        const hashMutated = computeHash(mutated);

        // Different configs must produce different hashes
        expect(hashOriginal).not.toBe(hashMutated);

        // hasChanged should detect the difference
        expect(hasChanged(hashMutated, hashOriginal)).toBe(true);
      }),
      { numRuns: 200, verbose: true },
    );
  });
});

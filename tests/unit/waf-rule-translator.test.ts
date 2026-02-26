/**
 * Unit tests for the WAF rule translator.
 *
 * Tests the translation of Route_Config into WAF rules, covering:
 * - Block actions → WAF Block rules
 * - Price actions → WAF Allow rules with InsertHeader
 * - Free ("0") actions → WAF Allow rules with InsertHeader value "0"
 * - Single label conditions, multi-label conditions, and "default" conditions
 * - Priority ordering (route order then policy order, first match wins)
 * - Rule naming conventions
 * - Boolean condition translation (and, or, not, nested)
 *
 */

import { translateRouteConfig } from '../../src/backoffice/waf-sync/waf-rule-translator';
import type { RouteConfig } from '../../src/backoffice/waf-sync/types';

describe('translateRouteConfig', () => {
  describe('empty config', () => {
    it('should return an empty array for a config with no routes', () => {
      const config: RouteConfig = { routes: [] };
      const rules = translateRouteConfig(config);
      expect(rules).toEqual([]);
    });
  });

  describe('block actions', () => {
    it('should produce a Block rule for a block action', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/*',
            policies: [{ condition: 'default', action: 'block' }],
          },
        ],
      };

      const rules = translateRouteConfig(config);

      expect(rules).toHaveLength(1);
      expect(rules[0].action).toBe('block');
      expect(rules[0].name).toContain('block');
    });
  });

  describe('price actions', () => {
    it('should produce an InsertHeader rule for a price action', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/*',
            policies: [
              { condition: 'awswaf:managed:aws:bot-control:bot:verified', action: '0.001' },
            ],
          },
        ],
      };

      const rules = translateRouteConfig(config);

      expect(rules).toHaveLength(1);
      expect(rules[0].action).toEqual({
        insertHeader: { name: 'x-x402-route-action', value: '0.001' },
      });
    });

    it('should produce an InsertHeader rule with value "0" for free access', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/articles/**',
            policies: [{ condition: 'default', action: '0' }],
          },
        ],
      };

      const rules = translateRouteConfig(config);

      expect(rules).toHaveLength(1);
      expect(rules[0].action).toEqual({
        insertHeader: { name: 'x-x402-route-action', value: '0' },
      });
    });
  });

  describe('condition handling', () => {
    it('should use only URI match statement for "default" condition (wrapped with scope-down)', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/*',
            policies: [{ condition: 'default', action: '0.01' }],
          },
        ],
      };

      const rules = translateRouteConfig(config);
      const stmt = rules[0].statement;

      // All rules get scope-down: AND(NOT(route-matched), regexMatch)
      expect(stmt.andStatement).toBeDefined();
      expect(stmt.andStatement!.statements).toHaveLength(2);
      expect(stmt.andStatement!.statements[0].notStatement).toBeDefined();
      expect(stmt.andStatement!.statements[1].regexMatchStatement).toBeDefined();
    });

    it('should combine URI match + single label match in an AND statement', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/*',
            policies: [
              { condition: 'awswaf:managed:aws:bot-control:bot:verified', action: '0.001' },
            ],
          },
        ],
      };

      const rules = translateRouteConfig(config);
      const stmt = rules[0].statement;

      // All rules get scope-down: AND(NOT(route-matched), URI, label)
      expect(stmt.andStatement).toBeDefined();
      expect(stmt.andStatement!.statements).toHaveLength(3);

      // First: NOT scope-down
      expect(stmt.andStatement!.statements[0].notStatement).toBeDefined();

      // Second: URI regex-match (single-segment wildcard uses regex)
      expect(stmt.andStatement!.statements[1].regexMatchStatement).toBeDefined();
      expect(stmt.andStatement!.statements[1].regexMatchStatement!.regexString).toBe('^/api/[^/]*$');

      // Third: label match
      expect(stmt.andStatement!.statements[2].labelMatchStatements).toBeDefined();
      expect(stmt.andStatement!.statements[2].labelMatchStatements![0].key).toBe(
        'awswaf:managed:aws:bot-control:bot:verified',
      );
      expect(stmt.andStatement!.statements[2].labelMatchStatements![0].scope).toBe('LABEL');
    });

    it('should combine URI match + multiple label matches for array conditions', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/*',
            policies: [
              {
                condition: [
                  'awswaf:managed:aws:bot-control:bot:verified',
                  'awswaf:managed:aws:bot-control:bot:category:ai',
                ],
                action: '0.005',
              },
            ],
          },
        ],
      };

      const rules = translateRouteConfig(config);
      const stmt = rules[0].statement;

      // All rules get scope-down: AND(NOT(route-matched), URI, conditionStatement)
      expect(stmt.andStatement).toBeDefined();
      expect(stmt.andStatement!.statements).toHaveLength(3);

      // First: NOT scope-down
      expect(stmt.andStatement!.statements[0].notStatement).toBeDefined();

      // Second: URI regex-match (single-segment wildcard)
      expect(stmt.andStatement!.statements[1].regexMatchStatement).toBeDefined();

      // Third: AND of label matches from buildConditionStatement
      const conditionStmt = stmt.andStatement!.statements[2];
      expect(conditionStmt.andStatement).toBeDefined();
      expect(conditionStmt.andStatement!.statements).toHaveLength(2);
      expect(conditionStmt.andStatement!.statements[0].labelMatchStatements![0].key).toBe(
        'awswaf:managed:aws:bot-control:bot:verified',
      );
      expect(conditionStmt.andStatement!.statements[1].labelMatchStatements![0].key).toBe(
        'awswaf:managed:aws:bot-control:bot:category:ai',
      );
    });
  });

  describe('priority ordering', () => {
    it('should assign priorities in route order then policy order', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/*',
            policies: [
              { condition: 'awswaf:managed:aws:bot-control:bot:verified', action: '0.001' },
              { condition: 'default', action: 'block' },
            ],
          },
          {
            pattern: '/articles/**',
            policies: [
              { condition: 'awswaf:managed:aws:bot-control:bot:verified', action: '0.005' },
              { condition: 'default', action: '0.01' },
            ],
          },
        ],
      };

      const rules = translateRouteConfig(config);

      expect(rules).toHaveLength(4);
      // Priorities should be strictly increasing
      expect(rules[0].priority).toBeLessThan(rules[1].priority);
      expect(rules[1].priority).toBeLessThan(rules[2].priority);
      expect(rules[2].priority).toBeLessThan(rules[3].priority);
    });

    it('should maintain first-match-wins semantics across routes', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/*',
            policies: [{ condition: 'default', action: '0.001' }],
          },
          {
            pattern: '/api/premium/**',
            policies: [{ condition: 'default', action: '0.01' }],
          },
        ],
      };

      const rules = translateRouteConfig(config);

      // First route's rule should have lower priority (evaluated first)
      expect(rules[0].priority).toBeLessThan(rules[1].priority);
      // Both rules wrapped with scope-down: AND(NOT(route-matched), uriMatch)
      const firstRegex = rules[0].statement.andStatement!.statements.find((s) => s.regexMatchStatement);
      expect(firstRegex!.regexMatchStatement!.regexString).toBe('^/api/[^/]*$');
      const secondByteMatch = rules[1].statement.andStatement!.statements.find((s) => s.byteMatchStatement);
      expect(secondByteMatch!.byteMatchStatement!.searchString).toBe('/api/premium/');
    });
  });

  describe('rule naming', () => {
    it('should name block rules with "-block" suffix', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/*',
            policies: [{ condition: 'default', action: 'block' }],
          },
        ],
      };

      const rules = translateRouteConfig(config);
      expect(rules[0].name).toBe('route-0-policy-0-block');
    });

    it('should name free rules with "-free" suffix', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/*',
            policies: [{ condition: 'default', action: '0' }],
          },
        ],
      };

      const rules = translateRouteConfig(config);
      expect(rules[0].name).toBe('route-0-policy-0-free');
    });

    it('should name price rules with sanitized price', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/*',
            policies: [{ condition: 'default', action: '0.001' }],
          },
        ],
      };

      const rules = translateRouteConfig(config);
      expect(rules[0].name).toBe('route-0-policy-0-price-0-001');
    });
  });

  describe('URI path matching integration', () => {
    it('should use RegexMatch for single-segment wildcard patterns', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/*',
            policies: [{ condition: 'default', action: '0.001' }],
          },
        ],
      };

      const rules = translateRouteConfig(config);
      // All rules wrapped: AND(NOT(route-matched), regexMatch)
      const regexMatch = rules[0].statement.andStatement!.statements.find((s) => s.regexMatchStatement)!.regexMatchStatement!;

      expect(regexMatch.regexString).toBe('^/api/[^/]*$');
    });

    it('should use EXACTLY for exact path patterns', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/pricing',
            policies: [{ condition: 'default', action: '0.01' }],
          },
        ],
      };

      const rules = translateRouteConfig(config);
      const byteMatch = rules[0].statement.andStatement!.statements.find((s) => s.byteMatchStatement)!.byteMatchStatement!;

      expect(byteMatch.positionalConstraint).toBe('EXACTLY');
      expect(byteMatch.searchString).toBe('/pricing');
    });
  });

  describe('complex multi-route config', () => {
    it('should correctly translate the default route config template', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/**',
            policies: [
              { condition: 'awswaf:managed:aws:bot-control:bot:verified', action: '0.001' },
              { condition: 'awswaf:managed:aws:bot-control:bot:unverified', action: '0.01' },
              { condition: 'default', action: '0' },
            ],
          },
        ],
      };

      const rules = translateRouteConfig(config);

      expect(rules).toHaveLength(3);

      // Rule 1: verified bot → price 0.001
      expect(rules[0].action).toEqual({
        insertHeader: { name: 'x-x402-route-action', value: '0.001' },
      });

      // Rule 2: unverified bot → price 0.01
      expect(rules[1].action).toEqual({
        insertHeader: { name: 'x-x402-route-action', value: '0.01' },
      });

      // Rule 3: default → free
      expect(rules[2].action).toEqual({
        insertHeader: { name: 'x-x402-route-action', value: '0' },
      });

      // Priorities are strictly increasing
      expect(rules[0].priority).toBeLessThan(rules[1].priority);
      expect(rules[1].priority).toBeLessThan(rules[2].priority);
    });

    it('should correctly translate a mixed block/price config', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/*',
            policies: [
              { condition: 'awswaf:managed:aws:bot-control:bot:verified', action: '0.001' },
              { condition: 'default', action: 'block' },
            ],
          },
          {
            pattern: '/articles/**',
            policies: [
              { condition: 'awswaf:managed:aws:bot-control:bot:verified', action: '0.005' },
              {
                condition: 'awswaf:managed:aws:bot-control:bot:category:search_engine',
                action: '0',
              },
              { condition: 'default', action: '0.01' },
            ],
          },
        ],
      };

      const rules = translateRouteConfig(config);

      expect(rules).toHaveLength(5);

      // Route 0, Policy 0: verified bot → price 0.001
      expect(rules[0].action).toEqual({
        insertHeader: { name: 'x-x402-route-action', value: '0.001' },
      });

      // Route 0, Policy 1: default → block
      expect(rules[1].action).toBe('block');

      // Route 1, Policy 0: verified bot → price 0.005
      expect(rules[2].action).toEqual({
        insertHeader: { name: 'x-x402-route-action', value: '0.005' },
      });

      // Route 1, Policy 1: search engine → free
      expect(rules[3].action).toEqual({
        insertHeader: { name: 'x-x402-route-action', value: '0' },
      });

      // Route 1, Policy 2: default → price 0.01
      expect(rules[4].action).toEqual({
        insertHeader: { name: 'x-x402-route-action', value: '0.01' },
      });

      // All priorities strictly increasing
      for (let i = 1; i < rules.length; i++) {
        expect(rules[i].priority).toBeGreaterThan(rules[i - 1].priority);
      }
    });
  });

  describe('boolean conditions in full route config — translateRouteConfig', () => {
    it('should produce a Block rule for a block action with an AND boolean condition', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/*',
            policies: [
              {
                condition: {
                  and: [
                    'awswaf:managed:aws:bot-control:bot:verified',
                    'awswaf:managed:aws:bot-control:bot:name:gptbot',
                  ],
                },
                action: 'block',
              },
            ],
          },
        ],
      };

      const rules = translateRouteConfig(config);

      expect(rules).toHaveLength(1);
      expect(rules[0].action).toBe('block');
      expect(rules[0].name).toContain('block');

      // All rules get scope-down: AND(NOT(route-matched), URI, AND(label1, label2))
      const stmt = rules[0].statement;
      expect(stmt.andStatement).toBeDefined();
      expect(stmt.andStatement!.statements).toHaveLength(3);
      // First: NOT scope-down
      expect(stmt.andStatement!.statements[0].notStatement).toBeDefined();
      // Second: URI regex-match (single-segment wildcard)
      expect(stmt.andStatement!.statements[1].regexMatchStatement).toBeDefined();
      // Third: AND of labels from buildConditionStatement
      const condStmt = stmt.andStatement!.statements[2];
      expect(condStmt.andStatement).toBeDefined();
      expect(condStmt.andStatement!.statements).toHaveLength(2);
    });

    it('should produce a Block rule for a block action with a NOT boolean condition', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/*',
            policies: [
              {
                condition: { not: 'awswaf:managed:aws:bot-control:bot:verified' },
                action: 'block',
              },
            ],
          },
        ],
      };

      const rules = translateRouteConfig(config);

      expect(rules).toHaveLength(1);
      expect(rules[0].action).toBe('block');

      // All rules get scope-down: AND(NOT(route-matched), URI, NOT(label))
      const stmt = rules[0].statement;
      expect(stmt.andStatement).toBeDefined();
      expect(stmt.andStatement!.statements).toHaveLength(3);
      expect(stmt.andStatement!.statements[0].notStatement).toBeDefined(); // scope-down
      expect(stmt.andStatement!.statements[1].regexMatchStatement).toBeDefined();
      const condStmt = stmt.andStatement!.statements[2];
      expect(condStmt.notStatement).toBeDefined();
      expect(condStmt.notStatement!.statement.labelMatchStatements![0].key).toBe(
        'awswaf:managed:aws:bot-control:bot:verified',
      );
    });

    it('should produce a Block rule for a block action with an OR boolean condition', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/*',
            policies: [
              {
                condition: {
                  or: [
                    'awswaf:managed:aws:bot-control:bot:name:gptbot',
                    'awswaf:managed:aws:bot-control:bot:name:claudebot',
                  ],
                },
                action: 'block',
              },
            ],
          },
        ],
      };

      const rules = translateRouteConfig(config);

      expect(rules).toHaveLength(1);
      expect(rules[0].action).toBe('block');

      // All rules get scope-down: AND(NOT(route-matched), URI, OR(label1, label2))
      const stmt = rules[0].statement;
      expect(stmt.andStatement).toBeDefined();
      expect(stmt.andStatement!.statements).toHaveLength(3);
      expect(stmt.andStatement!.statements[0].notStatement).toBeDefined(); // scope-down
      expect(stmt.andStatement!.statements[1].regexMatchStatement).toBeDefined();
      const condStmt = stmt.andStatement!.statements[2];
      expect(condStmt.orStatement).toBeDefined();
      expect(condStmt.orStatement!.statements).toHaveLength(2);
    });

    it('should correctly translate the v2 example config with AND+OR, NOT, and default', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/premium/**',
            policies: [
              {
                condition: {
                  and: [
                    'awswaf:managed:aws:bot-control:bot:verified',
                    {
                      or: [
                        'awswaf:managed:aws:bot-control:bot:name:gptbot',
                        'awswaf:managed:aws:bot-control:bot:name:claudebot',
                      ],
                    },
                  ],
                },
                action: '0.01',
              },
              {
                condition: 'awswaf:managed:aws:bot-control:bot:verified',
                action: '0.002',
              },
              {
                condition: 'default',
                action: 'block',
              },
            ],
          },
          {
            pattern: '/**',
            policies: [
              {
                condition: 'awswaf:managed:aws:bot-control:bot:verified',
                action: '0.002',
              },
              {
                condition: { not: 'awswaf:managed:aws:bot-control:bot:unverified' },
                action: '0',
              },
              {
                condition: 'default',
                action: '0',
              },
            ],
          },
        ],
      };

      const rules = translateRouteConfig(config);

      expect(rules).toHaveLength(6);

      // Route 0, Policy 0: AND(verified, OR(gptbot, claudebot)) → price 0.01
      expect(rules[0].action).toEqual({
        insertHeader: { name: 'x-x402-route-action', value: '0.01' },
      });
      // All rules get scope-down: AND(NOT(route-matched), URI, condition...)
      const rule0Stmt = rules[0].statement.andStatement!.statements;
      expect(rule0Stmt[0].notStatement).toBeDefined(); // scope-down
      expect(rule0Stmt[1].byteMatchStatement).toBeDefined();
      const rule0Cond = rule0Stmt[2];
      expect(rule0Cond.andStatement).toBeDefined();
      expect(rule0Cond.andStatement!.statements[1].orStatement).toBeDefined();

      // Route 0, Policy 1: verified → price 0.002
      expect(rules[1].action).toEqual({
        insertHeader: { name: 'x-x402-route-action', value: '0.002' },
      });

      // Route 0, Policy 2: default → block
      expect(rules[2].action).toBe('block');

      // Route 1, Policy 0: verified → price 0.002
      expect(rules[3].action).toEqual({
        insertHeader: { name: 'x-x402-route-action', value: '0.002' },
      });

      // Route 1, Policy 1: NOT(unverified) → free
      expect(rules[4].action).toEqual({
        insertHeader: { name: 'x-x402-route-action', value: '0' },
      });

      // Route 1, Policy 2: default → free
      expect(rules[5].action).toEqual({
        insertHeader: { name: 'x-x402-route-action', value: '0' },
      });

      // All priorities strictly increasing
      for (let i = 1; i < rules.length; i++) {
        expect(rules[i].priority).toBeGreaterThan(rules[i - 1].priority);
      }
    });

    it('should produce correct WAF rules for a route config with namespace condition', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/*',
            policies: [
              {
                condition: { namespace: 'awswaf:managed:aws:bot-control:bot:name:' },
                action: '0.01',
              },
              {
                condition: 'default',
                action: 'block',
              },
            ],
          },
        ],
      };

      const rules = translateRouteConfig(config);

      expect(rules).toHaveLength(2);

      // Rule 0: namespace condition → price 0.01
      expect(rules[0].action).toEqual({
        insertHeader: { name: 'x-x402-route-action', value: '0.01' },
      });

      // All rules get scope-down: AND(NOT(route-matched), URI, namespace-label-match)
      const stmt = rules[0].statement;
      expect(stmt.andStatement).toBeDefined();
      expect(stmt.andStatement!.statements).toHaveLength(3);
      // First: NOT scope-down
      expect(stmt.andStatement!.statements[0].notStatement).toBeDefined();
      // Second: URI regex-match (single-segment wildcard)
      expect(stmt.andStatement!.statements[1].regexMatchStatement).toBeDefined();
      // Third: namespace label match with NAMESPACE scope
      const condStmt = stmt.andStatement!.statements[2];
      expect(condStmt.labelMatchStatements).toBeDefined();
      expect(condStmt.labelMatchStatements).toHaveLength(1);
      expect(condStmt.labelMatchStatements![0].scope).toBe('NAMESPACE');
      expect(condStmt.labelMatchStatements![0].key).toBe('awswaf:managed:aws:bot-control:bot:name:');

      // Rule 1: default → block
      expect(rules[1].action).toBe('block');
    });

    it('should translate the motivating example: namespace match replacing OR of specific bot names', () => {
      // Before namespace support, users had to enumerate each bot name:
      //   { or: ["awswaf:...bot:name:gptbot", "awswaf:...bot:name:claudebot", ...] }
      // With namespace support, a single namespace condition replaces the entire OR:
      //   { namespace: "awswaf:managed:aws:bot-control:bot:name:" }
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/premium/**',
            policies: [
              {
                condition: {
                  and: [
                    'awswaf:managed:aws:bot-control:bot:verified',
                    { namespace: 'awswaf:managed:aws:bot-control:bot:name:' },
                  ],
                },
                action: '0.01',
              },
              {
                condition: 'awswaf:managed:aws:bot-control:bot:verified',
                action: '0.002',
              },
              {
                condition: 'default',
                action: 'block',
              },
            ],
          },
        ],
      };

      const rules = translateRouteConfig(config);

      expect(rules).toHaveLength(3);

      // Rule 0: AND(verified, namespace:bot:name:) → price 0.01
      expect(rules[0].action).toEqual({
        insertHeader: { name: 'x-x402-route-action', value: '0.01' },
      });

      // Verify the condition structure: AND(NOT(route-matched), URI, AND(label, namespace))
      const stmt = rules[0].statement;
      expect(stmt.andStatement).toBeDefined();
      expect(stmt.andStatement!.statements).toHaveLength(3);
      expect(stmt.andStatement!.statements[0].notStatement).toBeDefined(); // scope-down
      expect(stmt.andStatement!.statements[1].byteMatchStatement).toBeDefined(); // URI

      // The condition AND: verified (LABEL) + namespace (NAMESPACE)
      const condStmt = stmt.andStatement!.statements[2];
      expect(condStmt.andStatement).toBeDefined();
      expect(condStmt.andStatement!.statements).toHaveLength(2);

      // First: verified label with LABEL scope
      expect(condStmt.andStatement!.statements[0].labelMatchStatements![0].scope).toBe('LABEL');
      expect(condStmt.andStatement!.statements[0].labelMatchStatements![0].key).toBe(
        'awswaf:managed:aws:bot-control:bot:verified',
      );

      // Second: namespace match with NAMESPACE scope
      expect(condStmt.andStatement!.statements[1].labelMatchStatements![0].scope).toBe('NAMESPACE');
      expect(condStmt.andStatement!.statements[1].labelMatchStatements![0].key).toBe(
        'awswaf:managed:aws:bot-control:bot:name:',
      );

      // Rule 1: verified → price 0.002
      expect(rules[1].action).toEqual({
        insertHeader: { name: 'x-x402-route-action', value: '0.002' },
      });

      // Rule 2: default → block
      expect(rules[2].action).toBe('block');

      // All priorities strictly increasing
      for (let i = 1; i < rules.length; i++) {
        expect(rules[i].priority).toBeGreaterThan(rules[i - 1].priority);
      }
    });

    it('should apply scope-down wrapping to all rules including the first', () => {
      const config: RouteConfig = {
        routes: [
          {
            pattern: '/api/*',
            policies: [
              {
                condition: {
                  or: [
                    'awswaf:managed:aws:bot-control:bot:name:gptbot',
                    'awswaf:managed:aws:bot-control:bot:name:claudebot',
                  ],
                },
                action: '0.01',
              },
              {
                condition: { not: 'awswaf:managed:aws:bot-control:bot:unverified' },
                action: '0.002',
              },
            ],
          },
        ],
      };

      const rules = translateRouteConfig(config);

      expect(rules).toHaveLength(2);

      // First rule: scope-down wrapping applied (all rules get it)
      const firstStmt = rules[0].statement;
      expect(firstStmt.andStatement).toBeDefined();
      // AND(NOT(route-matched), URI, OR(...))
      expect(firstStmt.andStatement!.statements).toHaveLength(3);
      expect(firstStmt.andStatement!.statements[0].notStatement).toBeDefined();
      expect(firstStmt.andStatement!.statements[1].regexMatchStatement).toBeDefined();
      expect(firstStmt.andStatement!.statements[2].orStatement).toBeDefined();

      // Second rule: scope-down wrapping applied
      const secondStmt = rules[1].statement;
      expect(secondStmt.andStatement).toBeDefined();
      const scopeDownStatements = secondStmt.andStatement!.statements;
      expect(scopeDownStatements[0].notStatement).toBeDefined();
      expect(
        scopeDownStatements[0].notStatement!.statement.labelMatchStatements![0].key,
      ).toBe('x402:route-matched');
    });
  });
});

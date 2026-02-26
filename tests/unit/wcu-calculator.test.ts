import {
  calculateStatementWcu,
  calculateRuleWcu,
  calculateTotalWcu,
  validateWcuCapacity,
  RULE_GROUP_CAPACITY,
  FIXED_OVERHEAD_WCU,
  GUARD_RULE_WCU,
  BOT_SIGNAL_WCU,
} from '../../src/backoffice/waf-sync/wcu-calculator';
import type { WafRule, WafStatement } from '../../src/backoffice/waf-sync/types';

describe('wcu-calculator', () => {
  describe('FIXED_OVERHEAD_WCU', () => {
    it('should be 187 (8 guard + 179 bot signal)', () => {
      expect(GUARD_RULE_WCU).toBe(8);
      expect(BOT_SIGNAL_WCU).toBe(179);
      expect(FIXED_OVERHEAD_WCU).toBe(187);
    });
  });

  describe('RULE_GROUP_CAPACITY', () => {
    it('should be 500', () => {
      expect(RULE_GROUP_CAPACITY).toBe(500);
    });
  });

  describe('calculateStatementWcu', () => {
    it('should return 1 for ByteMatch statement', () => {
      const stmt: WafStatement = {
        byteMatchStatement: {
          fieldToMatch: { uriPath: {} },
          positionalConstraint: 'EXACTLY',
          searchString: '/api/test',
          textTransformations: [{ priority: 0, type: 'NONE' }],
        },
      };
      expect(calculateStatementWcu(stmt)).toBe(1);
    });

    it('should return 1 for STARTS_WITH ByteMatch', () => {
      const stmt: WafStatement = {
        byteMatchStatement: {
          fieldToMatch: { uriPath: {} },
          positionalConstraint: 'STARTS_WITH',
          searchString: '/api/',
          textTransformations: [{ priority: 0, type: 'NONE' }],
        },
      };
      expect(calculateStatementWcu(stmt)).toBe(1);
    });

    it('should return 3 for RegexMatch statement', () => {
      const stmt: WafStatement = {
        regexMatchStatement: {
          fieldToMatch: { uriPath: {} },
          regexString: '^/api/[^/]*$',
          textTransformations: [{ priority: 0, type: 'NONE' }],
        },
      };
      expect(calculateStatementWcu(stmt)).toBe(3);
    });

    it('should return 1 per LabelMatch entry', () => {
      const stmt: WafStatement = {
        labelMatchStatements: [
          { scope: 'LABEL', key: 'awswaf:managed:aws:bot-control:bot:verified' },
        ],
      };
      expect(calculateStatementWcu(stmt)).toBe(1);
    });

    it('should return count of LabelMatch entries', () => {
      const stmt: WafStatement = {
        labelMatchStatements: [
          { scope: 'LABEL', key: 'label-a' },
          { scope: 'LABEL', key: 'label-b' },
          { scope: 'NAMESPACE', key: 'ns:' },
        ],
      };
      expect(calculateStatementWcu(stmt)).toBe(3);
    });

    it('should return sum of children for AND statement', () => {
      const stmt: WafStatement = {
        andStatement: {
          statements: [
            { byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: 'EXACTLY', searchString: '/a', textTransformations: [{ priority: 0, type: 'NONE' }] } },
            { regexMatchStatement: { fieldToMatch: { uriPath: {} }, regexString: '^/b$', textTransformations: [{ priority: 0, type: 'NONE' }] } },
          ],
        },
      };
      expect(calculateStatementWcu(stmt)).toBe(4); // 1 + 3
    });

    it('should return sum of children for OR statement', () => {
      const stmt: WafStatement = {
        orStatement: {
          statements: [
            { labelMatchStatements: [{ scope: 'LABEL', key: 'a' }] },
            { labelMatchStatements: [{ scope: 'LABEL', key: 'b' }] },
          ],
        },
      };
      expect(calculateStatementWcu(stmt)).toBe(2); // 1 + 1
    });

    it('should return inner WCU for NOT statement', () => {
      const stmt: WafStatement = {
        notStatement: {
          statement: {
            labelMatchStatements: [{ scope: 'LABEL', key: 'x402:route-matched' }],
          },
        },
      };
      expect(calculateStatementWcu(stmt)).toBe(1);
    });

    it('should handle nested AND/OR/NOT correctly', () => {
      const stmt: WafStatement = {
        andStatement: {
          statements: [
            {
              notStatement: {
                statement: {
                  labelMatchStatements: [{ scope: 'LABEL', key: 'x402:route-matched' }],
                },
              },
            },
            { byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: 'EXACTLY', searchString: '/test', textTransformations: [{ priority: 0, type: 'NONE' }] } },
            {
              labelMatchStatements: [{ scope: 'LABEL', key: 'bot:verified' }],
            },
          ],
        },
      };
      // NOT(LabelMatch) = 1, ByteMatch = 1, LabelMatch = 1 → total 3
      expect(calculateStatementWcu(stmt)).toBe(3);
    });

    it('should return 0 for empty statement', () => {
      const stmt: WafStatement = {};
      expect(calculateStatementWcu(stmt)).toBe(0);
    });
  });

  describe('calculateRuleWcu', () => {
    it('should calculate WCU for a typical route rule with scope-down', () => {
      const rule: WafRule = {
        name: 'route-0-policy-0-price-0-001',
        priority: 1,
        statement: {
          andStatement: {
            statements: [
              // NOT(LabelMatch) scope-down
              {
                notStatement: {
                  statement: {
                    labelMatchStatements: [{ scope: 'LABEL', key: 'x402:route-matched' }],
                  },
                },
              },
              // URI ByteMatch EXACTLY
              {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: 'EXACTLY',
                  searchString: '/api/test',
                  textTransformations: [{ priority: 0, type: 'NONE' }],
                },
              },
              // Condition LabelMatch
              {
                labelMatchStatements: [{ scope: 'LABEL', key: 'bot:verified' }],
              },
            ],
          },
        },
        action: { insertHeader: { name: 'x-x402-route-action', value: '0.001' } },
        ruleLabels: ['x402:route-matched'],
      };
      // NOT(LabelMatch)=1 + ByteMatch=1 + LabelMatch=1 = 3
      expect(calculateRuleWcu(rule)).toBe(3);
    });
  });

  describe('calculateTotalWcu', () => {
    it('should include fixed overhead', () => {
      const result = calculateTotalWcu([]);
      expect(result.routeRulesWcu).toBe(0);
      expect(result.fixedOverheadWcu).toBe(FIXED_OVERHEAD_WCU);
      expect(result.totalWcu).toBe(FIXED_OVERHEAD_WCU);
    });

    it('should sum route rules and fixed overhead', () => {
      const rules: WafRule[] = [
        {
          name: 'r0',
          priority: 1,
          statement: { byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: 'EXACTLY', searchString: '/a', textTransformations: [{ priority: 0, type: 'NONE' }] } },
          action: 'block',
        },
        {
          name: 'r1',
          priority: 2,
          statement: { regexMatchStatement: { fieldToMatch: { uriPath: {} }, regexString: '^/b$', textTransformations: [{ priority: 0, type: 'NONE' }] } },
          action: 'block',
        },
      ];
      const result = calculateTotalWcu(rules);
      expect(result.routeRulesWcu).toBe(4); // 1 + 3
      expect(result.totalWcu).toBe(4 + FIXED_OVERHEAD_WCU);
    });
  });

  describe('validateWcuCapacity', () => {
    it('should return valid=true for typical small config', () => {
      const rules: WafRule[] = Array.from({ length: 10 }, (_, i) => ({
        name: `r${i}`,
        priority: i + 1,
        statement: {
          andStatement: {
            statements: [
              { notStatement: { statement: { labelMatchStatements: [{ scope: 'LABEL' as const, key: 'x402:route-matched' }] } } },
              { byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: 'EXACTLY' as const, searchString: `/path-${i}`, textTransformations: [{ priority: 0, type: 'NONE' }] } },
            ],
          },
        },
        action: 'block' as const,
      }));
      const result = validateWcuCapacity(rules);
      // 10 rules × 2 WCU each = 20 + 187 overhead = 207
      expect(result.valid).toBe(true);
      expect(result.routeRulesWcu).toBe(20);
      expect(result.totalWcu).toBe(207);
      expect(result.capacity).toBe(500);
    });

    it('should return valid=false when exceeding capacity', () => {
      // Create enough regex rules to exceed 500 WCU
      // Each regex rule = 3 WCU, need (500 - 187) / 3 + 1 ≈ 105 rules
      const rules: WafRule[] = Array.from({ length: 105 }, (_, i) => ({
        name: `r${i}`,
        priority: i + 1,
        statement: {
          regexMatchStatement: {
            fieldToMatch: { uriPath: {} },
            regexString: `^/path-${i}/[^/]*$`,
            textTransformations: [{ priority: 0, type: 'NONE' }],
          },
        },
        action: 'block' as const,
      }));
      const result = validateWcuCapacity(rules);
      // 105 × 3 = 315 + 187 = 502 > 500
      expect(result.valid).toBe(false);
      expect(result.totalWcu).toBe(502);
    });

    it('should return valid=true at exactly 500 WCU', () => {
      // 500 - 187 = 313 WCU budget. 313 ByteMatch rules = 313 WCU.
      const rules: WafRule[] = Array.from({ length: 313 }, (_, i) => ({
        name: `r${i}`,
        priority: i + 1,
        statement: {
          byteMatchStatement: {
            fieldToMatch: { uriPath: {} },
            positionalConstraint: 'EXACTLY' as const,
            searchString: `/p${i}`,
            textTransformations: [{ priority: 0, type: 'NONE' }],
          },
        },
        action: 'block' as const,
      }));
      const result = validateWcuCapacity(rules);
      expect(result.totalWcu).toBe(500);
      expect(result.valid).toBe(true);
    });
  });
});

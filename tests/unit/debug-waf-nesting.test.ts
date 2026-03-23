/**
 * Debug test: Reproduce the exact WAF API payload from the production SSM config
 * and check for illegal nesting patterns that WAF rejects.
 */
import { parseRouteConfig } from '../../src/backoffice/waf-sync/route-config-validator';
import { translateRouteConfig } from '../../src/backoffice/waf-sync/waf-rule-translator';
import { toAwsRules } from '../../src/backoffice/waf-sync/handler';

// Exact production SSM parameter value
const PRODUCTION_SSM_VALUE = JSON.stringify({
  routes: [
    {
      pattern: '/**',
      policies: [
        { condition: 'awswaf:managed:aws:bot-control:bot:verified', action: '0.002' },
        { condition: 'awswaf:managed:aws:bot-control:bot:unverified', action: '0.01' },
        { condition: 'default', action: '0' },
      ],
    },
  ],
});

describe('Debug: WAF nesting issue with production config', () => {
  it('should output the exact AWS rules payload and detect nesting issues', () => {
    const parseResult = parseRouteConfig(PRODUCTION_SSM_VALUE);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const wafRules = translateRouteConfig(parseResult.config);
    const awsRules = toAwsRules(wafRules);

    console.log('=== FULL AWS RULES PAYLOAD ===');
    console.log(JSON.stringify(awsRules, null, 2));

    const nestingIssues: string[] = [];

    for (const rule of awsRules) {
      const r = rule as Record<string, unknown>;
      const stmt = r.Statement as Record<string, unknown>;

      // Check for nested AND inside AND
      if (stmt.AndStatement) {
        const and = stmt.AndStatement as { Statements: Record<string, unknown>[] };
        for (let i = 0; i < and.Statements.length; i++) {
          const child = and.Statements[i];
          if (child.AndStatement) {
            nestingIssues.push(
              `Rule "${r.Name}": nested AndStatement inside AndStatement at child[${i}]`
            );
          }
          if (child.OrStatement) {
            nestingIssues.push(
              `Rule "${r.Name}": nested OrStatement inside AndStatement at child[${i}]`
            );
          }
        }
      }
    }

    if (nestingIssues.length > 0) {
      console.log('\n⚠️  NESTING ISSUES FOUND:');
      nestingIssues.forEach(issue => console.log(`  - ${issue}`));
    }

    // This test intentionally fails if nesting issues are found
    expect(nestingIssues).toEqual([]);

    // Every route rule (indices 1..3, after guard at 0, before bot signal rules)
    // must have the NOT(LabelMatch(x402:route-matched)) scope-down.
    // The production config has 3 policies → 3 route rules.
    const routeRules = awsRules.slice(1, 4);
    for (const rule of routeRules) {
      const r = rule as Record<string, unknown>;
      const stmt = r.Statement as Record<string, unknown>;
      expect(stmt.AndStatement).toBeDefined();
      const and = stmt.AndStatement as { Statements: Record<string, unknown>[] };
      const hasNotScopeDown = and.Statements.some((s) => {
        const not = s as { NotStatement?: { Statement?: { LabelMatchStatement?: { Key?: string } } } };
        return not.NotStatement?.Statement?.LabelMatchStatement?.Key === 'x402:route-matched';
      });
      expect(hasNotScopeDown).toBe(true);
    }

    // Guard rule (index 0) should be an OrStatement blocking spoofed headers
    const guardRule = awsRules[0] as Record<string, unknown>;
    expect(guardRule.Name).toBe('guard-block-spoofed-headers');
    expect(guardRule.Priority).toBe(0);
    expect(guardRule.Action).toEqual({ Block: {} });
    const guardStmt = guardRule.Statement as Record<string, unknown>;
    expect(guardStmt.OrStatement).toBeDefined();
    const orStmt = guardStmt.OrStatement as { Statements: Record<string, unknown>[] };
    expect(orStmt.Statements).toHaveLength(10);
  });
});

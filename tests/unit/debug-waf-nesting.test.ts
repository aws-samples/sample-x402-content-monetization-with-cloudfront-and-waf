import { parseRouteConfig } from '../../src/backoffice/waf-sync/route-config-validator';
import { translateRouteConfig } from '../../src/backoffice/waf-sync/waf-rule-translator';
import { toAwsRules } from '../../src/backoffice/waf-sync/handler';

const PRODUCTION_SSM_VALUE = JSON.stringify({
  routes: [{
    pattern: '/**',
    policies: [
      { condition: 'awswaf:managed:aws:bot-control:bot:verified', action: '0.002' },
      { condition: 'awswaf:managed:aws:bot-control:bot:unverified', action: '0.01' },
      { condition: 'default', action: '0' },
    ],
  }],
});

describe('production route configuration', () => {
  it('produces valid native WAF actions without legacy helper rules or headers', () => {
    const parsed = parseRouteConfig(PRODUCTION_SSM_VALUE);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const awsRules = toAwsRules(translateRouteConfig(parsed.config));

    expect(awsRules).toHaveLength(3);
    expect(awsRules.map((rule) => rule.Action)).toEqual([
      { Monetize: { PriceMultiplier: '2' } },
      { Monetize: { PriceMultiplier: '10' } },
      { Allow: {} },
    ]);
    expect(JSON.stringify(awsRules)).not.toContain('x-x402-route-action');
    expect(JSON.stringify(awsRules)).not.toContain('x402:route-matched');
    expect(JSON.stringify(awsRules)).not.toContain('guard-block-spoofed-headers');
  });
});

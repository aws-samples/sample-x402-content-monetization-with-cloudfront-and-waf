import { translateRouteConfig } from '../../src/backoffice/waf-sync/waf-rule-translator';
import type { RouteConfig } from '../../src/backoffice/waf-sync/types';

describe('translateRouteConfig', () => {
  it('maps block, free, and priced policies to terminating native WAF actions', () => {
    const config: RouteConfig = {
      routes: [{
        pattern: '/api/*',
        policies: [
          { condition: 'bot:unwanted', action: 'block' },
          { condition: 'bot:verified', action: '0.001' },
          { condition: 'human', action: '0' },
          { condition: 'default', action: '0.1' },
        ],
      }],
    };

    const rules = translateRouteConfig(config);

    expect(rules.map((rule) => rule.action)).toEqual([
      'block',
      { monetize: { priceMultiplier: '1' } },
      'allow',
      { monetize: { priceMultiplier: '100' } },
    ]);
    expect(rules.map((rule) => rule.priority)).toEqual([1, 2, 3, 4]);
    expect(rules.map((rule) => rule.name)).toEqual([
      'route-0-policy-0-block',
      'route-0-policy-1-price-0-001',
      'route-0-policy-2-free',
      'route-0-policy-3-price-0-1',
    ]);
  });

  it('uses only the URI statement for a default condition', () => {
    const [rule] = translateRouteConfig({
      routes: [{ pattern: '/articles/**', policies: [{ condition: 'default', action: '0.005' }] }],
    });

    expect(
      rule.statement.regexMatchStatement ?? rule.statement.byteMatchStatement,
    ).toBeDefined();
    expect(rule.statement.andStatement).toBeUndefined();
    expect(rule.action).toEqual({ monetize: { priceMultiplier: '5' } });
  });

  it('combines URI and label conditions without legacy route-matched scope-down labels', () => {
    const [rule] = translateRouteConfig({
      routes: [{
        pattern: '/api/*',
        policies: [{ condition: { and: ['bot:verified', { not: 'bot:internal' }] }, action: '0.01' }],
      }],
    });

    const statements = rule.statement.andStatement?.statements;
    expect(statements).toHaveLength(2);
    expect(statements?.[0].regexMatchStatement).toBeDefined();
    expect(statements?.[1].andStatement?.statements).toHaveLength(2);
    expect(JSON.stringify(rule)).not.toContain('x402:route-matched');
    expect(rule.action).toEqual({ monetize: { priceMultiplier: '10' } });
  });

  it('supports namespace label conditions', () => {
    const [rule] = translateRouteConfig({
      routes: [{
        pattern: '/private',
        policies: [{ condition: { namespace: 'awswaf:managed:aws:bot-control:bot:' }, action: 'block' }],
      }],
    });

    expect(rule.statement.andStatement?.statements[1]).toEqual({
      labelMatchStatements: [{
        scope: 'NAMESPACE',
        key: 'awswaf:managed:aws:bot-control:bot:',
      }],
    });
  });

  it('preserves route and policy order across routes', () => {
    const rules = translateRouteConfig({
      routes: [
        { pattern: '/first', policies: [
          { condition: 'a', action: '0.002' },
          { condition: 'default', action: '0' },
        ] },
        { pattern: '/second', policies: [{ condition: 'default', action: 'block' }] },
      ],
    });

    expect(rules.map((rule) => rule.name)).toEqual([
      'route-0-policy-0-price-0-002',
      'route-0-policy-1-free',
      'route-1-policy-0-block',
    ]);
  });

  it.each(['0.0001', '0.101', '1', '10'])(
    'rejects price %s because it cannot be represented by the native configuration',
    (action) => {
      expect(() => translateRouteConfig({
        routes: [{ pattern: '/**', policies: [{ condition: 'default', action }] }],
      })).toThrow('native WAF monetization');
    },
  );
});

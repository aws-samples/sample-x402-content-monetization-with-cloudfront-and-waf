/**
 * Unit tests for the hash-based change detector.
 *
 * Tests specific examples and edge cases for computeHash and hasChanged.
 *
 */

import { computeHash, hasChanged } from '../../src/backoffice/waf-sync/change-detector';
import type { RouteConfig } from '../../src/backoffice/waf-sync/types';

describe('computeHash', () => {
  it('should return a 64-character hex string (SHA-256)', () => {
    const config: RouteConfig = {
      routes: [
        {
          pattern: '/**',
          policies: [{ condition: 'default', action: '0' }],
        },
      ],
    };

    const hash = computeHash(config);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should produce the same hash for the same config', () => {
    const config: RouteConfig = {
      routes: [
        {
          pattern: '/api/*',
          policies: [
            { condition: 'awswaf:managed:aws:bot-control:bot:verified', action: '0.001' },
            { condition: 'default', action: 'block' },
          ],
        },
      ],
    };

    const hash1 = computeHash(config);
    const hash2 = computeHash(config);

    expect(hash1).toBe(hash2);
  });

  it('should produce the same hash regardless of property order', () => {
    // Config with properties in one order
    const config1 = {
      routes: [
        {
          pattern: '/api/*',
          policies: [{ condition: 'default', action: '0.001' }],
        },
      ],
    } as RouteConfig;

    // Same config with properties in different order (constructed via Object.assign)
    const config2 = {} as RouteConfig;
    Object.assign(config2, {
      routes: [
        {
          policies: [{ action: '0.001', condition: 'default' }],
          pattern: '/api/*',
        },
      ],
    });

    const hash1 = computeHash(config1);
    const hash2 = computeHash(config2);

    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different configs', () => {
    const config1: RouteConfig = {
      routes: [
        {
          pattern: '/api/*',
          policies: [{ condition: 'default', action: '0.001' }],
        },
      ],
    };

    const config2: RouteConfig = {
      routes: [
        {
          pattern: '/api/*',
          policies: [{ condition: 'default', action: '0.01' }],
        },
      ],
    };

    const hash1 = computeHash(config1);
    const hash2 = computeHash(config2);

    expect(hash1).not.toBe(hash2);
  });

  it('should handle configs with multiple routes', () => {
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

    const hash = computeHash(config);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should handle configs with boolean condition expressions', () => {
    const config: RouteConfig = {
      routes: [
        {
          pattern: '/api/premium/**',
          policies: [
            {
              condition: {
                and: [
                  'awswaf:managed:aws:bot-control:bot:verified',
                  { or: [
                    'awswaf:managed:aws:bot-control:bot:name:gptbot',
                    'awswaf:managed:aws:bot-control:bot:name:claudebot',
                  ]},
                ],
              },
              action: '0.01',
            },
            { condition: 'default', action: 'block' },
          ],
        },
      ],
    };

    const hash = computeHash(config);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should produce different hashes when condition expressions differ', () => {
    const baseConfig: RouteConfig = {
      routes: [
        {
          pattern: '/api/*',
          policies: [{ condition: { and: ['label-a', 'label-b'] }, action: '0.001' }],
        },
      ],
    };

    const modifiedConfig: RouteConfig = {
      routes: [
        {
          pattern: '/api/*',
          policies: [{ condition: { or: ['label-a', 'label-b'] }, action: '0.001' }],
        },
      ],
    };

    expect(computeHash(baseConfig)).not.toBe(computeHash(modifiedConfig));
  });

  it('should handle configs with array conditions', () => {
    const config: RouteConfig = {
      routes: [
        {
          pattern: '/api/*',
          policies: [
            {
              condition: [
                'awswaf:managed:aws:bot-control:bot:verified',
                'awswaf:managed:aws:bot-control:bot:category:search_engine',
              ],
              action: '0',
            },
            { condition: 'default', action: '0.01' },
          ],
        },
      ],
    };

    const hash = computeHash(config);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should handle empty routes array', () => {
    const config: RouteConfig = { routes: [] };

    const hash = computeHash(config);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should differentiate between config with and without condition expression', () => {
    const withoutExpression: RouteConfig = {
      routes: [
        {
          pattern: '/api/*',
          policies: [{ condition: 'default', action: '0.001' }],
        },
      ],
    };

    const withExpression: RouteConfig = {
      routes: [
        {
          pattern: '/api/*',
          policies: [{ condition: { not: 'awswaf:managed:aws:bot-control:bot:unverified' }, action: '0.001' }],
        },
      ],
    };

    expect(computeHash(withoutExpression)).not.toBe(computeHash(withExpression));
  });
});

describe('hasChanged', () => {
  it('should return false when hashes match', () => {
    const hash = 'a'.repeat(64);

    expect(hasChanged(hash, hash)).toBe(false);
  });

  it('should return true when hashes differ', () => {
    const hash1 = 'a'.repeat(64);
    const hash2 = 'b'.repeat(64);

    expect(hasChanged(hash1, hash2)).toBe(true);
  });

  it('should work with real computed hashes', () => {
    const config1: RouteConfig = {
      routes: [
        {
          pattern: '/api/*',
          policies: [{ condition: 'default', action: '0.001' }],
        },
      ],
    };

    const config2: RouteConfig = {
      routes: [
        {
          pattern: '/api/*',
          policies: [{ condition: 'default', action: '0.01' }],
        },
      ],
    };

    const hash1 = computeHash(config1);
    const hash2 = computeHash(config2);
    const hash1Again = computeHash(config1);

    expect(hasChanged(hash1, hash1Again)).toBe(false);
    expect(hasChanged(hash1, hash2)).toBe(true);
  });

  it('should return true when comparing against empty string', () => {
    const hash = computeHash({ routes: [] });

    expect(hasChanged(hash, '')).toBe(true);
  });
});

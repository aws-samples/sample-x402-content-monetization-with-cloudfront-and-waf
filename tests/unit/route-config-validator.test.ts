/**
 * Unit tests for Route_Config JSON schema validation.
 *
 */
import {
  parseRouteConfig,
  type ValidationResult,
} from '../../src/backoffice/waf-sync/route-config-validator';

/** Shorthand: validate a raw object by round-tripping through JSON. */
function validateRouteConfig(input: unknown): ValidationResult {
  return parseRouteConfig(JSON.stringify(input));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectSuccess(result: ValidationResult) {
  expect(result.success).toBe(true);
  if (result.success) return result.config;
  throw new Error(`Expected success but got error: ${result.error}`);
}

function expectError(result: ValidationResult, substring: string) {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error).toContain(substring);
  }
}

/** Helper to build a minimal config with a single policy condition. */
function configWith(condition: unknown) {
  return {
    routes: [
      {
        pattern: '/**',
        policies: [{ condition, action: '0' }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Valid configs
// ---------------------------------------------------------------------------

describe('validateRouteConfig – valid configs', () => {
  it('accepts a minimal valid config with one route and one policy', () => {
    const config = expectSuccess(
      validateRouteConfig({
        routes: [
          {
            pattern: '/api/*',
            policies: [{ condition: 'default', action: '0' }],
          },
        ],
      }),
    );
    expect(config.routes).toHaveLength(1);
    expect(config.routes[0].pattern).toBe('/api/*');
    expect(config.routes[0].policies[0]).toEqual({ condition: 'default', action: '0' });
  });

  it('accepts multiple routes with multiple policies', () => {
    const config = expectSuccess(
      validateRouteConfig({
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
      }),
    );
    expect(config.routes).toHaveLength(2);
  });

  it('accepts condition as an array of label strings', () => {
    const config = expectSuccess(
      validateRouteConfig({
        routes: [
          {
            pattern: '/secure/**',
            policies: [
              {
                condition: [
                  'awswaf:managed:aws:bot-control:bot:verified',
                  'awswaf:custom:trusted-partner',
                ],
                action: '0',
              },
              { condition: 'default', action: 'block' },
            ],
          },
        ],
      }),
    );
    expect(config.routes[0].policies[0].condition).toEqual([
      'awswaf:managed:aws:bot-control:bot:verified',
      'awswaf:custom:trusted-partner',
    ]);
  });

  it('accepts action "block"', () => {
    const config = expectSuccess(
      validateRouteConfig({
        routes: [
          {
            pattern: '/private/**',
            policies: [{ condition: 'default', action: 'block' }],
          },
        ],
      }),
    );
    expect(config.routes[0].policies[0].action).toBe('block');
  });

  it('accepts action "0" (free access)', () => {
    const config = expectSuccess(
      validateRouteConfig({
        routes: [
          {
            pattern: '/public/**',
            policies: [{ condition: 'default', action: '0' }],
          },
        ],
      }),
    );
    expect(config.routes[0].policies[0].action).toBe('0');
  });

  it('accepts integer price strings', () => {
    const config = expectSuccess(
      validateRouteConfig({
        routes: [
          {
            pattern: '/expensive/**',
            policies: [{ condition: 'default', action: '10' }],
          },
        ],
      }),
    );
    expect(config.routes[0].policies[0].action).toBe('10');
  });

  it('accepts the default route config template from the design', () => {
    const config = expectSuccess(
      validateRouteConfig({
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
      }),
    );
    expect(config.routes).toHaveLength(1);
    expect(config.routes[0].policies).toHaveLength(3);
  });

  it('accepts string conditions', () => {
    const config = expectSuccess(validateRouteConfig(configWith('some-label')));
    expect(config.routes[0].policies[0].condition).toBe('some-label');
  });

  it('accepts "default" condition', () => {
    const config = expectSuccess(validateRouteConfig(configWith('default')));
    expect(config.routes[0].policies[0].condition).toBe('default');
  });

  it('accepts string array conditions', () => {
    const config = expectSuccess(validateRouteConfig(configWith(['label-a', 'label-b'])));
    expect(config.routes[0].policies[0].condition).toEqual(['label-a', 'label-b']);
  });

  it('accepts object conditions (and/or/not)', () => {
    const config = expectSuccess(
      validateRouteConfig({
        routes: [
          {
            pattern: '/**',
            policies: [
              {
                condition: { and: ['label-a', 'label-b'] },
                action: '0.01',
              },
              { condition: 'default', action: '0' },
            ],
          },
        ],
      }),
    );
    expect(config.routes[0].policies[0].condition).toEqual({ and: ['label-a', 'label-b'] });
  });
});

// ---------------------------------------------------------------------------
// Invalid configs – top-level
// ---------------------------------------------------------------------------

describe('validateRouteConfig – invalid top-level', () => {
  it('rejects null', () => {
    expectError(validateRouteConfig(null), 'non-null object');
  });

  it('rejects a string', () => {
    expectError(validateRouteConfig('not an object'), 'non-null object');
  });

  it('rejects an array', () => {
    expectError(validateRouteConfig([]), 'non-null object');
  });

  it('rejects missing routes', () => {
    expectError(validateRouteConfig({}), '"routes" must be an array');
  });

  it('rejects routes as a string', () => {
    expectError(validateRouteConfig({ routes: 'not an array' }), '"routes" must be an array');
  });
});

// ---------------------------------------------------------------------------
// Invalid configs – route entries
// ---------------------------------------------------------------------------

describe('validateRouteConfig – invalid route entries', () => {
  it('rejects a route that is not an object', () => {
    expectError(validateRouteConfig({ routes: ['not an object'] }), 'routes[0]: must be a non-null object');
  });

  it('rejects a route with missing pattern', () => {
    expectError(
      validateRouteConfig({ routes: [{ policies: [{ condition: 'default', action: '0' }] }] }),
      'routes[0].pattern: must be a string',
    );
  });

  it('rejects a route with empty pattern', () => {
    expectError(
      validateRouteConfig({ routes: [{ pattern: '', policies: [{ condition: 'default', action: '0' }] }] }),
      'routes[0].pattern: must not be empty',
    );
  });

  it('rejects a route with missing policies', () => {
    expectError(
      validateRouteConfig({ routes: [{ pattern: '/api/*' }] }),
      'routes[0].policies: must be an array',
    );
  });

  it('rejects a route with empty policies array', () => {
    expectError(
      validateRouteConfig({ routes: [{ pattern: '/api/*', policies: [] }] }),
      'routes[0].policies: must not be empty',
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid configs – access policies
// ---------------------------------------------------------------------------

describe('validateRouteConfig – invalid access policies', () => {
  it('rejects a policy that is not an object', () => {
    expectError(
      validateRouteConfig({ routes: [{ pattern: '/api/*', policies: [42] }] }),
      'routes[0].policies[0]: must be a non-null object',
    );
  });

  it('rejects a policy with missing condition', () => {
    expectError(
      validateRouteConfig({ routes: [{ pattern: '/api/*', policies: [{ action: '0' }] }] }),
      'condition: is required',
    );
  });

  it('rejects a policy with empty string condition', () => {
    expectError(
      validateRouteConfig({ routes: [{ pattern: '/api/*', policies: [{ condition: '', action: '0' }] }] }),
      'condition: must not be an empty string',
    );
  });

  it('rejects a policy with empty array condition', () => {
    expectError(
      validateRouteConfig({ routes: [{ pattern: '/api/*', policies: [{ condition: [], action: '0' }] }] }),
      'condition: array must not be empty',
    );
  });

  it('rejects a policy with non-string element in condition array', () => {
    expectError(
      validateRouteConfig({
        routes: [{ pattern: '/api/*', policies: [{ condition: ['valid', 123], action: '0' }] }],
      }),
      'condition[1]: must be a string',
    );
  });

  it('rejects a policy with empty string in condition array', () => {
    expectError(
      validateRouteConfig({
        routes: [{ pattern: '/api/*', policies: [{ condition: ['valid', ''], action: '0' }] }],
      }),
      'condition[1]: must not be an empty string',
    );
  });

  it('rejects a policy with numeric condition', () => {
    expectError(
      validateRouteConfig({ routes: [{ pattern: '/api/*', policies: [{ condition: 42, action: '0' }] }] }),
      'invalid condition type',
    );
  });

  it('rejects a policy with missing action', () => {
    expectError(
      validateRouteConfig({
        routes: [{ pattern: '/api/*', policies: [{ condition: 'default' }] }],
      }),
      'action: must be a string',
    );
  });

  it('rejects a policy with non-string action', () => {
    expectError(
      validateRouteConfig({
        routes: [{ pattern: '/api/*', policies: [{ condition: 'default', action: 42 }] }],
      }),
      'action: must be a string',
    );
  });

  it('rejects a policy with invalid action string', () => {
    expectError(
      validateRouteConfig({
        routes: [{ pattern: '/api/*', policies: [{ condition: 'default', action: 'free' }] }],
      }),
      'action: must be "block" or a non-negative price string',
    );
  });

  it('rejects a policy with negative price', () => {
    expectError(
      validateRouteConfig({
        routes: [{ pattern: '/api/*', policies: [{ condition: 'default', action: '-1' }] }],
      }),
      'action: must be "block" or a non-negative price string',
    );
  });
});

// ---------------------------------------------------------------------------
// parseRouteConfig (JSON string input)
// ---------------------------------------------------------------------------

describe('parseRouteConfig', () => {
  it('parses and validates a valid JSON string', () => {
    const json = JSON.stringify({
      routes: [{ pattern: '/**', policies: [{ condition: 'default', action: '0' }] }],
    });
    const result = parseRouteConfig(json);
    expect(result.success).toBe(true);
  });

  it('returns an error for invalid JSON', () => {
    const result = parseRouteConfig('not json');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid JSON');
    }
  });

  it('returns a validation error for valid JSON but invalid config', () => {
    const result = parseRouteConfig('{}');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('"routes" must be an array');
    }
  });
});

// ---------------------------------------------------------------------------
// Valid boolean conditions
// ---------------------------------------------------------------------------

describe('validateRouteConfig – valid boolean conditions', () => {
  it('accepts { and: [...] } with string sub-conditions', () => {
    const config = expectSuccess(
      validateRouteConfig(
        configWith({ and: ['label-a', 'label-b', 'label-c'] }),
      ),
    );
    expect(config.routes[0].policies[0].condition).toEqual({
      and: ['label-a', 'label-b', 'label-c'],
    });
  });

  it('accepts { or: [...] } with string sub-conditions', () => {
    const config = expectSuccess(
      validateRouteConfig(
        configWith({ or: ['label-a', 'label-b'] }),
      ),
    );
    expect(config.routes[0].policies[0].condition).toEqual({
      or: ['label-a', 'label-b'],
    });
  });

  it('accepts { not: <string> }', () => {
    const config = expectSuccess(
      validateRouteConfig(
        configWith({ not: 'some-label' }),
      ),
    );
    expect(config.routes[0].policies[0].condition).toEqual({
      not: 'some-label',
    });
  });

  it('accepts nested and/or/not expressions', () => {
    const condition = {
      and: [
        'awswaf:managed:aws:bot-control:bot:verified',
        {
          or: [
            'awswaf:managed:aws:bot-control:bot:name:gptbot',
            'awswaf:managed:aws:bot-control:bot:name:claudebot',
          ],
        },
      ],
    };
    const config = expectSuccess(validateRouteConfig(configWith(condition)));
    expect(config.routes[0].policies[0].condition).toEqual(condition);
  });

  it('accepts { not: { or: [...] } } (nested not with or)', () => {
    const condition = {
      not: { or: ['label-a', 'label-b'] },
    };
    const config = expectSuccess(validateRouteConfig(configWith(condition)));
    expect(config.routes[0].policies[0].condition).toEqual(condition);
  });

  it('accepts { and: [...] } with nested { not: ... } sub-conditions', () => {
    const condition = {
      and: [
        { not: 'blocked-label' },
        'required-label',
      ],
    };
    const config = expectSuccess(validateRouteConfig(configWith(condition)));
    expect(config.routes[0].policies[0].condition).toEqual(condition);
  });

  it('accepts the full example from the requirements doc', () => {
    const config = expectSuccess(
      validateRouteConfig({
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
                action: '0.002',
              },
              {
                condition: { not: 'awswaf:managed:aws:bot-control:bot:verified' },
                action: 'block',
              },
            ],
          },
        ],
      }),
    );
    expect(config.routes).toHaveLength(1);
    expect(config.routes[0].policies).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Invalid boolean conditions
// ---------------------------------------------------------------------------

describe('validateRouteConfig – invalid boolean conditions', () => {
  it('rejects empty and array', () => {
    expectError(
      validateRouteConfig(configWith({ and: [] })),
      'must be a non-empty array',
    );
  });

  it('rejects empty or array', () => {
    expectError(
      validateRouteConfig(configWith({ or: [] })),
      'must be a non-empty array',
    );
  });

  it('rejects and with non-array value', () => {
    expectError(
      validateRouteConfig(configWith({ and: 'not-an-array' })),
      'must be a non-empty array',
    );
  });

  it('rejects or with non-array value', () => {
    expectError(
      validateRouteConfig(configWith({ or: 'not-an-array' })),
      'must be a non-empty array',
    );
  });

  it('rejects unrecognized condition object key', () => {
    expectError(
      validateRouteConfig(configWith({ xor: ['a', 'b'] })),
      'condition object must have exactly one key: "and", "or", "not", or "namespace"',
    );
  });

  it('rejects condition object with multiple keys', () => {
    expectError(
      validateRouteConfig(configWith({ and: ['a'], or: ['b'] })),
      'condition object must have exactly one key: "and", "or", "not", or "namespace"',
    );
  });

  it('rejects empty string condition', () => {
    expectError(
      validateRouteConfig(configWith('')),
      'must not be an empty string',
    );
  });

  it('rejects empty array condition', () => {
    expectError(
      validateRouteConfig(configWith([])),
      'array must not be empty',
    );
  });

  it('rejects numeric condition', () => {
    expectError(
      validateRouteConfig(configWith(42)),
      'invalid condition type',
    );
  });

  it('rejects null condition', () => {
    expectError(
      validateRouteConfig({
        routes: [
          {
            pattern: '/**',
            policies: [{ condition: null, action: '0' }],
          },
        ],
      }),
      'condition: is required',
    );
  });

  it('rejects empty string inside and array', () => {
    expectError(
      validateRouteConfig(configWith({ and: ['valid', ''] })),
      'must not be an empty string',
    );
  });

  it('rejects non-string inside and array', () => {
    expectError(
      validateRouteConfig(configWith({ and: ['valid', 42] })),
      'invalid condition type',
    );
  });
});

// ---------------------------------------------------------------------------
// Nesting depth limit
// ---------------------------------------------------------------------------

describe('validateRouteConfig – nesting depth limit', () => {
  it('accepts nesting at exactly depth 5', () => {
    const condition = {
      not: { not: { not: { not: { not: 'leaf-label' } } } },
    };
    const result = validateRouteConfig(configWith(condition));
    expect(result.success).toBe(true);
  });

  it('rejects nesting exceeding depth 5', () => {
    const condition = {
      not: { not: { not: { not: { not: { not: 'too-deep' } } } } },
    };
    expectError(
      validateRouteConfig(configWith(condition)),
      'condition nesting exceeds maximum depth of 5',
    );
  });

  it('rejects deep nesting via and/or combination', () => {
    const condition = {
      and: [
        {
          or: [
            {
              and: [
                {
                  or: [
                    {
                      not: { and: ['too-deep'] },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expectError(
      validateRouteConfig(configWith(condition)),
      'condition nesting exceeds maximum depth of 5',
    );
  });
});

// ---------------------------------------------------------------------------
// Namespace condition validation
// ---------------------------------------------------------------------------

describe('validateRouteConfig – namespace condition validation', () => {
  it('accepts { namespace: "<non-empty-string>" }', () => {
    const config = expectSuccess(
      validateRouteConfig(
        configWith({ namespace: 'awswaf:managed:aws:bot-control:bot:name:' }),
      ),
    );
    expect(config.routes[0].policies[0].condition).toEqual({
      namespace: 'awswaf:managed:aws:bot-control:bot:name:',
    });
  });

  it('accepts namespace condition nested inside and combinator', () => {
    const condition = {
      and: [
        { namespace: 'awswaf:managed:aws:bot-control:bot:name:' },
        'awswaf:managed:aws:bot-control:bot:verified',
      ],
    };
    const config = expectSuccess(validateRouteConfig(configWith(condition)));
    expect(config.routes[0].policies[0].condition).toEqual(condition);
  });

  it('accepts namespace condition nested inside or combinator', () => {
    const condition = {
      or: [
        { namespace: 'awswaf:managed:aws:bot-control:bot:name:' },
        'awswaf:managed:aws:bot-control:bot:verified',
      ],
    };
    const config = expectSuccess(validateRouteConfig(configWith(condition)));
    expect(config.routes[0].policies[0].condition).toEqual(condition);
  });

  it('accepts namespace condition nested inside not combinator', () => {
    const condition = {
      not: { namespace: 'awswaf:managed:aws:bot-control:bot:name:' },
    };
    const config = expectSuccess(validateRouteConfig(configWith(condition)));
    expect(config.routes[0].policies[0].condition).toEqual(condition);
  });

  it('rejects { namespace: "" } with empty string value', () => {
    expectError(
      validateRouteConfig(configWith({ namespace: '' })),
      'namespace: must not be an empty string',
    );
  });

  it('rejects { namespace: 123 } with numeric value', () => {
    expectError(
      validateRouteConfig(configWith({ namespace: 123 })),
      'namespace: must be a string',
    );
  });

  it('rejects { namespace: true } with boolean value', () => {
    expectError(
      validateRouteConfig(configWith({ namespace: true })),
      'namespace: must be a string',
    );
  });

  it('rejects { namespace: null } with null value', () => {
    expectError(
      validateRouteConfig(configWith({ namespace: null })),
      'namespace: must be a string',
    );
  });

  it('rejects { namespace: [...] } with array value', () => {
    expectError(
      validateRouteConfig(configWith({ namespace: ['a', 'b'] })),
      'namespace: must be a string',
    );
  });

  it('rejects { namespace: "x", and: [...] } with multiple keys', () => {
    expectError(
      validateRouteConfig(configWith({ namespace: 'x', and: ['a'] })),
      'condition object must have exactly one key',
    );
  });
});

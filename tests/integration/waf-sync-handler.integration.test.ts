/**
 * Integration Tests for WAF Sync Function Handler
 *
 * Tests the full sync flow with mocked AWS SDK (SSM, WAFv2).
 * These tests validate the interaction between the WAF sync handler
 * and its dependencies (SSM, WAFv2, change-detector, waf-rule-translator,
 * route-config-validator).
 *
 * Test scenarios:
 * - No changes (hash match → skip)
 * - Changes detected (hash diff → update)
 * - SSM error
 * - WAF API error
 * - EventBridge SSM change event
 * - Scheduled event
 *
 */

import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import {
  WAFV2Client,
  GetRuleGroupCommand,
  UpdateRuleGroupCommand,
} from '@aws-sdk/client-wafv2';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';

import { handler, _setSsmClient, _setWafv2Client } from '../../src/backoffice/waf-sync/handler';
import { computeHash } from '../../src/backoffice/waf-sync/change-detector';

// Create mock clients
const ssmMock = mockClient(SSMClient);
const wafv2Mock = mockClient(WAFV2Client);

// ---------------------------------------------------------------------------
// Test Configuration
// ---------------------------------------------------------------------------

const TEST_STACK_NAME = 'test-stack';
const TEST_SSM_ROUTES_PATH = `/x402-edge/${TEST_STACK_NAME}/config/routes`;
const TEST_SSM_HASH_PATH = `/x402-edge/${TEST_STACK_NAME}/sync/last-hash`;
const TEST_WAF_RULE_GROUP_NAME = 'x402-test-rule-group';
const TEST_WAF_RULE_GROUP_ID = 'rg-test-id-12345';
const TEST_LOCK_TOKEN = 'lock-token-abc123';

/**
 * A simple valid Route_Config for testing.
 */
const SIMPLE_ROUTE_CONFIG = {
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

/**
 * A more complex Route_Config for testing.
 */
const COMPLEX_ROUTE_CONFIG = {
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
        { condition: 'awswaf:managed:aws:bot-control:bot:category:search_engine', action: '0' },
        { condition: 'default', action: '0.01' },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Event Factories
// ---------------------------------------------------------------------------

/**
 * Create a mock EventBridge SSM change event.
 */
function createSsmChangeEvent(): Record<string, unknown> {
  return {
    'detail-type': 'Parameter Store Change',
    source: 'aws.ssm',
    detail: {
      name: TEST_SSM_ROUTES_PATH,
      operation: 'Update',
      type: 'String',
    },
  };
}

/**
 * Create a mock EventBridge scheduled event.
 */
function createScheduledEvent(): Record<string, unknown> {
  return {
    'detail-type': 'Scheduled Event',
    source: 'aws.events',
    detail: {},
  };
}

// ---------------------------------------------------------------------------
// Setup Helpers
// ---------------------------------------------------------------------------

/**
 * Set up environment variables for the handler.
 */
function setupEnv(): void {
  process.env.STACK_NAME = TEST_STACK_NAME;
  process.env.WAF_RULE_GROUP_NAME = TEST_WAF_RULE_GROUP_NAME;
  process.env.WAF_RULE_GROUP_ID = TEST_WAF_RULE_GROUP_ID;
  process.env.SSM_ROUTES_PATH = TEST_SSM_ROUTES_PATH;
  process.env.SSM_HASH_PATH = TEST_SSM_HASH_PATH;
}

/**
 * Clean up environment variables.
 */
function cleanupEnv(): void {
  delete process.env.STACK_NAME;
  delete process.env.WAF_RULE_GROUP_NAME;
  delete process.env.WAF_RULE_GROUP_ID;
  delete process.env.SSM_ROUTES_PATH;
  delete process.env.SSM_HASH_PATH;
}

/**
 * Set up SSM mock to return a Route_Config and a stored hash.
 */
function setupSsmMock(
  routeConfig: object,
  storedHash: string | null = null,
): void {
  // Route config parameter
  ssmMock
    .on(GetParameterCommand, { Name: TEST_SSM_ROUTES_PATH })
    .resolves({
      Parameter: { Value: JSON.stringify(routeConfig) },
    });

  // Hash parameter
  if (storedHash === null) {
    // Simulate parameter not found (first sync)
    const notFoundError = new Error('Parameter not found');
    notFoundError.name = 'ParameterNotFound';
    ssmMock
      .on(GetParameterCommand, { Name: TEST_SSM_HASH_PATH })
      .rejects(notFoundError);
  } else {
    ssmMock
      .on(GetParameterCommand, { Name: TEST_SSM_HASH_PATH })
      .resolves({
        Parameter: { Value: storedHash },
      });
  }

  // PutParameter for storing hash
  ssmMock.on(PutParameterCommand).resolves({});
}

/**
 * Set up WAFv2 mock for GetRuleGroup and UpdateRuleGroup.
 */
function setupWafv2Mock(): void {
  wafv2Mock.on(GetRuleGroupCommand).resolves({
    LockToken: TEST_LOCK_TOKEN,
    RuleGroup: {
      Name: TEST_WAF_RULE_GROUP_NAME,
      Id: TEST_WAF_RULE_GROUP_ID,
      Capacity: 1000,
      ARN: `arn:aws:wafv2:us-east-1:123456789012:global/rulegroup/${TEST_WAF_RULE_GROUP_NAME}/${TEST_WAF_RULE_GROUP_ID}`,
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: TEST_WAF_RULE_GROUP_NAME,
      },
    },
  });

  wafv2Mock.on(UpdateRuleGroupCommand).resolves({
    NextLockToken: 'new-lock-token-xyz',
  });
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('WAF Sync Handler - Integration Tests', () => {
  beforeAll(() => {
    // Inject mock clients
    _setSsmClient(ssmMock as unknown as SSMClient);
    _setWafv2Client(wafv2Mock as unknown as WAFV2Client);
  });

  beforeEach(() => {
    // Reset all mocks before each test
    ssmMock.reset();
    wafv2Mock.reset();
    setupEnv();

    // Suppress console output during tests
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanupEnv();
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: No changes detected (hash match → skip)
  // -------------------------------------------------------------------------
  describe('Scenario: No changes detected (hash match → skip)', () => {
    /**
     * When the Route_Config hash matches the stored hash, the handler
     * should skip the WAF update and log "no changes detected".
     */
    it('should skip WAF update when hash matches stored hash', async () => {
      // Arrange: Set up SSM with matching hash
      const currentHash = computeHash(SIMPLE_ROUTE_CONFIG);
      setupSsmMock(SIMPLE_ROUTE_CONFIG, currentHash);
      setupWafv2Mock();

      // Act
      await handler(createSsmChangeEvent());

      // Assert: WAF should NOT be called
      expect(wafv2Mock.commandCalls(GetRuleGroupCommand)).toHaveLength(0);
      expect(wafv2Mock.commandCalls(UpdateRuleGroupCommand)).toHaveLength(0);

      // Assert: Hash should NOT be stored (no change)
      expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);

      // Assert: "no changes detected" was logged
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('No changes detected'),
      );
    });

    it('should skip WAF update on scheduled event when hash matches', async () => {
      // Arrange
      const currentHash = computeHash(SIMPLE_ROUTE_CONFIG);
      setupSsmMock(SIMPLE_ROUTE_CONFIG, currentHash);
      setupWafv2Mock();

      // Act
      await handler(createScheduledEvent());

      // Assert: WAF should NOT be called
      expect(wafv2Mock.commandCalls(GetRuleGroupCommand)).toHaveLength(0);
      expect(wafv2Mock.commandCalls(UpdateRuleGroupCommand)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Changes detected (hash diff → update)
  // -------------------------------------------------------------------------
  describe('Scenario: Changes detected (hash diff → update)', () => {
    /**
     * When the Route_Config hash differs from the stored hash, the handler
     * should translate the config to WAF rules and update the WAF Rule Group.
     */
    it('should update WAF rules when hash differs from stored hash', async () => {
      // Arrange: Set up SSM with different hash
      setupSsmMock(SIMPLE_ROUTE_CONFIG, 'old-hash-that-does-not-match');
      setupWafv2Mock();

      // Act
      await handler(createSsmChangeEvent());

      // Assert: WAF should be called
      expect(wafv2Mock.commandCalls(GetRuleGroupCommand)).toHaveLength(1);
      expect(wafv2Mock.commandCalls(UpdateRuleGroupCommand)).toHaveLength(1);

      // Assert: UpdateRuleGroup was called with correct parameters
      const updateCall = wafv2Mock.commandCalls(UpdateRuleGroupCommand)[0];
      expect(updateCall.args[0].input).toMatchObject({
        Name: TEST_WAF_RULE_GROUP_NAME,
        Scope: 'CLOUDFRONT',
        Id: TEST_WAF_RULE_GROUP_ID,
        LockToken: TEST_LOCK_TOKEN,
      });

      // Assert: Rules were generated (1 guard + 2 route rules from 2 policies + 17 bot signal rules)
      const rules = updateCall.args[0].input.Rules as unknown[];
      expect(rules).toHaveLength(20);

      // Assert: Hash was stored
      expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(1);
      const putCall = ssmMock.commandCalls(PutParameterCommand)[0];
      expect(putCall.args[0].input).toMatchObject({
        Name: TEST_SSM_HASH_PATH,
        Value: computeHash(SIMPLE_ROUTE_CONFIG),
        Overwrite: true,
      });
    });

    it('should update WAF rules on first sync (no stored hash)', async () => {
      // Arrange: No stored hash (first sync — ParameterNotFound)
      setupSsmMock(SIMPLE_ROUTE_CONFIG, null);
      setupWafv2Mock();

      // Act
      await handler(createSsmChangeEvent());

      // Assert: WAF should be called (first sync always updates)
      expect(wafv2Mock.commandCalls(GetRuleGroupCommand)).toHaveLength(1);
      expect(wafv2Mock.commandCalls(UpdateRuleGroupCommand)).toHaveLength(1);

      // Assert: Hash was stored
      expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(1);
    });

    it('should correctly translate complex Route_Config to WAF rules', async () => {
      // Arrange: Complex config with multiple routes and policies
      setupSsmMock(COMPLEX_ROUTE_CONFIG, 'old-hash');
      setupWafv2Mock();

      // Act
      await handler(createSsmChangeEvent());

      // Assert: 1 guard + 5 route rules + 17 bot signal rules
      const updateCall = wafv2Mock.commandCalls(UpdateRuleGroupCommand)[0];
      const rules = updateCall.args[0].input.Rules as unknown as Record<string, unknown>[];
      expect(rules).toHaveLength(23);

      // First rule is the guard rule
      expect(rules[0]).toMatchObject({
        Name: 'guard-block-spoofed-headers',
        Priority: 0,
        Action: { Block: {} },
      });

      // Verify second rule (index 1) is a price rule (Count with InsertHeader + label)
      expect(rules[1]).toMatchObject({
        Name: 'route-0-policy-0-price-0-001',
        Priority: 1,
        Action: {
          Count: {
            CustomRequestHandling: {
              InsertHeaders: [
                { Name: 'x-x402-route-action', Value: '0.001' },
              ],
            },
          },
        },
        RuleLabels: [{ Name: 'x402:route-matched' }],
      });

      // Verify third rule (index 2) is a block rule
      expect(rules[2]).toMatchObject({
        Name: 'route-0-policy-1-block',
        Priority: 2,
        Action: { Block: {} },
      });

      // Verify free access rule (price "0") — Count with InsertHeader + label
      expect(rules[4]).toMatchObject({
        Name: 'route-1-policy-1-free',
        Priority: 4,
        Action: {
          Count: {
            CustomRequestHandling: {
              InsertHeaders: [
                { Name: 'x-x402-route-action', Value: '0' },
              ],
            },
          },
        },
        RuleLabels: [{ Name: 'x402:route-matched' }],
      });
    });

    it('should use correct LockToken from GetRuleGroup response', async () => {
      // Arrange
      setupSsmMock(SIMPLE_ROUTE_CONFIG, 'old-hash');
      const customLockToken = 'custom-lock-token-xyz789';
      wafv2Mock.on(GetRuleGroupCommand).resolves({
        LockToken: customLockToken,
        RuleGroup: {
          Name: TEST_WAF_RULE_GROUP_NAME,
          Id: TEST_WAF_RULE_GROUP_ID,
          Capacity: 1000,
          ARN: 'arn:aws:wafv2:us-east-1:123456789012:global/rulegroup/test/test',
          VisibilityConfig: {
            SampledRequestsEnabled: true,
            CloudWatchMetricsEnabled: true,
            MetricName: TEST_WAF_RULE_GROUP_NAME,
          },
        },
      });
      wafv2Mock.on(UpdateRuleGroupCommand).resolves({
        NextLockToken: 'next-token',
      });

      // Act
      await handler(createSsmChangeEvent());

      // Assert: UpdateRuleGroup was called with the correct LockToken
      const updateCall = wafv2Mock.commandCalls(UpdateRuleGroupCommand)[0];
      expect(updateCall.args[0].input.LockToken).toBe(customLockToken);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3: SSM error
  // -------------------------------------------------------------------------
  describe('Scenario: SSM error', () => {
    /**
     * When SSM is unreachable, the handler should log the error and throw.
     */
    it('should throw when SSM Route_Config read fails', async () => {
      // Arrange: SSM returns error for route config
      ssmMock
        .on(GetParameterCommand, { Name: TEST_SSM_ROUTES_PATH })
        .rejects(new Error('SSM service unavailable'));

      // Act & Assert
      await expect(handler(createSsmChangeEvent())).rejects.toThrow(
        'SSM service unavailable',
      );

      // Assert: WAF should NOT be called
      expect(wafv2Mock.commandCalls(GetRuleGroupCommand)).toHaveLength(0);
      expect(wafv2Mock.commandCalls(UpdateRuleGroupCommand)).toHaveLength(0);
    });

    it('should throw when SSM hash read fails with non-ParameterNotFound error', async () => {
      // Arrange: Route config succeeds, but hash read fails with unexpected error
      ssmMock
        .on(GetParameterCommand, { Name: TEST_SSM_ROUTES_PATH })
        .resolves({
          Parameter: { Value: JSON.stringify(SIMPLE_ROUTE_CONFIG) },
        });

      const accessDeniedError = new Error('Access denied');
      accessDeniedError.name = 'AccessDeniedException';
      ssmMock
        .on(GetParameterCommand, { Name: TEST_SSM_HASH_PATH })
        .rejects(accessDeniedError);

      // Act & Assert
      await expect(handler(createSsmChangeEvent())).rejects.toThrow(
        'Access denied',
      );

      // Assert: WAF should NOT be called
      expect(wafv2Mock.commandCalls(UpdateRuleGroupCommand)).toHaveLength(0);
    });

    it('should throw when Route_Config JSON is invalid', async () => {
      // Arrange: SSM returns invalid JSON
      ssmMock
        .on(GetParameterCommand, { Name: TEST_SSM_ROUTES_PATH })
        .resolves({
          Parameter: { Value: 'not valid json {{{' },
        });

      // Act & Assert
      await expect(handler(createSsmChangeEvent())).rejects.toThrow(
        'Invalid Route_Config',
      );

      // Assert: WAF should NOT be called
      expect(wafv2Mock.commandCalls(UpdateRuleGroupCommand)).toHaveLength(0);
    });

    it('should throw when Route_Config is missing routes', async () => {
      // Arrange: SSM returns valid JSON but invalid Route_Config
      ssmMock
        .on(GetParameterCommand, { Name: TEST_SSM_ROUTES_PATH })
        .resolves({
          Parameter: { Value: JSON.stringify({ invalid: true }) },
        });

      // Act & Assert
      await expect(handler(createSsmChangeEvent())).rejects.toThrow(
        'Invalid Route_Config',
      );
    });

    it('should not throw but warn when hash storage fails after successful WAF update', async () => {
      // Arrange: WAF update succeeds, but hash storage fails
      setupSsmMock(SIMPLE_ROUTE_CONFIG, 'old-hash');
      setupWafv2Mock();

      // Override PutParameter to fail
      ssmMock.on(PutParameterCommand).rejects(new Error('SSM write failed'));

      // Act: Should NOT throw (WAF update succeeded)
      await expect(handler(createSsmChangeEvent())).resolves.toBeUndefined();

      // Assert: WAF was updated
      expect(wafv2Mock.commandCalls(UpdateRuleGroupCommand)).toHaveLength(1);

      // Assert: Warning was logged
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to store new hash'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4: WAF API error
  // -------------------------------------------------------------------------
  describe('Scenario: WAF API error', () => {
    /**
     * When the WAF API fails, the handler should log the error and throw.
     */
    it('should throw when GetRuleGroup fails', async () => {
      // Arrange
      setupSsmMock(SIMPLE_ROUTE_CONFIG, 'old-hash');
      wafv2Mock
        .on(GetRuleGroupCommand)
        .rejects(new Error('WAF rate limit exceeded'));

      // Act & Assert
      await expect(handler(createSsmChangeEvent())).rejects.toThrow(
        'WAF rate limit exceeded',
      );

      // Assert: UpdateRuleGroup should NOT be called
      expect(wafv2Mock.commandCalls(UpdateRuleGroupCommand)).toHaveLength(0);

      // Assert: Hash should NOT be stored
      expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
    });

    it('should throw when UpdateRuleGroup fails', async () => {
      // Arrange
      setupSsmMock(SIMPLE_ROUTE_CONFIG, 'old-hash');
      wafv2Mock.on(GetRuleGroupCommand).resolves({
        LockToken: TEST_LOCK_TOKEN,
        RuleGroup: {
          Name: TEST_WAF_RULE_GROUP_NAME,
          Id: TEST_WAF_RULE_GROUP_ID,
          Capacity: 1000,
          ARN: 'arn:aws:wafv2:us-east-1:123456789012:global/rulegroup/test/test',
          VisibilityConfig: {
            SampledRequestsEnabled: true,
            CloudWatchMetricsEnabled: true,
            MetricName: TEST_WAF_RULE_GROUP_NAME,
          },
        },
      });
      wafv2Mock
        .on(UpdateRuleGroupCommand)
        .rejects(new Error('WAF capacity exceeded'));

      // Act & Assert
      await expect(handler(createSsmChangeEvent())).rejects.toThrow(
        'WAF capacity exceeded',
      );

      // Assert: Hash should NOT be stored (WAF update failed)
      expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(0);
    });

    it('should throw when GetRuleGroup returns no LockToken', async () => {
      // Arrange
      setupSsmMock(SIMPLE_ROUTE_CONFIG, 'old-hash');
      wafv2Mock.on(GetRuleGroupCommand).resolves({
        LockToken: undefined,
        RuleGroup: {
          Name: TEST_WAF_RULE_GROUP_NAME,
          Id: TEST_WAF_RULE_GROUP_ID,
          Capacity: 1000,
          ARN: 'arn:aws:wafv2:us-east-1:123456789012:global/rulegroup/test/test',
          VisibilityConfig: {
            SampledRequestsEnabled: true,
            CloudWatchMetricsEnabled: true,
            MetricName: TEST_WAF_RULE_GROUP_NAME,
          },
        },
      });

      // Act & Assert
      await expect(handler(createSsmChangeEvent())).rejects.toThrow(
        'Failed to obtain LockToken',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 5: EventBridge SSM change event
  // -------------------------------------------------------------------------
  describe('Scenario: EventBridge SSM change event', () => {
    /**
     * The handler should process SSM change events and trigger sync.
     */
    it('should process SSM change event and update WAF rules', async () => {
      // Arrange
      setupSsmMock(SIMPLE_ROUTE_CONFIG, 'old-hash');
      setupWafv2Mock();

      const event = createSsmChangeEvent();

      // Act
      await handler(event);

      // Assert: Full sync flow completed
      expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(2); // routes + hash
      expect(wafv2Mock.commandCalls(GetRuleGroupCommand)).toHaveLength(1);
      expect(wafv2Mock.commandCalls(UpdateRuleGroupCommand)).toHaveLength(1);
      expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(1);
    });

    it('should log the event detail-type for SSM change events', async () => {
      // Arrange
      setupSsmMock(SIMPLE_ROUTE_CONFIG, computeHash(SIMPLE_ROUTE_CONFIG));
      setupWafv2Mock();

      // Act
      await handler(createSsmChangeEvent());

      // Assert: Event type was logged
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Parameter Store Change'),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 6: Scheduled event
  // -------------------------------------------------------------------------
  describe('Scenario: Scheduled event', () => {
    /**
     * The handler should process scheduled events and trigger sync.
     */
    it('should process scheduled event and update WAF rules when changes detected', async () => {
      // Arrange
      setupSsmMock(SIMPLE_ROUTE_CONFIG, 'old-hash');
      setupWafv2Mock();

      const event = createScheduledEvent();

      // Act
      await handler(event);

      // Assert: Full sync flow completed
      expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(2);
      expect(wafv2Mock.commandCalls(GetRuleGroupCommand)).toHaveLength(1);
      expect(wafv2Mock.commandCalls(UpdateRuleGroupCommand)).toHaveLength(1);
      expect(ssmMock.commandCalls(PutParameterCommand)).toHaveLength(1);
    });

    it('should log the event detail-type for scheduled events', async () => {
      // Arrange
      setupSsmMock(SIMPLE_ROUTE_CONFIG, computeHash(SIMPLE_ROUTE_CONFIG));
      setupWafv2Mock();

      // Act
      await handler(createScheduledEvent());

      // Assert: Event type was logged
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Scheduled Event'),
      );
    });

    it('should skip WAF update on scheduled event when no changes', async () => {
      // Arrange: Hash matches
      const currentHash = computeHash(COMPLEX_ROUTE_CONFIG);
      setupSsmMock(COMPLEX_ROUTE_CONFIG, currentHash);
      setupWafv2Mock();

      // Act
      await handler(createScheduledEvent());

      // Assert: WAF should NOT be called
      expect(wafv2Mock.commandCalls(GetRuleGroupCommand)).toHaveLength(0);
      expect(wafv2Mock.commandCalls(UpdateRuleGroupCommand)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 7: Missing environment variables
  // -------------------------------------------------------------------------
  describe('Scenario: Missing environment variables', () => {
    it('should throw when SSM_ROUTES_PATH is not set', async () => {
      // Arrange
      delete process.env.SSM_ROUTES_PATH;

      // Act & Assert
      await expect(handler(createSsmChangeEvent())).rejects.toThrow(
        'SSM_ROUTES_PATH',
      );
    });

    it('should throw when SSM_HASH_PATH is not set', async () => {
      // Arrange: Route config read succeeds
      ssmMock
        .on(GetParameterCommand, { Name: TEST_SSM_ROUTES_PATH })
        .resolves({
          Parameter: { Value: JSON.stringify(SIMPLE_ROUTE_CONFIG) },
        });
      delete process.env.SSM_HASH_PATH;

      // Act & Assert
      await expect(handler(createSsmChangeEvent())).rejects.toThrow(
        'SSM_HASH_PATH',
      );
    });

    it('should throw when WAF_RULE_GROUP_NAME is not set', async () => {
      // Arrange: Config changed, so WAF update is attempted
      setupSsmMock(SIMPLE_ROUTE_CONFIG, 'old-hash');
      delete process.env.WAF_RULE_GROUP_NAME;

      // Act & Assert
      await expect(handler(createSsmChangeEvent())).rejects.toThrow(
        'WAF_RULE_GROUP_NAME',
      );
    });

    it('should throw when WAF_RULE_GROUP_ID is not set', async () => {
      // Arrange: Config changed, so WAF update is attempted
      setupSsmMock(SIMPLE_ROUTE_CONFIG, 'old-hash');
      delete process.env.WAF_RULE_GROUP_ID;

      // Act & Assert
      await expect(handler(createSsmChangeEvent())).rejects.toThrow(
        'WAF_RULE_GROUP_ID',
      );
    });
  });
});

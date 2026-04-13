/**
 * Unit tests for config loader module
 *
 * Tests the config loader's caching behavior, SSM fetch, TTL expiry,
 * error handling, and CDP credentials loading via Secrets Manager.
 *
 * Requirements: 9.2, 9.3, 9.4
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  getEdgeConfig,
  resetCache,
  _setTtl,
  _setSsmClient,
  _setSecretsManagerClient,
  _setStackName,
  _getCache,
  _getDeployRegion,
} from '../../src/runtime/shared/config-loader';
import type { EdgeConfig } from '../../src/runtime/shared/types';
import { CdpConfig } from '../../src/runtime/shared/constants';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const EDGE_CONFIG: EdgeConfig = {
  payTo: '0x1234567890abcdef1234567890abcdef12345678',
  network: 'eip155:84532',
  facilitatorUrl: 'https://x402.org/facilitator',
};

const CDP_EDGE_CONFIG: EdgeConfig = {
  payTo: '0x1234567890abcdef1234567890abcdef12345678',
  network: 'eip155:8453',
  facilitatorUrl: CdpConfig.FACILITATOR_URL,
};

const CDP_CREDENTIALS = {
  apiKeyName: 'test-cdp-key-name',
  apiKeyPrivateKey: '-----BEGIN EC PRIVATE KEY-----\nfake-key\n-----END EC PRIVATE KEY-----',
};

const TEST_STACK_NAME = 'my-test-stack';

// ---------------------------------------------------------------------------
// Mock Helpers
// ---------------------------------------------------------------------------

function createMockSsmClient(config: EdgeConfig): {
  client: SSMClient;
  getCallCount: () => number;
  getSendMock: () => jest.Mock;
} {
  let callCount = 0;
  const sendMock = jest.fn(async (command: unknown) => {
    callCount++;
    const cmd = command as GetParameterCommand;
    const name = cmd.input?.Name ?? '';

    if (name.endsWith('/payto')) {
      return { Parameter: { Value: config.payTo } };
    }
    if (name.endsWith('/network')) {
      return { Parameter: { Value: config.network } };
    }
    if (name.endsWith('/facilitator-url')) {
      return { Parameter: { Value: config.facilitatorUrl } };
    }
    throw new Error(`Unexpected SSM parameter: ${name}`);
  });

  const client = { send: sendMock } as unknown as SSMClient;
  return { client, getCallCount: () => callCount, getSendMock: () => sendMock };
}

function createFailingSsmClient(): {
  client: SSMClient;
  getCallCount: () => number;
} {
  let callCount = 0;
  const client = {
    send: jest.fn(async () => {
      callCount++;
      throw new Error('SSM service unavailable');
    }),
  } as unknown as SSMClient;
  return { client, getCallCount: () => callCount };
}

function createMockSecretsManagerClient(credentials: { apiKeyName: string; apiKeyPrivateKey: string }): {
  client: SecretsManagerClient;
  getSendMock: () => jest.Mock;
} {
  const sendMock = jest.fn(async () => ({
    SecretString: JSON.stringify(credentials),
  }));
  const client = { send: sendMock } as unknown as SecretsManagerClient;
  return { client, getSendMock: () => sendMock };
}

function createFailingSecretsManagerClient(): {
  client: SecretsManagerClient;
} {
  const client = {
    send: jest.fn(async () => {
      throw new Error('Secrets Manager unavailable');
    }),
  } as unknown as SecretsManagerClient;
  return { client };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Config Loader', () => {
  beforeEach(() => {
    resetCache();
  });

  // -----------------------------------------------------------------------
  // Cache miss: first call fetches from AWS
  // -----------------------------------------------------------------------
  describe('cache miss: first call fetches from AWS', () => {
    it('should fetch EdgeConfig from SSM on first call (cold start)', async () => {
      const ssm = createMockSsmClient(EDGE_CONFIG);
      _setSsmClient(ssm.client);
      _setTtl(300);

      const result = await getEdgeConfig();

      expect(result).toEqual(EDGE_CONFIG);
      // SSM called 3 times: payto, network, facilitator-url
      expect(ssm.getCallCount()).toBe(3);
    });

    it('should populate cache after first fetch', async () => {
      const ssm = createMockSsmClient(EDGE_CONFIG);
      _setSsmClient(ssm.client);
      _setTtl(300);

      await getEdgeConfig();

      const cacheState = _getCache();
      expect(cacheState.edgeConfig).toEqual(EDGE_CONFIG);
      expect(cacheState.lastFetched).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Cache hit: second call within TTL uses cached value
  // -----------------------------------------------------------------------
  describe('cache hit: second call within TTL uses cached value', () => {
    it('should return cached EdgeConfig without additional API calls', async () => {
      const ssm = createMockSsmClient(EDGE_CONFIG);
      _setSsmClient(ssm.client);
      _setTtl(300);

      // First call — populates cache
      const first = await getEdgeConfig();
      expect(first).toEqual(EDGE_CONFIG);
      expect(ssm.getCallCount()).toBe(3);

      // Second call — should use cache
      const second = await getEdgeConfig();
      expect(second).toEqual(EDGE_CONFIG);
      // No additional SSM calls
      expect(ssm.getCallCount()).toBe(3);
    });

    it('should serve multiple sequential calls from cache', async () => {
      const ssm = createMockSsmClient(EDGE_CONFIG);
      _setSsmClient(ssm.client);
      _setTtl(300);

      // First call
      await getEdgeConfig();

      // 5 more calls — all should use cache
      for (let i = 0; i < 5; i++) {
        const result = await getEdgeConfig();
        expect(result).toEqual(EDGE_CONFIG);
      }

      // Only the initial 3 SSM calls
      expect(ssm.getCallCount()).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Cache expiry: call after TTL fetches fresh data
  // -----------------------------------------------------------------------
  describe('cache expiry: call after TTL fetches fresh data', () => {
    it('should fetch fresh data after TTL expires', async () => {
      // Setup with TTL=0 so cache expires immediately
      const ssm1 = createMockSsmClient(EDGE_CONFIG);
      _setSsmClient(ssm1.client);
      _setTtl(0);

      // First call — fetches EDGE_CONFIG
      const first = await getEdgeConfig();
      expect(first).toEqual(EDGE_CONFIG);

      // Swap to new config (simulating SSM parameter update)
      const updatedConfig: EdgeConfig = {
        payTo: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        network: 'eip155:8453',
        facilitatorUrl: 'https://cdp.facilitator.example.com',
      };
      const ssm2 = createMockSsmClient(updatedConfig);
      _setSsmClient(ssm2.client);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Next call should fetch fresh data
      const second = await getEdgeConfig();
      expect(second).toEqual(updatedConfig);

      // New mock should have been called
      expect(ssm2.getCallCount()).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // SSM error fallback: uses cached config if available, throws if no cache
  // -----------------------------------------------------------------------
  describe('SSM error fallback', () => {
    it('should use cached config when SSM fails after initial successful fetch', async () => {
      // First: successful fetch to populate cache
      const ssm1 = createMockSsmClient(EDGE_CONFIG);
      _setSsmClient(ssm1.client);
      _setTtl(0); // TTL=0 so cache expires immediately

      await getEdgeConfig();

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Now SSM fails
      const failingSsm = createFailingSsmClient();
      _setSsmClient(failingSsm.client);

      // Should fall back to stale cache
      const result = await getEdgeConfig();
      expect(result).toEqual(EDGE_CONFIG);
    });

    it('should throw error when SSM fails on cold start (no cache)', async () => {
      const failingSsm = createFailingSsmClient();
      _setSsmClient(failingSsm.client);
      _setTtl(300);

      // Cold start with SSM failure — should throw (caller returns 503)
      await expect(getEdgeConfig()).rejects.toThrow(
        /unable to fetch edge config and no cache available/
      );
    });

    it('should attempt to fetch even when SSM fails (verifies retry on next call)', async () => {
      const failingSsm = createFailingSsmClient();
      _setSsmClient(failingSsm.client);
      _setTtl(300);

      // First call fails
      await expect(getEdgeConfig()).rejects.toThrow();

      // Now fix SSM
      const ssm = createMockSsmClient(EDGE_CONFIG);
      _setSsmClient(ssm.client);

      // Second call should succeed
      const result = await getEdgeConfig();
      expect(result).toEqual(EDGE_CONFIG);
    });
  });

  // -----------------------------------------------------------------------
  // CDP credentials: Secrets Manager integration
  // -----------------------------------------------------------------------
  describe('CDP credentials from Secrets Manager', () => {
    it('should fetch CDP credentials when facilitator URL is CDP', async () => {
      const ssm = createMockSsmClient(CDP_EDGE_CONFIG);
      _setSsmClient(ssm.client);
      const sm = createMockSecretsManagerClient(CDP_CREDENTIALS);
      _setSecretsManagerClient(sm.client);
      _setStackName(TEST_STACK_NAME);
      _setTtl(300);

      const result = await getEdgeConfig();

      expect(result.cdpCredentials).toEqual(CDP_CREDENTIALS);
      expect(result.facilitatorUrl).toBe(CdpConfig.FACILITATOR_URL);

      // Verify Secrets Manager was called with correct secret name
      const sendMock = sm.getSendMock();
      expect(sendMock).toHaveBeenCalledTimes(1);
      const command = sendMock.mock.calls[0][0];
      expect(command.input.SecretId).toBe(
        `${CdpConfig.SECRET_PREFIX}${TEST_STACK_NAME}${CdpConfig.SECRET_SUFFIX}`,
      );
    });

    it('should NOT fetch CDP credentials when facilitator URL is x402.org', async () => {
      const ssm = createMockSsmClient(EDGE_CONFIG);
      _setSsmClient(ssm.client);
      const sm = createMockSecretsManagerClient(CDP_CREDENTIALS);
      _setSecretsManagerClient(sm.client);
      _setStackName(TEST_STACK_NAME);
      _setTtl(300);

      const result = await getEdgeConfig();

      expect(result.cdpCredentials).toBeUndefined();
      // Secrets Manager should NOT be called
      expect(sm.getSendMock()).not.toHaveBeenCalled();
    });

    it('should cache CDP credentials alongside EdgeConfig', async () => {
      const ssm = createMockSsmClient(CDP_EDGE_CONFIG);
      _setSsmClient(ssm.client);
      const sm = createMockSecretsManagerClient(CDP_CREDENTIALS);
      _setSecretsManagerClient(sm.client);
      _setStackName(TEST_STACK_NAME);
      _setTtl(300);

      // First call
      await getEdgeConfig();
      expect(sm.getSendMock()).toHaveBeenCalledTimes(1);

      // Second call should use cache
      const result = await getEdgeConfig();
      expect(result.cdpCredentials).toEqual(CDP_CREDENTIALS);
      // No additional Secrets Manager calls
      expect(sm.getSendMock()).toHaveBeenCalledTimes(1);
    });

    it('should throw when Secrets Manager fails for CDP facilitator on cold start', async () => {
      const ssm = createMockSsmClient(CDP_EDGE_CONFIG);
      _setSsmClient(ssm.client);
      const sm = createFailingSecretsManagerClient();
      _setSecretsManagerClient(sm.client);
      _setStackName(TEST_STACK_NAME);
      _setTtl(300);

      await expect(getEdgeConfig()).rejects.toThrow(
        /unable to fetch edge config and no cache available/,
      );
    });
  });

  describe('runtime config validation', () => {
    it('should reject x402.org when configured with a mainnet network', async () => {
      const ssm = createMockSsmClient({
        payTo: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'eip155:8453',
        facilitatorUrl: 'https://x402.org/facilitator',
      });
      _setSsmClient(ssm.client);
      _setTtl(300);

      await expect(getEdgeConfig()).rejects.toThrow(
        /supports only Base Sepolia and Solana Devnet/,
      );
    });

    it('should reject a pay-to address that does not match the network family', async () => {
      const ssm = createMockSsmClient({
        payTo: '7xKXtg2CW8yoW8XJshA8RM4n2nJwW9U4fGBuEXAMPLE',
        network: 'eip155:84532',
        facilitatorUrl: 'https://x402.org/facilitator',
      });
      _setSsmClient(ssm.client);
      _setTtl(300);

      await expect(getEdgeConfig()).rejects.toThrow(/not valid for EVM network/);
    });
  });

  // -----------------------------------------------------------------------
  // Deployment region derivation from function name
  // -----------------------------------------------------------------------
  describe('deployment region derivation', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      resetCache();
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should set region to null when no region prefix (us-east-1 original)', async () => {
      // When running in us-east-1 (the deploy region), function name has no prefix.
      // SDK clients keep the default region, and mock works normally.
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-stack-origin-request';
      const ssm = createMockSsmClient(EDGE_CONFIG);
      _setSsmClient(ssm.client);
      _setTtl(300);

      await getEdgeConfig();

      expect(_getDeployRegion()).toBeNull();
    });

    it('should extract deployment region and re-initialize SDK clients for replicated functions', async () => {
      // When running at an edge location, function name is prefixed with deploy region.
      // deriveFromFunctionName() should extract the region and re-initialize SDK clients,
      // replacing the mock. The real SDK client will fail (no endpoint), proving
      // clients were re-initialized with the deployment region.
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'eu-west-1.my-stack-origin-request';
      const ssm = createMockSsmClient(EDGE_CONFIG);
      _setSsmClient(ssm.client);
      _setTtl(300);

      // deriveFromFunctionName() replaces our mock with a region-aware real client
      await expect(getEdgeConfig()).rejects.toThrow();

      expect(_getDeployRegion()).toBe('eu-west-1');
      // Mock should NOT have been called — it was replaced
      expect(ssm.getCallCount()).toBe(0);
    });

    it('should extract region from origin-response function name', async () => {
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'ap-southeast-1.my-stack-origin-response';
      const ssm = createMockSsmClient(EDGE_CONFIG);
      _setSsmClient(ssm.client);
      _setTtl(300);

      await expect(getEdgeConfig()).rejects.toThrow();

      expect(_getDeployRegion()).toBe('ap-southeast-1');
    });
  });
});

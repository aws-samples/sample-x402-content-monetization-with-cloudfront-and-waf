/**
 * Unit tests for the x402 server factory function.
 *
 * Tests verify that createX402Server correctly wires together:
 * - HTTPFacilitatorClient with facilitatorConfig or { url: facilitatorUrl }
 * - x402ResourceServer with the facilitator client
 * - ExactEvmScheme or ExactSvmScheme registered for the provided network
 * - x402HTTPResourceServer constructed with resource server and routes
 * - initialize() called on the HTTP server before returning
 *
 */

import type { RoutesConfig } from '@x402/core/server';
import type { Network } from '@x402/core/types';

// ---------------------------------------------------------------------------
// Mock instances and spies
// ---------------------------------------------------------------------------

const mockInitialize = jest.fn().mockResolvedValue(undefined);

const mockHTTPFacilitatorClient = jest.fn();
const mockX402ResourceServer = jest.fn().mockImplementation(() => ({
  register: jest.fn(),
}));
const mockX402HTTPResourceServer = jest.fn().mockImplementation(() => ({
  initialize: mockInitialize,
}));
const mockExactEvmScheme = jest.fn();
const mockExactSvmScheme = jest.fn();

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

jest.mock('@x402/core/server', () => ({
  HTTPFacilitatorClient: mockHTTPFacilitatorClient,
  x402ResourceServer: mockX402ResourceServer,
  x402HTTPResourceServer: mockX402HTTPResourceServer,
}));

jest.mock('@x402/evm/exact/server', () => ({
  ExactEvmScheme: mockExactEvmScheme,
}));

jest.mock('@x402/svm/exact/server', () => ({
  ExactSvmScheme: mockExactSvmScheme,
}));

// Import after mocks are set up
import { createX402Server } from '../../src/runtime/shared/x402-server';
import type { X402ServerConfig } from '../../src/runtime/shared/x402-server';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_NETWORK: Network = 'eip155:84532' as Network;
const TEST_SOLANA_NETWORK: Network =
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as Network;
const TEST_FACILITATOR_URL = 'https://x402.org/facilitator';
const TEST_ROUTES: RoutesConfig = {
  'GET /*': {
    accepts: {
      scheme: 'exact',
      payTo: '0xTestAddress',
      price: 0.001,
      network: TEST_NETWORK,
    },
  },
} as unknown as RoutesConfig;

const TEST_CONFIG: X402ServerConfig = {
  facilitatorUrl: TEST_FACILITATOR_URL,
  network: TEST_NETWORK as string,
  routes: TEST_ROUTES,
};

const TEST_SOLANA_CONFIG: X402ServerConfig = {
  facilitatorUrl: TEST_FACILITATOR_URL,
  network: TEST_SOLANA_NETWORK as string,
  routes: {
    'GET /*': {
      accepts: {
        scheme: 'exact',
        payTo: '7xKXtg2CW8yoW8XJshA8RM4n2nJwW9U4fGBuEXAMPLE',
        price: 0.001,
        network: TEST_SOLANA_NETWORK,
      },
    },
  } as unknown as RoutesConfig,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createX402Server', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should construct HTTPFacilitatorClient with { url: facilitatorUrl } when no facilitatorConfig', async () => {
    await createX402Server(TEST_CONFIG);

    expect(mockHTTPFacilitatorClient).toHaveBeenCalledTimes(1);
    expect(mockHTTPFacilitatorClient).toHaveBeenCalledWith({ url: TEST_FACILITATOR_URL });
  });

  it('should use facilitatorConfig when provided', async () => {
    const customConfig = { url: 'https://custom.facilitator', headers: { 'X-Api-Key': 'key' } };
    await createX402Server({ ...TEST_CONFIG, facilitatorConfig: customConfig });

    expect(mockHTTPFacilitatorClient).toHaveBeenCalledTimes(1);
    expect(mockHTTPFacilitatorClient).toHaveBeenCalledWith(customConfig);
  });

  it('should construct x402ResourceServer with the facilitator client', async () => {
    const facilitatorInstance = { type: 'facilitator-client' };
    mockHTTPFacilitatorClient.mockReturnValueOnce(facilitatorInstance);

    await createX402Server(TEST_CONFIG);

    expect(mockX402ResourceServer).toHaveBeenCalledTimes(1);
    expect(mockX402ResourceServer).toHaveBeenCalledWith(facilitatorInstance);
  });

  it('should register ExactEvmScheme for the provided network', async () => {
    const schemeInstance = { type: 'exact-evm-scheme' };
    mockExactEvmScheme.mockReturnValueOnce(schemeInstance);

    await createX402Server(TEST_CONFIG);

    const resourceServerInstance = mockX402ResourceServer.mock.results[0].value;
    expect(resourceServerInstance.register).toHaveBeenCalledTimes(1);
    expect(resourceServerInstance.register).toHaveBeenCalledWith(TEST_NETWORK, schemeInstance);
  });

  it('should register ExactSvmScheme for a Solana network', async () => {
    const schemeInstance = { type: 'exact-svm-scheme' };
    mockExactSvmScheme.mockReturnValueOnce(schemeInstance);

    await createX402Server(TEST_SOLANA_CONFIG);

    const resourceServerInstance = mockX402ResourceServer.mock.results[0].value;
    expect(resourceServerInstance.register).toHaveBeenCalledTimes(1);
    expect(resourceServerInstance.register).toHaveBeenCalledWith(
      TEST_SOLANA_NETWORK,
      schemeInstance,
    );
  });

  it('should throw for an unsupported network family', async () => {
    await expect(
      createX402Server({
        ...TEST_CONFIG,
        network: 'cosmos:osmosis-1',
      }),
    ).rejects.toThrow(/Unsupported x402 network/);
  });

  it('should construct x402HTTPResourceServer with resource server and routes', async () => {
    await createX402Server(TEST_CONFIG);

    const resourceServerInstance = mockX402ResourceServer.mock.results[0].value;
    expect(mockX402HTTPResourceServer).toHaveBeenCalledTimes(1);
    expect(mockX402HTTPResourceServer).toHaveBeenCalledWith(resourceServerInstance, TEST_ROUTES);
  });

  it('should call initialize() on the HTTP server', async () => {
    await createX402Server(TEST_CONFIG);

    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  it('should return the initialized x402HTTPResourceServer instance', async () => {
    const result = await createX402Server(TEST_CONFIG);

    const httpServerInstance = mockX402HTTPResourceServer.mock.results[0].value;
    expect(result).toBe(httpServerInstance);
  });
});

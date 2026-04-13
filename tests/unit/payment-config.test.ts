import {
  assertValidEdgeConfig,
  buildExactRoutesConfig,
  isEvmAddress,
  isEvmNetwork,
  isSolanaAddress,
  isSolanaNetwork,
  isTestnetNetwork,
} from '../../src/runtime/shared/payment-config';

describe('payment-config', () => {
  it('builds an exact route config for an EVM network', () => {
    const routes = buildExactRoutesConfig(
      '0.001',
      '0x1234567890abcdef1234567890abcdef12345678',
      'eip155:84532',
    ) as Record<string, { accepts: { scheme: string; payTo: string; price: number; network: string } }>;

    expect(routes['GET /*'].accepts).toEqual({
      scheme: 'exact',
      payTo: '0x1234567890abcdef1234567890abcdef12345678',
      price: 0.001,
      network: 'eip155:84532',
    });
  });

  it('builds an exact route config for a Solana network', () => {
    const routes = buildExactRoutesConfig(
      '0.0025',
      '7xKXtg2CW8yoW8XJshA8RM4n2nJwW9U4fGBuEXAMPLE',
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    ) as Record<string, { accepts: { scheme: string; payTo: string; price: number; network: string } }>;

    expect(routes['GET /*'].accepts).toEqual({
      scheme: 'exact',
      payTo: '7xKXtg2CW8yoW8XJshA8RM4n2nJwW9U4fGBuEXAMPLE',
      price: 0.0025,
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    });
  });

  it('detects EVM and Solana network families', () => {
    expect(isEvmNetwork('eip155:8453')).toBe(true);
    expect(isEvmNetwork('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toBe(false);

    expect(isSolanaNetwork('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe(true);
    expect(isSolanaNetwork('solana-devnet')).toBe(true);
    expect(isSolanaNetwork('eip155:84532')).toBe(false);
  });

  it('detects address families and supported testnets', () => {
    expect(isEvmAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe(true);
    expect(isEvmAddress('7xKXtg2CW8yoW8XJshA8RM4n2nJwW9U4fGBuEXAMPLE')).toBe(false);

    expect(isSolanaAddress('7xKXtg2CW8yoW8XJshA8RM4n2nJwW9U4fGBuEXAMPLE')).toBe(true);
    expect(isSolanaAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe(false);

    expect(isTestnetNetwork('eip155:84532')).toBe(true);
    expect(isTestnetNetwork('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toBe(true);
    expect(isTestnetNetwork('eip155:8453')).toBe(false);
  });

  it('rejects a pay-to address that does not match the network family', () => {
    expect(() =>
      assertValidEdgeConfig({
        payTo: '7xKXtg2CW8yoW8XJshA8RM4n2nJwW9U4fGBuEXAMPLE',
        network: 'eip155:84532',
        facilitatorUrl: 'https://x402.org/facilitator',
      }),
    ).toThrow(/not valid for EVM network/);

    expect(() =>
      assertValidEdgeConfig({
        payTo: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        facilitatorUrl: 'https://x402.org/facilitator',
      }),
    ).toThrow(/not valid for Solana network/);
  });

  it('rejects x402.org on mainnet networks', () => {
    expect(() =>
      assertValidEdgeConfig({
        payTo: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'eip155:8453',
        facilitatorUrl: 'https://x402.org/facilitator',
      }),
    ).toThrow(/supports only Base Sepolia and Solana Devnet/);
  });
});

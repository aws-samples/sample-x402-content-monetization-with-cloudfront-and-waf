import type { RoutesConfig } from '@x402/core/server';
import type { Network } from '@x402/core/types';
import type { EdgeConfig } from './types';
import { CdpConfig, RouteDefaults } from './constants';

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const X402_ORG_HOST = 'x402.org';

const TESTNET_NETWORKS = new Set([
  'eip155:84532',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  'solana-devnet',
]);

/**
 * Build the single dynamic catch-all route used by the Lambda@Edge handlers.
 * WAF resolves the matching content route and injects only the price, so the
 * edge runtime reconstructs a one-route x402 config for the current request.
 */
export function buildExactRoutesConfig(
  price: string,
  payTo: string,
  network: string,
): RoutesConfig {
  return {
    [RouteDefaults.CATCH_ALL_PATTERN]: {
      accepts: {
        scheme: 'exact',
        payTo,
        price: parseFloat(price),
        network: network as Network,
      },
    },
  } as unknown as RoutesConfig;
}

/**
 * EVM networks use CAIP-2 `eip155:*` identifiers.
 */
export function isEvmNetwork(network: string): boolean {
  return network.startsWith('eip155:');
}

/**
 * Solana networks use CAIP-2 `solana:*` identifiers in x402 v2, while the SDK
 * also keeps compatibility with legacy v1 names like `solana-devnet`.
 */
export function isSolanaNetwork(network: string): boolean {
  return (
    network.startsWith('solana:') ||
    network === 'solana' ||
    network.startsWith('solana-')
  );
}

/**
 * Detect whether a pay-to address is an Ethereum-compatible address.
 */
export function isEvmAddress(address: string): boolean {
  return EVM_ADDRESS_PATTERN.test(address);
}

/**
 * Detect whether a pay-to address is a Solana base58 address.
 */
export function isSolanaAddress(address: string): boolean {
  return SOLANA_ADDRESS_PATTERN.test(address);
}

/**
 * Detect whether the configured network is one of the supported testnets.
 */
export function isTestnetNetwork(network: string): boolean {
  return TESTNET_NETWORKS.has(network);
}

/**
 * Validate cross-field compatibility for the runtime edge config loaded from SSM.
 */
export function assertValidEdgeConfig(config: EdgeConfig): void {
  if (isEvmNetwork(config.network)) {
    if (!isEvmAddress(config.payTo)) {
      throw new Error(
        `PayTo address "${config.payTo}" is not valid for EVM network "${config.network}". Expected a 0x-prefixed 20-byte address.`,
      );
    }
  } else if (isSolanaNetwork(config.network)) {
    if (!isSolanaAddress(config.payTo)) {
      throw new Error(
        `PayTo address "${config.payTo}" is not valid for Solana network "${config.network}". Expected a base58-encoded Solana address.`,
      );
    }
  } else {
    throw new Error(
      `Unsupported x402 network "${config.network}". Expected an eip155:* or solana:* network.`,
    );
  }

  if (isX402OrgFacilitator(config.facilitatorUrl) && !isTestnetNetwork(config.network)) {
    throw new Error(
      `Facilitator "${config.facilitatorUrl}" supports only Base Sepolia and Solana Devnet. Use "${CdpConfig.FACILITATOR_URL}" for mainnet deployments.`,
    );
  }
}

function isX402OrgFacilitator(facilitatorUrl: string): boolean {
  try {
    const { hostname } = new URL(facilitatorUrl);
    return hostname === X402_ORG_HOST;
  } catch {
    return facilitatorUrl.includes(X402_ORG_HOST);
  }
}

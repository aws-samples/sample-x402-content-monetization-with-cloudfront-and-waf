/**
 * CDP (Coinbase Developer Platform) JWT Authentication
 *
 * Generates JWT Bearer tokens for authenticating with the CDP facilitator.
 * Replaces the @coinbase/x402 package to avoid its LGPL-3.0 transitive
 * dependency chain (rpc-websockets via @solana/web3.js).
 *
 * Uses the `jose` library (MIT) for JWT signing with ES256 keys.
 */

import { SignJWT, importPKCS8 } from 'jose';
import { randomBytes } from 'crypto';
import type { FacilitatorConfig } from '@x402/core/server';
import { CdpConfig } from './constants';

/**
 * Generate a CDP JWT for authenticating API requests.
 *
 * The JWT follows the CDP auth spec:
 * - Algorithm: ES256
 * - Claims: sub (API key ID), iss (cdp), nbf, exp (2 min), aud (host+path), uri (full URL)
 * - Header: kid (API key ID), nonce (random hex), typ (JWT)
 *
 * @param apiKeyId - CDP API key name/ID
 * @param apiKeySecret - CDP API key private key (PEM PKCS#8)
 * @param method - HTTP method (GET, POST)
 * @param host - Target host (e.g., api.cdp.coinbase.com)
 * @param path - Target path (e.g., /platform/v2/x402/verify)
 */
async function generateCdpJwt(
  apiKeyId: string,
  apiKeySecret: string,
  method: string,
  host: string,
  path: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const uri = `${method.toUpperCase()} ${host}${path}`;
  const nonce = randomBytes(16).toString('hex');

  const privateKey = await importPKCS8(apiKeySecret, 'ES256');

  return new SignJWT({
    sub: apiKeyId,
    iss: 'cdp',
    aud: [`${host}${path}`],
    nbf: now,
    exp: now + 120,
    uri,
  })
    .setProtectedHeader({
      alg: 'ES256',
      kid: apiKeyId,
      nonce,
      typ: 'JWT',
    })
    .sign(privateKey);
}

/**
 * Create auth headers for a specific CDP facilitator endpoint.
 */
async function createEndpointHeaders(
  apiKeyId: string,
  apiKeySecret: string,
  method: string,
  path: string,
): Promise<Record<string, string>> {
  const jwt = await generateCdpJwt(
    apiKeyId,
    apiKeySecret,
    method,
    CdpConfig.FACILITATOR_HOST,
    path,
  );
  return { Authorization: `Bearer ${jwt}` };
}

/**
 * Create a FacilitatorConfig for the CDP facilitator.
 *
 * Returns a config object compatible with @x402/core's HTTPFacilitatorClient
 * that provides per-endpoint JWT auth headers.
 *
 * @param apiKeyId - CDP API key name/ID
 * @param apiKeySecret - CDP API key private key (PEM PKCS#8)
 */
export function createCdpFacilitatorConfig(
  apiKeyId: string,
  apiKeySecret: string,
): FacilitatorConfig {
  return {
    url: CdpConfig.FACILITATOR_URL,
    createAuthHeaders: async () => ({
      verify: await createEndpointHeaders(
        apiKeyId,
        apiKeySecret,
        'POST',
        `${CdpConfig.FACILITATOR_ROUTE}/verify`,
      ),
      settle: await createEndpointHeaders(
        apiKeyId,
        apiKeySecret,
        'POST',
        `${CdpConfig.FACILITATOR_ROUTE}/settle`,
      ),
      supported: await createEndpointHeaders(
        apiKeyId,
        apiKeySecret,
        'GET',
        `${CdpConfig.FACILITATOR_ROUTE}/supported`,
      ),
    }),
  };
}

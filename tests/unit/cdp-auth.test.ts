/**
 * Unit tests for the CDP JWT auth module.
 *
 * Tests verify:
 * - JWT generation produces valid ES256 tokens
 * - createCdpFacilitatorConfig returns correct FacilitatorConfig shape
 * - Auth headers are generated for verify, settle, and supported endpoints
 * - Nonce values are unique across invocations
 */

import * as crypto from 'crypto';
import type { FacilitatorConfig } from '@x402/core/server';
import { createCdpFacilitatorConfig } from '../../src/runtime/shared/cdp-auth';
import { CdpConfig } from '../../src/runtime/shared/constants';

// ---------------------------------------------------------------------------
// Test EC key pair (P-256 / ES256) - generated for testing only
// ---------------------------------------------------------------------------

let testKeyPair: { privateKey: string; publicKey: string };

beforeAll(async () => {
  // Generate a fresh P-256 key pair for tests
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  testKeyPair = { privateKey, publicKey };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
  return JSON.parse(payload);
}

function decodeJwtHeader(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  const header = Buffer.from(parts[0], 'base64url').toString('utf-8');
  return JSON.parse(header);
}

/** Endpoints for which createCdpFacilitatorConfig always supplies auth headers. */
type AuthedEndpoint = 'verify' | 'settle' | 'supported';

type AuthHeaders = Awaited<ReturnType<NonNullable<FacilitatorConfig['createAuthHeaders']>>>;

/**
 * Read the Authorization header for an endpoint, failing the test if it is
 * absent. Upstream types each endpoint as optional, but this config always sets them.
 */
function authorizationFor(headers: AuthHeaders, endpoint: AuthedEndpoint): string {
  const authorization = headers[endpoint]?.Authorization;
  if (authorization === undefined) {
    throw new Error(`expected an Authorization header for the ${endpoint} endpoint`);
  }
  return authorization;
}

/** Strip the `Bearer ` prefix to get the raw JWT for an endpoint. */
function jwtFor(headers: AuthHeaders, endpoint: AuthedEndpoint): string {
  return authorizationFor(headers, endpoint).replace('Bearer ', '');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CDP Auth - createCdpFacilitatorConfig', () => {
  it('should return FacilitatorConfig with url and createAuthHeaders', () => {
    const config = createCdpFacilitatorConfig('test-key-id', testKeyPair.privateKey);

    expect(config.url).toBe(CdpConfig.FACILITATOR_URL);
    expect(typeof config.createAuthHeaders).toBe('function');
  });

  it('should generate auth headers for verify, settle, and supported endpoints', async () => {
    const config = createCdpFacilitatorConfig('test-key-id', testKeyPair.privateKey);
    const headers = await config.createAuthHeaders!();

    expect(headers).toHaveProperty('verify');
    expect(headers).toHaveProperty('settle');
    expect(headers).toHaveProperty('supported');

    // Each should have an Authorization header with Bearer token
    expect(authorizationFor(headers, 'verify')).toMatch(/^Bearer /);
    expect(authorizationFor(headers, 'settle')).toMatch(/^Bearer /);
    expect(authorizationFor(headers, 'supported')).toMatch(/^Bearer /);
  });

  it('should produce valid JWT structure with correct claims', async () => {
    const config = createCdpFacilitatorConfig('my-api-key', testKeyPair.privateKey);
    const headers = await config.createAuthHeaders!();

    const jwt = jwtFor(headers, 'verify');
    const payload = decodeJwtPayload(jwt);
    const header = decodeJwtHeader(jwt);

    // Header checks
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe('my-api-key');
    expect(header.typ).toBe('JWT');
    expect(typeof header.nonce).toBe('string');
    expect((header.nonce as string).length).toBe(32); // 16 bytes = 32 hex chars

    // Payload checks
    expect(payload.sub).toBe('my-api-key');
    expect(payload.iss).toBe('cdp');
    expect(payload.uri).toBe(`POST ${CdpConfig.FACILITATOR_HOST}${CdpConfig.FACILITATOR_ROUTE}/verify`);
    expect(payload.aud).toEqual([`${CdpConfig.FACILITATOR_HOST}${CdpConfig.FACILITATOR_ROUTE}/verify`]);
    expect(typeof payload.nbf).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect((payload.exp as number) - (payload.nbf as number)).toBe(120);
  });

  it('should use correct HTTP methods for each endpoint', async () => {
    const config = createCdpFacilitatorConfig('key-id', testKeyPair.privateKey);
    const headers = await config.createAuthHeaders!();

    const verifyPayload = decodeJwtPayload(jwtFor(headers, 'verify'));
    const settlePayload = decodeJwtPayload(jwtFor(headers, 'settle'));
    const supportedPayload = decodeJwtPayload(jwtFor(headers, 'supported'));

    expect(verifyPayload.uri).toContain('POST');
    expect(settlePayload.uri).toContain('POST');
    expect(supportedPayload.uri).toContain('GET');
  });

  it('should use correct paths for each endpoint', async () => {
    const config = createCdpFacilitatorConfig('key-id', testKeyPair.privateKey);
    const headers = await config.createAuthHeaders!();

    const verifyPayload = decodeJwtPayload(jwtFor(headers, 'verify'));
    const settlePayload = decodeJwtPayload(jwtFor(headers, 'settle'));
    const supportedPayload = decodeJwtPayload(jwtFor(headers, 'supported'));

    expect(verifyPayload.uri).toContain('/verify');
    expect(settlePayload.uri).toContain('/settle');
    expect(supportedPayload.uri).toContain('/supported');
  });

  it('should generate unique nonces across invocations', async () => {
    const config = createCdpFacilitatorConfig('key-id', testKeyPair.privateKey);

    const headers1 = await config.createAuthHeaders!();
    const headers2 = await config.createAuthHeaders!();

    const nonce1 = decodeJwtHeader(jwtFor(headers1, 'verify')).nonce;
    const nonce2 = decodeJwtHeader(jwtFor(headers2, 'verify')).nonce;

    expect(nonce1).not.toBe(nonce2);
  });

  it('should produce three-part JWT tokens (header.payload.signature)', async () => {
    const config = createCdpFacilitatorConfig('key-id', testKeyPair.privateKey);
    const headers = await config.createAuthHeaders!();

    for (const endpoint of ['verify', 'settle', 'supported'] as const) {
      const jwt = jwtFor(headers, endpoint);
      const parts = jwt.split('.');
      expect(parts).toHaveLength(3);
      // Each part should be non-empty base64url
      for (const part of parts) {
        expect(part.length).toBeGreaterThan(0);
      }
    }
  });
});

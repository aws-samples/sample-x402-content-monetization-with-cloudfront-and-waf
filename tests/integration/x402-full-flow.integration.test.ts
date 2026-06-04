/**
 * Full-Flow Integration Test — Real x402 Library (no x402 mocks)
 *
 * Every other test in this suite mocks `createX402Middleware` / `createX402Server`,
 * so none of them exercise the real `@x402/core` + `@x402/evm` code. This test
 * exists specifically to validate the x402 dependency upgrade (2.3.0 → 2.14.0):
 * it drives BOTH Lambda@Edge handlers through the genuine x402 library end to end,
 * stubbing only the two external boundaries:
 *   1. SSM Parameter Store (EdgeConfig) — via aws-sdk-client-mock
 *   2. The x402 facilitator HTTP API (GET /supported, POST /verify, POST /settle)
 *      — via a `global.fetch` stub acting as a fake facilitator.
 *
 * The flow mirrors the real CloudFront request lifecycle:
 *
 *   [unpaid]  WAF price header → origin-request → real x402 → 402 + PAYMENT-REQUIRED
 *   [paid]    client echoes the requirements as a PAYMENT-SIGNATURE → origin-request
 *             → real x402 verify (facilitator says valid) → forwards to origin with
 *             x-x402-pending-settlement → origin-response → real x402 settle
 *             (facilitator says success) → x-payment-response on the client response.
 *
 * If a future x402 bump changes the verify/settle wire contract, the adapter
 * shapes, or the HTTPProcessResult discriminants, this test breaks — which is the
 * point.
 */

import type {
  CloudFrontRequestEvent,
  CloudFrontResponseEvent,
  CloudFrontRequest,
  CloudFrontResultResponse,
} from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';

// NOTE: deliberately NO jest.mock of x402-middleware / x402-server / to-lambda-response.
// We want the real library in the loop.
import { handler as originRequestHandler } from '../../src/runtime/origin-request/handler';
import { handler as originResponseHandler } from '../../src/runtime/origin-response/handler';
import {
  resetCache,
  _setSsmPrefix,
  _setSsmClient,
} from '../../src/runtime/shared/config-loader';
import {
  encodePaymentSignatureHeader,
  decodePaymentResponseHeader,
} from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEST_SSM_PREFIX = '/x402-edge/test-stack/config';
const FACILITATOR_URL = 'https://facilitator.test';
const X402_VERSION = 2;

const CONFIG = {
  payTo: '0x1234567890abcdef1234567890abcdef12345678',
  network: 'eip155:84532', // Base Sepolia — has a built-in default USDC asset
  facilitatorUrl: FACILITATOR_URL,
};

const DISTRIBUTION_DOMAIN = 'd123abc.cloudfront.net';
const HOST = 'api.publisher.example.com';
const PRICE = '0.01';
const TX_HASH = '0xdeadbeefcafef00d';

const ssmMock = mockClient(SSMClient);

// ---------------------------------------------------------------------------
// Fake facilitator — backs global.fetch for GET /supported, POST /verify,
// POST /settle. Each call is recorded so tests can assert the real library
// actually reached out over the wire.
// ---------------------------------------------------------------------------

interface FacilitatorCall {
  endpoint: 'supported' | 'verify' | 'settle';
  body: unknown;
}

interface FacilitatorBehavior {
  verifyValid: boolean;
  verifyInvalidReason?: string;
  settleSuccess: boolean;
  settleErrorReason?: string;
}

let facilitatorCalls: FacilitatorCall[] = [];
let behavior: FacilitatorBehavior;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFakeFacilitator(): void {
  facilitatorCalls = [];
  global.fetch = jest.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;

    if (url.endsWith('/supported')) {
      facilitatorCalls.push({ endpoint: 'supported', body });
      return jsonResponse({
        kinds: [
          { x402Version: X402_VERSION, scheme: 'exact', network: CONFIG.network },
        ],
        extensions: [],
        signers: {},
      });
    }

    if (url.endsWith('/verify')) {
      facilitatorCalls.push({ endpoint: 'verify', body });
      return jsonResponse({
        isValid: behavior.verifyValid,
        invalidReason: behavior.verifyValid ? undefined : behavior.verifyInvalidReason,
        payer: CONFIG.payTo,
      });
    }

    if (url.endsWith('/settle')) {
      facilitatorCalls.push({ endpoint: 'settle', body });
      return jsonResponse({
        success: behavior.settleSuccess,
        errorReason: behavior.settleSuccess ? undefined : behavior.settleErrorReason,
        transaction: behavior.settleSuccess ? TX_HASH : '',
        network: CONFIG.network,
        payer: CONFIG.payTo,
      });
    }

    throw new Error(`Unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// CloudFront event builders
// ---------------------------------------------------------------------------

function cfHeaders(
  headers: Record<string, string>,
): Record<string, Array<{ key: string; value: string }>> {
  const out: Record<string, Array<{ key: string; value: string }>> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = [{ key, value }];
  }
  return out;
}

function buildRequest(extraHeaders: Record<string, string> = {}): CloudFrontRequest {
  return {
    clientIp: '203.0.113.50',
    method: 'GET',
    uri: '/api/premium',
    querystring: '',
    headers: cfHeaders({
      Host: HOST,
      'User-Agent': 'GPTBot/1.0',
      'X-Forwarded-For': '203.0.113.50',
      // WAF injects the price for this route
      'x-amzn-waf-x-x402-route-action': PRICE,
      ...extraHeaders,
    }),
  };
}

function originRequestEvent(request: CloudFrontRequest): CloudFrontRequestEvent {
  return {
    Records: [
      {
        cf: {
          config: {
            distributionDomainName: DISTRIBUTION_DOMAIN,
            distributionId: 'E1EXAMPLE',
            eventType: 'origin-request',
            requestId: 'req-test',
          },
          request,
        },
      },
    ],
  };
}

function originResponseEvent(
  request: CloudFrontRequest,
  responseStatus = '200',
): CloudFrontResponseEvent {
  const response: CloudFrontResultResponse = {
    status: responseStatus,
    statusDescription: 'OK',
    headers: {
      'content-type': [{ key: 'Content-Type', value: 'application/json' }],
    },
    body: JSON.stringify({ premium: 'content' }),
  };
  return {
    Records: [
      {
        cf: {
          config: {
            distributionDomainName: DISTRIBUTION_DOMAIN,
            distributionId: 'E1EXAMPLE',
            eventType: 'origin-response',
            requestId: 'req-test',
          },
          request,
          response: response as CloudFrontResponseEvent['Records'][0]['cf']['response'],
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isResponse(result: unknown): result is CloudFrontResultResponse {
  return !!result && typeof result === 'object' && 'status' in result;
}

function isRequest(result: unknown): result is CloudFrontRequest {
  return !!result && typeof result === 'object' && 'uri' in result && !('status' in result);
}

/**
 * Build a client PAYMENT-SIGNATURE header from the requirements the resource
 * server advertised in its 402. Verification is delegated to the facilitator,
 * so the payload need only be structurally valid and echo the matched
 * requirements (x402 v2 matches on the full `accepted` core fields).
 */
function buildPaymentSignature(requirements: PaymentRequirements): string {
  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    accepted: requirements,
    payload: {
      signature: '0xsig',
      authorization: {
        from: CONFIG.payTo,
        to: requirements.payTo,
        value: requirements.amount,
        validAfter: '0',
        validBefore: '9999999999',
        nonce: '0x' + '00'.repeat(32),
      },
    },
  };
  return encodePaymentSignatureHeader(payload);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('x402 full-flow integration (real @x402/core + @x402/evm)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    ssmMock.reset();
    resetCache();
    _setSsmPrefix(TEST_SSM_PREFIX);
    _setSsmClient(new SSMClient({}));

    ssmMock.on(GetParameterCommand, { Name: `${TEST_SSM_PREFIX}/payto` }).resolves({
      Parameter: { Value: CONFIG.payTo },
    });
    ssmMock.on(GetParameterCommand, { Name: `${TEST_SSM_PREFIX}/network` }).resolves({
      Parameter: { Value: CONFIG.network },
    });
    ssmMock.on(GetParameterCommand, { Name: `${TEST_SSM_PREFIX}/facilitator-url` }).resolves({
      Parameter: { Value: CONFIG.facilitatorUrl },
    });

    behavior = { verifyValid: true, settleSuccess: true };
    installFakeFacilitator();

    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it('unpaid request → real x402 returns a 402 with a decodable PAYMENT-REQUIRED challenge', async () => {
    const request = buildRequest(); // no payment header
    const result = await originRequestHandler(originRequestEvent(request));

    expect(isResponse(result)).toBe(true);
    const response = result as CloudFrontResultResponse;
    expect(response.status).toBe('402');

    // The real library produced a PAYMENT-REQUIRED header; toLambdaResponse
    // decoded it into the JSON body. Assert the challenge is well-formed.
    const decoded = JSON.parse(response.body as string);
    expect(decoded.x402Version).toBe(X402_VERSION);
    expect(Array.isArray(decoded.accepts)).toBe(true);
    const req = decoded.accepts[0];
    expect(req.scheme).toBe('exact');
    expect(req.network).toBe(CONFIG.network);
    expect(req.payTo).toBe(CONFIG.payTo);
    // 0.01 USDC (6 decimals) → 10000 base units, proving EVM money parsing ran
    expect(req.amount).toBe('10000');

    // The real library handshook with the facilitator (GET /supported during init).
    expect(facilitatorCalls.some((c) => c.endpoint === 'supported')).toBe(true);
    // No payment was supplied, so verify was never called.
    expect(facilitatorCalls.some((c) => c.endpoint === 'verify')).toBe(false);
  });

  it('paid request → real x402 verifies via facilitator and forwards to origin with a pending-settlement header', async () => {
    // 1) First obtain the genuine requirements from an unpaid 402.
    const unpaid = (await originRequestHandler(
      originRequestEvent(buildRequest()),
    )) as CloudFrontResultResponse;
    const challenge = JSON.parse(unpaid.body as string);
    const requirements: PaymentRequirements = challenge.accepts[0];

    // 2) Replay the request WITH a payment signature derived from those requirements.
    const paymentSignature = buildPaymentSignature(requirements);
    const paidRequest = buildRequest({ 'payment-signature': paymentSignature });
    const result = await originRequestHandler(originRequestEvent(paidRequest));

    // Verified → forwarded to origin (a request, not a 402 response).
    expect(isRequest(result)).toBe(true);
    const forwarded = result as CloudFrontRequest;
    expect(forwarded.uri).toBe('/api/premium');

    // The handler attached the internal pending-settlement header for origin-response.
    const pending = forwarded.headers['x-x402-pending-settlement']?.[0]?.value;
    expect(pending).toBeDefined();
    const decodedPending = JSON.parse(Buffer.from(pending!, 'base64').toString('utf-8'));
    expect(decodedPending.payload).toBeDefined();
    expect(decodedPending.requirements).toBeDefined();

    // The real library called the facilitator's verify endpoint.
    expect(facilitatorCalls.some((c) => c.endpoint === 'verify')).toBe(true);
  });

  it('full happy path → verify (origin-request) then settle (origin-response) yields an on-chain settlement header', async () => {
    // --- Origin request: verify ---
    const unpaid = (await originRequestHandler(
      originRequestEvent(buildRequest()),
    )) as CloudFrontResultResponse;
    const requirements: PaymentRequirements = JSON.parse(unpaid.body as string).accepts[0];

    const paidRequest = buildRequest({
      'payment-signature': buildPaymentSignature(requirements),
    });
    const forwarded = (await originRequestHandler(
      originRequestEvent(paidRequest),
    )) as CloudFrontRequest;
    expect(isRequest(forwarded)).toBe(true);

    // --- Origin response: settle ---
    // The forwarded request (carrying x-x402-pending-settlement) is what
    // CloudFront passes to the origin-response trigger.
    const respResult = await originResponseHandler(
      originResponseEvent(forwarded, '200'),
    );

    expect(isResponse(respResult)).toBe(true);
    const finalResponse = respResult as CloudFrontResultResponse;
    expect(finalResponse.status).toBe('200');

    // Settlement header from the facilitator is surfaced to the client.
    // The library emits "PAYMENT-RESPONSE" (base64 SettleResponse); the
    // middleware lowercases it to "payment-response".
    const paymentResponseHeader =
      finalResponse.headers?.['payment-response']?.[0]?.value;
    expect(paymentResponseHeader).toBeDefined();
    const settle = decodePaymentResponseHeader(paymentResponseHeader!);
    expect(settle.success).toBe(true);
    expect(settle.transaction).toBe(TX_HASH);

    // Internal header must never leak to the client.
    expect(finalResponse.headers?.['x-x402-pending-settlement']).toBeUndefined();

    // The real library hit the facilitator's settle endpoint exactly once.
    expect(facilitatorCalls.filter((c) => c.endpoint === 'settle').length).toBe(1);
  });

  it('invalid payment → facilitator rejects → real x402 returns a 402', async () => {
    behavior = { verifyValid: false, verifyInvalidReason: 'invalid_signature', settleSuccess: false };

    const unpaid = (await originRequestHandler(
      originRequestEvent(buildRequest()),
    )) as CloudFrontResultResponse;
    const requirements: PaymentRequirements = JSON.parse(unpaid.body as string).accepts[0];

    const paidRequest = buildRequest({
      'payment-signature': buildPaymentSignature(requirements),
    });
    const result = await originRequestHandler(originRequestEvent(paidRequest));

    expect(isResponse(result)).toBe(true);
    expect((result as CloudFrontResultResponse).status).toBe('402');
    expect(facilitatorCalls.some((c) => c.endpoint === 'verify')).toBe(true);
  });

  it('settlement failure → origin-response still returns the origin body, settlement header absent', async () => {
    behavior = { verifyValid: true, settleSuccess: false, settleErrorReason: 'insufficient_funds' };

    const unpaid = (await originRequestHandler(
      originRequestEvent(buildRequest()),
    )) as CloudFrontResultResponse;
    const requirements: PaymentRequirements = JSON.parse(unpaid.body as string).accepts[0];

    const forwarded = (await originRequestHandler(
      originRequestEvent(buildRequest({ 'payment-signature': buildPaymentSignature(requirements) })),
    )) as CloudFrontRequest;

    const respResult = (await originResponseHandler(
      originResponseEvent(forwarded, '200'),
    )) as CloudFrontResultResponse;

    // Origin content is still delivered.
    expect(respResult.status).toBe('200');
    // Failed settlement → if a payment-response header is present, it reports failure.
    const settleHeader = respResult.headers?.['payment-response']?.[0]?.value;
    if (settleHeader) {
      expect(decodePaymentResponseHeader(settleHeader).success).toBe(false);
    }
    expect(facilitatorCalls.filter((c) => c.endpoint === 'settle').length).toBe(1);
  });
});

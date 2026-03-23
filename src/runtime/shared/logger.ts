/**
 * x402 on AWS Edge - Structured Logger for Payment Events
 *
 * Emits structured JSON log entries to CloudWatch Logs for payment
 * verification and settlement events. Uses `console.log(JSON.stringify(...))`
 * so that CloudWatch Logs Insights can query individual fields.
 *
 * When Lambda advanced logging is enabled (LogFormat: JSON), the runtime
 * automatically injects `timestamp`, `level`, and `requestId` into each
 * log entry and merges application JSON fields into the envelope.
 * Failure events use `console.error` (level: ERROR) so that Lambda's
 * ApplicationLogLevel filtering can surface them independently.
 *
 */

import type { PassthroughLogEntry, PaymentRequestedLogEntry, SettlementLogEntry, VerificationLogEntry } from './types';
import { Headers, BotDefaults, EventType } from './constants';

// ---------------------------------------------------------------------------
// Log context — common fields shared across all log entry types
// ---------------------------------------------------------------------------

export interface LogContext {
  path: string;
  price: string;
  clientIp: string;
  botHeaders: Record<string, string>;
  network: string;
}

// ---------------------------------------------------------------------------
// Bot header derivation
// ---------------------------------------------------------------------------

export function deriveActorType(botHeaders: Record<string, string>): string {
  return botHeaders[Headers.WAF_ACTOR_TYPE] || BotDefaults.ACTOR_TYPE;
}

export function deriveBotCategory(botHeaders: Record<string, string>): string {
  return botHeaders[Headers.WAF_BOT_CATEGORY] || BotDefaults.CATEGORY;
}

export function deriveBotOrganization(botHeaders: Record<string, string>): string {
  return botHeaders[Headers.WAF_BOT_ORGANIZATION] || BotDefaults.ORGANIZATION;
}

export function deriveBotName(botHeaders: Record<string, string>): string {
  return botHeaders[Headers.WAF_BOT_NAME] || BotDefaults.NAME;
}

// ---------------------------------------------------------------------------
// Shared base fields from a LogContext
// ---------------------------------------------------------------------------

function baseFields(ctx: LogContext) {
  return {
    path: ctx.path,
    price: ctx.price,
    clientIp: ctx.clientIp,
    actorType: deriveActorType(ctx.botHeaders),
    botCategory: deriveBotCategory(ctx.botHeaders),
    botOrganization: deriveBotOrganization(ctx.botHeaders),
    botName: deriveBotName(ctx.botHeaders),
    network: ctx.network,
  };
}

// ---------------------------------------------------------------------------
// Combined build-and-emit helpers (one-liner call sites in handlers)
// ---------------------------------------------------------------------------

export function emitPassthrough(path: string, clientIp: string, botHeaders: Record<string, string>): void {
  const entry: PassthroughLogEntry = {
    event: EventType.PASSTHROUGH,
    path,
    clientIp,
    actorType: deriveActorType(botHeaders),
    botCategory: deriveBotCategory(botHeaders),
    botOrganization: deriveBotOrganization(botHeaders),
    botName: deriveBotName(botHeaders),
  };
  console.log(JSON.stringify(entry));
}

export function emitPaymentRequested(ctx: LogContext): void {
  const entry: PaymentRequestedLogEntry = {
    event: EventType.PAYMENT_REQUESTED,
    ...baseFields(ctx),
    transactionHash: null,
  };
  console.log(JSON.stringify(entry));
}

export function emitVerification(
  ctx: LogContext,
  result: 'success' | 'failure',
  error: string | null,
): void {
  const entry: VerificationLogEntry = {
    event: EventType.VERIFICATION,
    ...baseFields(ctx),
    matchedRoute: ctx.path,
    result,
    error,
    transactionHash: null,
  };
  const json = JSON.stringify(entry);
  if (result === 'failure') {
    console.error(json);
  } else {
    console.log(json);
  }
}

export function emitSettlement(
  ctx: LogContext,
  result: 'success' | 'failure',
  opts?: { transactionHash?: string | null; error?: string | null },
): void {
  const entry: SettlementLogEntry = {
    event: EventType.SETTLEMENT,
    ...baseFields(ctx),
    result,
    transactionHash: opts?.transactionHash ?? null,
    error: opts?.error ?? null,
  };
  const json = JSON.stringify(entry);
  if (result === 'failure') {
    console.error(json);
  } else {
    console.log(json);
  }
}


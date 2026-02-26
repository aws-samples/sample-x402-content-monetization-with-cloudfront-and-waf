import type { CloudFrontResultResponse } from 'aws-lambda';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { Headers, ContentType, CacheControl, HttpStatus } from './constants';

export function toLambdaResponse(
  instructions: { status: number; headers: Record<string, string>; body?: unknown },
): CloudFrontResultResponse {
  const headers: CloudFrontResultResponse['headers'] = {};

  for (const [key, value] of Object.entries(instructions.headers)) {
    headers[key.toLowerCase()] = [{ key, value }];
  }

  let body: string;
  if (instructions.headers[Headers.PAYMENT_REQUIRED]) {
    const decoded = decodePaymentRequiredHeader(instructions.headers[Headers.PAYMENT_REQUIRED]);
    body = JSON.stringify(decoded);
    headers[Headers.CONTENT_TYPE] = [{ key: 'Content-Type', value: ContentType.JSON }];
  } else if (instructions.body !== undefined) {
    body = typeof instructions.body === 'string'
      ? instructions.body
      : JSON.stringify(instructions.body);
  } else {
    body = '';
  }

  if (!headers[Headers.CACHE_CONTROL]) {
    headers[Headers.CACHE_CONTROL] = [{ key: 'Cache-Control', value: CacheControl.NO_STORE }];
  }

  return {
    status: String(instructions.status),
    statusDescription: instructions.status === HttpStatus.PAYMENT_REQUIRED ? HttpStatus.PAYMENT_REQUIRED_DESCRIPTION : HttpStatus.ERROR_DESCRIPTION,
    headers,
    body,
  };
}

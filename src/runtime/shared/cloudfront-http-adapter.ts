import type { CloudFrontRequest } from 'aws-lambda';
import type { HTTPAdapter } from '@x402/core/server';
import { Headers, ContentType } from './constants';

export class CloudFrontHTTPAdapter implements HTTPAdapter {
  constructor(
    private readonly request: CloudFrontRequest,
    private readonly distributionDomain: string,
  ) {}

  getHeader(name: string): string | undefined {
    const lowerName = name.toLowerCase();
    const values = this.request.headers[lowerName];
    return values?.[0]?.value;
  }

  getMethod(): string {
    return this.request.method;
  }

  getPath(): string {
    return this.request.uri;
  }

  getUrl(): string {
    const qs = this.request.querystring ? `?${this.request.querystring}` : '';
    return `https://${this.distributionDomain}${this.request.uri}${qs}`;
  }

  getAcceptHeader(): string {
    // Always return application/json to prevent HTML paywall in Lambda@Edge
    return ContentType.JSON;
  }

  getUserAgent(): string {
    return this.getHeader(Headers.USER_AGENT) ?? '';
  }

  getQueryParams(): Record<string, string | string[]> {
    const params: Record<string, string | string[]> = {};
    if (!this.request.querystring) return params;
    const searchParams = new URLSearchParams(this.request.querystring);
    for (const [key, value] of searchParams.entries()) {
      const existing = params[key];
      if (existing) {
        params[key] = Array.isArray(existing)
          ? [...existing, value]
          : [existing, value];
      } else {
        params[key] = value;
      }
    }
    return params;
  }
}

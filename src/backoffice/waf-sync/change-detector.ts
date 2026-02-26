/**
 * Hash-based change detector for Route_Config.
 *
 * Computes a deterministic SHA-256 hash of a Route_Config object by
 * normalizing key order via sorted JSON serialization. Used by the
 * WAF_Sync_Function to skip unnecessary WAF API updates when the
 * Route_Config has not changed since the last sync.
 *
 * @module waf-sync/change-detector
 */

import { createHash } from 'node:crypto';
import type { RouteConfig } from './types';

/**
 * Recursively sorts all object keys in a value to produce a
 * deterministic JSON representation regardless of original property order.
 *
 * - Objects: keys are sorted lexicographically, values are recursed.
 * - Arrays: element order is preserved (arrays are ordered), values are recursed.
 * - Primitives: returned as-is.
 */
function sortKeys(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  return value;
}

/**
 * Translation format version. Bump this whenever the WAF rule translation
 * logic changes (e.g., switching from Allow to Count actions) so that
 * the hash changes even if the Route_Config content is identical.
 * This forces a WAF re-sync after code deploys that alter rule output.
 */
const TRANSLATION_FORMAT_VERSION = 2;

/**
 * Compute a deterministic SHA-256 hash of a Route_Config object.
 *
 * The config is first normalized by recursively sorting all object keys,
 * then serialized to JSON along with the translation format version.
 * This ensures that:
 * - Two Route_Config objects with identical content but different property
 *   ordering produce the same hash.
 * - Changes to the translation logic (bumped version) invalidate the hash
 *   even when the config content hasn't changed.
 *
 * @param config - The Route_Config to hash.
 * @returns A lowercase hex-encoded SHA-256 hash string.
 *
 * @example
 * ```typescript
 * const hash = computeHash({ routes: [{ pattern: '/**', policies: [{ condition: 'default', action: '0' }] }] });
 * // Returns a 64-character hex string like "a1b2c3d4..."
 * ```
 */
export function computeHash(config: RouteConfig): string {
  const normalized = sortKeys(config);
  const json = JSON.stringify({ v: TRANSLATION_FORMAT_VERSION, config: normalized });
  return createHash('sha256').update(json).digest('hex');
}

/**
 * Compare the current Route_Config hash against the last-synced hash
 * to determine whether a WAF update is needed.
 *
 * @param currentHash - The hash of the current Route_Config.
 * @param lastHash - The hash from the last successful WAF sync.
 * @returns `true` if the hashes differ (WAF update needed), `false` if they match (skip update).
 *
 * @example
 * ```typescript
 * const current = computeHash(newConfig);
 * const last = getStoredHash(); // from SSM parameter or WAF rule group tag
 * if (hasChanged(current, last)) {
 *   // Update WAF rules
 * }
 * ```
 */
export function hasChanged(currentHash: string, lastHash: string): boolean {
  return currentHash !== lastHash;
}

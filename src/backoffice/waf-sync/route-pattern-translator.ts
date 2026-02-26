/**
 * x402 on AWS Edge - Route Pattern Translator
 *
 * Converts glob patterns from Route_Config into WAF matching statements.
 * Used by the WAF_Sync_Function during rule generation to translate URL
 * path patterns into WAF-compatible matching logic.
 *
 * Pattern translation rules:
 * - Exact paths (no wildcards) -> ByteMatch EXACTLY (1 WCU)
 * - Trailing multi-segment wildcard -> ByteMatch STARTS_WITH (1 WCU)
 * - Trailing single-segment wildcard -> RegexMatch (3 WCU)
 * - Mid-segment wildcards -> RegexMatch (3 WCU)
 *
 */

import type { WafByteMatchStatement, WafRegexMatchStatement, WafStatement } from './types';
import { WafTextTransformation } from './constants';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default text transformation applied to all match statements. */
const DEFAULT_TEXT_TRANSFORMATIONS: WafByteMatchStatement['textTransformations'] = [
  { priority: 0, type: WafTextTransformation.NONE },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a glob pattern to a WAF statement (byte-match or regex-match).
 *
 * Uses ByteMatch (1 WCU) when possible, falls back to RegexMatch (3 WCU)
 * for patterns that ByteMatch cannot express accurately:
 *
 * - Exact paths (no wildcards) -> ByteMatch EXACTLY
 * - Trailing multi-segment wildcard -> ByteMatch STARTS_WITH
 * - Trailing single-segment wildcard -> RegexMatch
 * - Mid-segment wildcards -> RegexMatch
 *
 * @param pattern - A URL path glob pattern from Route_Config
 * @returns A WAF statement for URI path matching
 *
 */
export function toWafStatement(pattern: string): WafStatement {
  // Handle trailing /** with no other wildcards — ByteMatch STARTS_WITH
  // If the pattern has wildcards before the trailing /**, use regex instead.
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3); // Remove '/**'
    if (!prefix.includes('*')) {
      const searchString = prefix === '' ? '/' : prefix + '/';
      return { byteMatchStatement: buildStartsWithStatement(searchString) };
    }
  }

  // Any pattern with wildcards → Regex
  if (pattern.includes('*')) {
    return { regexMatchStatement: buildRegexStatement(pattern) };
  }

  // Exact path (no wildcards) — ByteMatch EXACTLY
  return { byteMatchStatement: buildExactlyStatement(pattern) };
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

// Convert a glob pattern to a regex string.
// - `**` becomes `.*` (any chars including `/` — multiple segments)
// - `*` becomes `[^/]*` (any chars except `/` — single segment)
// - Regex metacharacters in literal parts are escaped
// - Anchored with `^` and `$`
/** Maximum allowed glob pattern length to prevent ReDoS from overly complex patterns. */
const MAX_PATTERN_LENGTH = 256;
/** Maximum number of wildcard segments in a single pattern. */
const MAX_WILDCARD_SEGMENTS = 10;

function globToRegex(pattern: string): string {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`Route pattern exceeds maximum length of ${MAX_PATTERN_LENGTH}: ${pattern.slice(0, 50)}...`);
  }
  const wildcardCount = (pattern.match(/\*/g) || []).length;
  if (wildcardCount > MAX_WILDCARD_SEGMENTS) {
    throw new Error(`Route pattern exceeds maximum of ${MAX_WILDCARD_SEGMENTS} wildcard segments: ${pattern.slice(0, 50)}...`);
  }

  // Split on ** first, then handle * within each part
  const doubleStar = '\0DOUBLESTAR\0';
  let result = pattern.replace(/\*\*/g, doubleStar);

  // Escape regex metacharacters in literal parts (between wildcards)
  // Split on single * and the doublestar placeholder
  const parts = result.split(/(\*|\0DOUBLESTAR\0)/);
  result = parts
    .map((part) => {
      if (part === '*') return '[^/]*';
      if (part === doubleStar) return '.*';
      // Escape regex metacharacters in literal text
      return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');

  return `^${result}$`;
}

/**
 * Build a WAF regex-match statement from a glob pattern.
 */
function buildRegexStatement(pattern: string): WafRegexMatchStatement {
  return {
    fieldToMatch: { uriPath: {} },
    regexString: globToRegex(pattern),
    textTransformations: DEFAULT_TEXT_TRANSFORMATIONS,
  };
}

/**
 * Build a WAF byte-match statement with EXACTLY positional constraint.
 */
function buildExactlyStatement(searchString: string): WafByteMatchStatement {
  return {
    fieldToMatch: { uriPath: {} },
    positionalConstraint: 'EXACTLY',
    searchString,
    textTransformations: DEFAULT_TEXT_TRANSFORMATIONS,
  };
}

/**
 * Build a WAF byte-match statement with STARTS_WITH positional constraint.
 */
function buildStartsWithStatement(searchString: string): WafByteMatchStatement {
  return {
    fieldToMatch: { uriPath: {} },
    positionalConstraint: 'STARTS_WITH',
    searchString,
    textTransformations: DEFAULT_TEXT_TRANSFORMATIONS,
  };
}

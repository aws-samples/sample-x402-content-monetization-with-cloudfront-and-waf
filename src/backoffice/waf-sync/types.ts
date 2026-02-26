/**
 * x402 on AWS Edge - AWS WAF Sync Domain Types
 *
 * Type definitions for the Route_Config schema and AWS WAF rule translation
 * structures used by the WAF sync backoffice function.
 */

// ---------------------------------------------------------------------------
// Route Configuration Types (AWS Systems Manager Parameter Store)
// ---------------------------------------------------------------------------

/**
 * Top-level route configuration stored as JSON in SSM Parameter Store.
 * Defines URL path patterns mapped to ordered lists of condition-based
 * access policies. The WAF_Sync_Function reads this to generate WAF rules,
 * and Lambda@Edge relies on the WAF-injected price header at runtime.
 *
 */
export interface RouteConfig {
  /** Ordered list of route entries evaluated by WAF in priority order. */
  routes: RouteEntry[];
}

/**
 * A single route entry mapping a URL path pattern to a list of access
 * policies. Each route defines an ordered list of policies where the
 * first matching policy wins.
 *
 */
export interface RouteEntry {
  /**
   * URL path pattern supporting glob syntax:
   * - `*` matches a single path segment
   * - `**` matches multiple path segments
   * - Exact paths (e.g., `/pricing`) match literally
   *
   * Examples: `/api/*`, `/api/premium/**`, `/articles/**`, `/pricing`
   */
  pattern: string;

  /**
   * Ordered list of access policies. Evaluated in order; the first
   * matching policy determines the action for the request.
   */
  policies: AccessPolicy[];
}

/**
 * A condition expression that can be:
 * - A string: single WAF label match
 * - An array of strings: AND of WAF label matches
 * - { and: ConditionExpression[] }: all sub-conditions must match
 * - { or: ConditionExpression[] }: at least one sub-condition must match
 * - { not: ConditionExpression }: inverts the inner condition
 * - { namespace: string }: WAF namespace prefix match
 *
 */
export type ConditionExpression =
  | string
  | string[]
  | { and: ConditionExpression[] }
  | { or: ConditionExpression[] }
  | { not: ConditionExpression }
  | { namespace: string };

/**
 * A single condition+action entry within a route's policy list.
 * The condition matches against WAF labels/headers, and the action
 * is either a price in USD (including "0" for free) or "block".
 *
 */
export interface AccessPolicy {
  /**
   * WAF label condition to match against. Can be:
   * - A single WAF label string (e.g., `"awswaf:managed:aws:bot-control:bot:verified"`)
   * - An array of WAF label strings (all must match — AND logic)
   * - The special value `"default"` which matches any request not matched by prior policies
   * - An object with `and`, `or`, or `not` key for boolean logic on sub-conditions
   */
  condition: ConditionExpression | 'default';

  /**
   * Action to take when the condition matches:
   * - A price string in USD (e.g., `"0.001"`, `"0.01"`) — triggers x402 payment flow
   * - `"0"` — free access, no payment required
   * - `"block"` — deny access (enforced at WAF layer, never reaches Lambda@Edge)
   */
  action: string;
}

// ---------------------------------------------------------------------------
// WAF Rule Translation Types (WAF_Sync_Function)
// ---------------------------------------------------------------------------

/**
 * A translated WAF rule generated from a Route_Config Access_Policy.
 * Used by the WAF_Sync_Function to update the WAF_Rule_Group.
 *
 */
export interface WafRule {
  /** Descriptive name for the WAF rule (e.g., `"route-0-policy-1-block"`). */
  name: string;

  /**
   * Priority of the rule within the WAF_Rule_Group. Lower numbers are
   * evaluated first. Assigned based on route order then policy order
   * to ensure first-match-wins semantics.
   */
  priority: number;

  /** Combined WAF statement (URI path match + condition match). */
  statement: WafStatement;

  /**
   * WAF rule action:
   * - `"block"` — Block the request at WAF (denied requests never reach Lambda@Edge)
   * - Object with `insertHeader` — Count the request, inject a custom header with
   *   the resolved price, and add a label so subsequent rules are scope-down skipped.
   *   Uses Count action so WAF continues evaluation but the label prevents later
   *   route rules from also matching (first-match-wins via label scope-down).
   */
  action: 'block' | { insertHeader: { name: string; value: string } };

  /**
   * Custom labels to add to the request when this rule matches.
   * Used for scope-down exclusion: once a pricing rule matches and labels
   * the request, subsequent pricing rules skip it via NOT LabelMatch.
   */
  ruleLabels?: string[];
}

/**
 * A WAF byte-match statement for URI path matching. Generated from
 * glob patterns in the Route_Config by the route pattern translator.
 *
 */
export interface WafByteMatchStatement {
  /** The field to match against (always URI path for route matching). */
  fieldToMatch: { uriPath: Record<string, never> };

  /**
   * Positional constraint for the byte match:
   * - `"EXACTLY"` — exact path match (e.g., `/pricing`)
   * - `"STARTS_WITH"` — prefix match (e.g., `/api/` for `/api/*` or `/api/**`)
   */
  positionalConstraint: 'EXACTLY' | 'STARTS_WITH';

  /** The search string to match against the URI path. */
  searchString: string;

  /** Text transformations applied before matching (typically `NONE`). */
  textTransformations: Array<{ priority: number; type: string }>;
}

/**
 * A WAF regex-match statement for URI path matching. Used when glob
 * patterns contain single-segment wildcards (`*`) that ByteMatch
 * cannot express accurately. Costs 3 WCU vs 1 WCU for ByteMatch.
 *
 */
export interface WafRegexMatchStatement {
  /** The field to match against (always URI path for route matching). */
  fieldToMatch: { uriPath: Record<string, never> };

  /** The regex pattern to match against the URI path. */
  regexString: string;

  /** Text transformations applied before matching (typically `NONE`). */
  textTransformations: Array<{ priority: number; type: string }>;
}

/**
 * A composite WAF statement that combines URI path matching with
 * optional WAF label condition matching. Represents the full match
 * logic for a single WAF rule.
 *
 */
export interface WafStatement {
  /**
   * URI path byte-match statement. Present when the pattern can be
   * expressed as an exact or prefix match (exact paths, trailing `/**`).
   */
  byteMatchStatement?: WafByteMatchStatement;

  /**
   * URI path regex-match statement. Present when the pattern requires
   * regex for accurate matching (single-segment `*` wildcards, mid-segment wildcards).
   */
  regexMatchStatement?: WafRegexMatchStatement;

  /**
   * WAF label match statements for the condition. Present when the
   * Access_Policy condition is a label string or array of label strings.
   * Absent for `"default"` conditions (match any request).
   */
  labelMatchStatements?: Array<{
    /** The scope of the label match (`"LABEL"` for exact label matches, `"NAMESPACE"` for namespace prefix matches). */
    scope: 'LABEL' | 'NAMESPACE';
    /** The label key to match against. */
    key: string;
  }>;

  /**
   * Logical combination of statements when multiple conditions must
   * be matched (AND logic for multi-label conditions + URI match).
   */
  andStatement?: { statements: WafStatement[] };

  /**
   * Logical OR combination of statements when at least one condition
   * must match. Used for `{ or: [...] }` condition expressions.
   */
  orStatement?: { statements: WafStatement[] };

  /**
   * Logical NOT wrapper for scope-down exclusion or condition negation.
   * Used to skip rules when a request has already been captured by an
   * earlier Count rule (i.e., already has the `x402:route-matched` label),
   * or to negate a condition expression via `{ not: <condition> }`.
   */
  notStatement?: { statement: WafStatement };
}

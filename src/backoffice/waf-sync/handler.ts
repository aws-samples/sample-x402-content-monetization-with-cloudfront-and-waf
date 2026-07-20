/**
 * x402 on AWS Edge - WAF Sync Function Handler
 *
 * A regional Lambda function (NOT Lambda@Edge) that keeps the WAF_Rule_Group
 * in sync with the Route_Config stored in SSM Parameter Store.
 *
 * This function:
 * 1. Reads Route_Config from SSM Parameter Store
 * 2. Computes a hash of the Route_Config content
 * 3. Compares hash against the last-synced hash (stored in SSM)
 * 4. If unchanged → skips WAF update, logs "no changes detected"
 * 5. If changed → translates Route_Config to native WAF Allow/Block/Monetize
 *    rules and updates WAF_Rule_Group
 * 6. Stores the new hash for next comparison
 *
 * Triggered by:
 * - EventBridge rule matching SSM Parameter Store change events (near-instant)
 *
 * Since this is a regional Lambda (not Lambda@Edge), it CAN use environment variables:
 * - STACK_NAME: CloudFormation stack name
 * - WAF_RULE_GROUP_NAME: WAF Rule Group name
 * - WAF_RULE_GROUP_ID: WAF Rule Group ID
 * - SSM_ROUTES_PATH: Full SSM parameter path for routes config
 * - SSM_HASH_PATH: Full SSM parameter path for storing the last sync hash
 *
 */

import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import {
  WAFV2Client,
  GetRuleGroupCommand,
  UpdateRuleGroupCommand,
} from '@aws-sdk/client-wafv2';
import type { WafRule, WafStatement, WafByteMatchStatement, WafRegexMatchStatement } from './types';
import { parseRouteConfig } from './route-config-validator';
import { computeHash, hasChanged } from './change-detector';
import { translateRouteConfig } from './waf-rule-translator';
import { validateWcuCapacity } from './wcu-calculator';
import {
  WafScope,
  SsmParameterType,
  AwsErrors,
  WafEnvVars,
} from './constants';

// ---------------------------------------------------------------------------
// AWS SDK Clients (module-level singletons for connection reuse)
// ---------------------------------------------------------------------------

let ssmClient: SSMClient = new SSMClient({});
let wafv2Client: WAFV2Client = new WAFV2Client({});

// ---------------------------------------------------------------------------
// Environment Variables
// ---------------------------------------------------------------------------

/**
 * Read environment variable with fallback. Regional Lambda supports env vars.
 */
function getEnv(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Read the Route_Config JSON from SSM Parameter Store.
 */
async function readRouteConfig(): Promise<string> {
  const ssmRoutesPath = getEnv(WafEnvVars.SSM_ROUTES_PATH);
  if (!ssmRoutesPath) {
    throw new Error(`${WafEnvVars.SSM_ROUTES_PATH} environment variable is not set`);
  }

  const result = await ssmClient.send(
    new GetParameterCommand({ Name: ssmRoutesPath }),
  );

  const value = result.Parameter?.Value;
  if (!value) {
    throw new Error(`SSM parameter ${ssmRoutesPath} has no value`);
  }

  return value;
}

/**
 * Read the last-synced hash from SSM Parameter Store.
 * Returns empty string if the parameter does not exist yet (first sync).
 */
async function readLastHash(): Promise<string> {
  const ssmHashPath = getEnv(WafEnvVars.SSM_HASH_PATH);
  if (!ssmHashPath) {
    throw new Error(`${WafEnvVars.SSM_HASH_PATH} environment variable is not set`);
  }

  try {
    const result = await ssmClient.send(
      new GetParameterCommand({ Name: ssmHashPath }),
    );
    return result.Parameter?.Value ?? '';
  } catch (error: unknown) {
    // Parameter may not exist on first run — treat as empty hash
    if (
      error instanceof Error &&
      error.name === AwsErrors.PARAMETER_NOT_FOUND
    ) {
      return '';
    }
    throw error;
  }
}

/**
 * Store the new hash in SSM Parameter Store for next comparison.
 */
async function storeHash(hash: string): Promise<void> {
  const ssmHashPath = getEnv(WafEnvVars.SSM_HASH_PATH);
  if (!ssmHashPath) {
    throw new Error(`${WafEnvVars.SSM_HASH_PATH} environment variable is not set`);
  }

  await ssmClient.send(
    new PutParameterCommand({
      Name: ssmHashPath,
      Value: hash,
      Type: SsmParameterType.STRING,
      Overwrite: true,
    }),
  );
}

/**
 * Translate a WafByteMatchStatement to the AWS WAFv2 API format.
 */
function toAwsByteMatchStatement(stmt: WafByteMatchStatement): Record<string, unknown> {
  return {
    ByteMatchStatement: {
      FieldToMatch: { UriPath: {} },
      PositionalConstraint: stmt.positionalConstraint,
      SearchString: stmt.searchString,
      TextTransformations: stmt.textTransformations.map((t) => ({
        Priority: t.priority,
        Type: t.type,
      })),
    },
  };
}

/**
 * Translate a WafRegexMatchStatement to the AWS WAFv2 API format.
 */
function toAwsRegexMatchStatement(stmt: WafRegexMatchStatement): Record<string, unknown> {
  return {
    RegexMatchStatement: {
      FieldToMatch: { UriPath: {} },
      RegexString: stmt.regexString,
      TextTransformations: stmt.textTransformations.map((t) => ({
        Priority: t.priority,
        Type: t.type,
      })),
    },
  };
}

/**
 * Translate a WafStatement (our internal format) to the AWS WAFv2 API format.
 */
function toAwsStatement(statement: WafStatement): Record<string, unknown> {
  // AND statement — combine multiple sub-statements
  if (statement.andStatement) {
    return {
      AndStatement: {
        Statements: statement.andStatement.statements.map(toAwsStatement),
      },
    };
  }

  // OR statement — at least one sub-statement must match
  if (statement.orStatement) {
    return {
      OrStatement: {
        Statements: statement.orStatement.statements.map(toAwsStatement),
      },
    };
  }

  // NOT condition expression
  if (statement.notStatement) {
    return {
      NotStatement: {
        Statement: toAwsStatement(statement.notStatement.statement),
      },
    };
  }

  // Label match statements
  if (statement.labelMatchStatements && statement.labelMatchStatements.length > 0) {
    // Single label match — return directly
    if (statement.labelMatchStatements.length === 1) {
      return {
        LabelMatchStatement: {
          Scope: statement.labelMatchStatements[0].scope,
          Key: statement.labelMatchStatements[0].key,
        },
      };
    }

    // Multiple label matches — wrap in AND
    return {
      AndStatement: {
        Statements: statement.labelMatchStatements.map((lm) => ({
          LabelMatchStatement: {
            Scope: lm.scope,
            Key: lm.key,
          },
        })),
      },
    };
  }

  // Regex match statement (URI path match for single-segment wildcards)
  if (statement.regexMatchStatement) {
    return toAwsRegexMatchStatement(statement.regexMatchStatement);
  }

  // Byte match statement (URI path match)
  if (statement.byteMatchStatement) {
    return toAwsByteMatchStatement(statement.byteMatchStatement);
  }

  // Fallback — should not happen with valid rules
  throw new Error('Invalid WafStatement: no recognized statement type');
}

/**
 * Translate our internal WafRule[] to the AWS WAFv2 API Rules format.
 * All route actions are terminating native WAF actions, so rule priority
 * directly preserves first-match-wins behavior without injected headers.
 */
function toAwsRules(rules: WafRule[]): Record<string, unknown>[] {
  const routeRules = rules.map((rule) => {
    const awsRule: Record<string, unknown> = {
      Name: rule.name,
      Priority: rule.priority,
      Statement: toAwsStatement(rule.statement),
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: rule.name,
      },
    };

    if (rule.action === 'block') {
      awsRule.Action = { Block: {} };
    } else if (rule.action === 'allow') {
      awsRule.Action = { Allow: {} };
    } else {
      awsRule.Action = {
        Monetize: {
          PriceMultiplier: rule.action.monetize.priceMultiplier,
        },
      };
    }

    // Preserve any explicitly supplied labels for non-route extensions.
    if (rule.ruleLabels && rule.ruleLabels.length > 0) {
      awsRule.RuleLabels = rule.ruleLabels.map((label) => ({ Name: label }));
    }

    return awsRule;
  });

  return routeRules;
}

/**
 * Update the WAF Rule Group with the new set of rules.
 * Uses optimistic locking via LockToken from GetRuleGroup.
 */
async function updateWafRuleGroup(rules: WafRule[]): Promise<void> {
  const ruleGroupName = getEnv(WafEnvVars.WAF_RULE_GROUP_NAME);
  const ruleGroupId = getEnv(WafEnvVars.WAF_RULE_GROUP_ID);

  if (!ruleGroupName || !ruleGroupId) {
    throw new Error(
      'WAF_RULE_GROUP_NAME and WAF_RULE_GROUP_ID environment variables are required',
    );
  }

  // Get the current rule group to obtain the LockToken
  const getRuleGroupResult = await wafv2Client.send(
    new GetRuleGroupCommand({
      Name: ruleGroupName,
      Scope: WafScope.CLOUDFRONT,
      Id: ruleGroupId,
    }),
  );

  const lockToken = getRuleGroupResult.LockToken;
  if (!lockToken) {
    throw new Error('Failed to obtain LockToken from WAF Rule Group');
  }

  // Translate internal rules to AWS WAFv2 API format
  const awsRules = toAwsRules(rules);
  const monetizationConfig = getRuleGroupResult.RuleGroup?.MonetizationConfig;
  if (!monetizationConfig) {
    throw new Error('WAF Rule Group is missing the required MonetizationConfig');
  }

  // Update the rule group with the new rules
  await wafv2Client.send(
    new UpdateRuleGroupCommand({
      Name: ruleGroupName,
      Scope: WafScope.CLOUDFRONT,
      Id: ruleGroupId,
      LockToken: lockToken,
      Rules: awsRules as unknown as UpdateRuleGroupCommand['input']['Rules'],
      MonetizationConfig: monetizationConfig,
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: `${ruleGroupName}-metrics`,
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Event Type Definitions
// ---------------------------------------------------------------------------

/**
 * EventBridge event shape for SSM Parameter Store change events
 * and scheduled events.
 */
interface EventBridgeEvent {
  'detail-type'?: string;
  source?: string;
  detail?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Public API — Handler
// ---------------------------------------------------------------------------

/**
 * WAF Sync Function entry point.
 *
 * Handles both EventBridge SSM change events and scheduled events.
 * Both trigger the same sync logic:
 * 1. Read Route_Config from SSM
 * 2. Compute hash and compare against stored hash
 * 3. If changed → translate to WAF rules and update WAF_Rule_Group
 * 4. Store new hash
 *
 * @param event - EventBridge event (SSM change or scheduled)
 *
 */
export const handler = async (event: EventBridgeEvent): Promise<void> => {
  const detailType = event['detail-type'] ?? 'Unknown';
  console.log(JSON.stringify({
    message: 'WAF sync triggered',
    detailType,
    source: event.source ?? 'unknown',
  }));

  // Step 1: Read Route_Config from SSM Parameter Store
  let routeConfigJson: string;
  try {
    routeConfigJson = await readRouteConfig();
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Failed to read Route_Config from SSM',
      error: error instanceof Error ? error.message : String(error),
    }));
    throw error;
  }

  // Step 2: Parse and validate Route_Config
  const parseResult = parseRouteConfig(routeConfigJson);
  if (!parseResult.success) {
    console.error(JSON.stringify({
      message: 'Invalid Route_Config JSON',
      error: parseResult.error,
    }));
    throw new Error(`Invalid Route_Config: ${parseResult.error}`);
  }

  const routeConfig = parseResult.config;

  // Step 3: Compute hash and compare against stored hash
  const currentHash = computeHash(routeConfig);

  let lastHash: string;
  try {
    lastHash = await readLastHash();
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Failed to read last hash from SSM',
      error: error instanceof Error ? error.message : String(error),
    }));
    throw error;
  }

  // Step 4: Check if config has changed
  if (!hasChanged(currentHash, lastHash)) {
    console.log(JSON.stringify({
      message: 'No changes detected',
      hash: currentHash,
    }));
    return;
  }

  console.log(JSON.stringify({
    message: 'Changes detected, updating WAF rules',
    previousHash: lastHash,
    currentHash,
  }));

  // Step 5: Translate Route_Config to WAF rules
  const wafRules = translateRouteConfig(routeConfig);

  // Step 5b: Validate WCU capacity
  const wcuResult = validateWcuCapacity(wafRules);
  console.log(JSON.stringify({
    message: 'Translated Route_Config to WAF rules',
    ruleCount: wafRules.length,
    routeRulesWcu: wcuResult.routeRulesWcu,
    fixedOverheadWcu: wcuResult.fixedOverheadWcu,
    totalWcu: wcuResult.totalWcu,
    capacity: wcuResult.capacity,
  }));

  if (!wcuResult.valid) {
    const errorMsg = `WCU capacity exceeded: ${wcuResult.totalWcu} WCU required (${wcuResult.routeRulesWcu} route rules + ${wcuResult.fixedOverheadWcu} fixed overhead) but rule group capacity is ${wcuResult.capacity} WCU`;
    console.error(JSON.stringify({
      message: 'WCU capacity validation failed',
      totalWcu: wcuResult.totalWcu,
      routeRulesWcu: wcuResult.routeRulesWcu,
      fixedOverheadWcu: wcuResult.fixedOverheadWcu,
      capacity: wcuResult.capacity,
    }));
    throw new Error(errorMsg);
  }

  // Step 6: Update WAF Rule Group
  try {
    await updateWafRuleGroup(wafRules);
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Failed to update WAF Rule Group',
      error: error instanceof Error ? error.message : String(error),
    }));
    throw error;
  }

  console.log(JSON.stringify({
    message: 'WAF Rule Group updated successfully',
    ruleCount: wafRules.length,
  }));

  // Step 7: Store new hash for next comparison
  try {
    await storeHash(currentHash);
  } catch (error) {
    // Log but don't throw — the WAF update succeeded, and the next
    // invocation will detect the change again and skip the update
    console.warn(JSON.stringify({
      message: 'Failed to store new hash in SSM (WAF update succeeded)',
      error: error instanceof Error ? error.message : String(error),
      hash: currentHash,
    }));
  }

  console.log(JSON.stringify({
    message: 'WAF sync completed successfully',
    hash: currentHash,
    ruleCount: wafRules.length,
  }));
};

// ---------------------------------------------------------------------------
// Test Helpers (exported for testing purposes only)
// ---------------------------------------------------------------------------

/**
 * Override the SSM client. Used in tests to inject mocks.
 */
export function _setSsmClient(client: SSMClient): void {
  ssmClient = client;
}

/**
 * Override the WAFv2 client. Used in tests to inject mocks.
 */
export function _setWafv2Client(client: WAFV2Client): void {
  wafv2Client = client;
}

/**
 * Exported for testing: translate internal WafRule[] to AWS WAFv2 API format.
 */
export { toAwsRules, toAwsStatement };

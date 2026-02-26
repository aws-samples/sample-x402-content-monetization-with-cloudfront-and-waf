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
 * 5. If changed → translates Route_Config to WAF rules and updates WAF_Rule_Group
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
  WafLabels,
  ActorType,
  BotSignalHeaders,
  WafScope,
  WafTextTransformation,
  WafComparisonOperator,
  LabelMatchScope,
  GuardRule,
  SsmParameterType,
  AwsErrors,
  WafEnvVars,
} from './constants';
import { Headers } from '../../runtime/shared/constants';

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

  // NOT statement — scope-down exclusion for already-matched requests
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
 * The custom header name injected by WAF for price-based routing.
 * Used by the guard rule to detect spoofed headers.
 */
/**
 * Headers that are internal to the WAF → Lambda@Edge pipeline.
 * The guard rule blocks any request arriving with these pre-existing headers
 * to prevent clients from spoofing internal signals.
 */
const GUARDED_HEADERS = [
  Headers.ROUTE_ACTION,
  Headers.WAF_ROUTE_ACTION,
  BotSignalHeaders.ACTOR_TYPE,
  Headers.WAF_ACTOR_TYPE,
  BotSignalHeaders.BOT_CATEGORY,
  Headers.WAF_BOT_CATEGORY,
  BotSignalHeaders.BOT_NAME,
  Headers.WAF_BOT_NAME,
];

/**
 * Build a guard rule that blocks any request arriving with pre-existing
 * internal headers. These headers are set only by WAF via Count action
 * InsertHeaders. If a client sends them, they're trying to spoof signals.
 *
 * Uses SizeConstraintStatement with GE 0: if the header value has size >= 0,
 * the header exists and the request is blocked. WAF treats a missing
 * header as not matching the size constraint, so only requests that
 * actually carry the header will be blocked.
 *
 * This rule gets priority 0 so it evaluates before all route rules.
 */
function buildGuardRule(): Record<string, unknown> {
  const makeSizeCheck = (headerName: string) => ({
    SizeConstraintStatement: {
      FieldToMatch: {
        SingleHeader: { Name: headerName },
      },
      ComparisonOperator: WafComparisonOperator.GE,
      Size: 0,
      TextTransformations: [{ Priority: 0, Type: WafTextTransformation.NONE }],
    },
  });

  return {
    Name: GuardRule.NAME,
    Priority: 0,
    Statement: {
      OrStatement: {
        Statements: GUARDED_HEADERS.map(makeSizeCheck),
      },
    },
    Action: { Block: {} },
    VisibilityConfig: {
      SampledRequestsEnabled: true,
      CloudWatchMetricsEnabled: true,
      MetricName: GuardRule.NAME,
    },
  };
}

// ---------------------------------------------------------------------------
// Bot Signal Forwarding Rules
// ---------------------------------------------------------------------------

/**
 * All 16 Bot Control v5.0 category labels. Each maps to a WAF rule that inserts
 * `x-amzn-waf-bot-category: <category>` when the label is present.
 */
const BOT_CATEGORIES = [
  'search_engine',
  'ai',
  'content_fetcher',
  'social_media',
  'advertising',
  'seo',
  'monitoring',
  'security',
  'scraping_framework',
  'archiver',
  'http_library',
  'link_checker',
  'email_client',
  'page_preview',
  'webhooks',
  'miscellaneous',
] as const;

/**
 * Curated subset of bot names from AWS WAF Bot Control.
 * Each maps to a WAF rule that inserts `x-amzn-waf-bot-name: <name>`.
 * These rules evaluate after organization rules so that the specific
 * bot name overwrites the org fallback (last-match-wins).
 */
const BOT_NAMES = [
  // AI bots
  'claudebot',
  'anthropic',
  'bedrockbot',
  'cohere',
  'bytespider',
  'omgili',
  'diffbot',
  'timpibot',
  'perplexitybot',
  'perplexity-user',
  'metaexternalagent',
  'meta-externalagent',
  'meta-webindexer',
  'duckassistbot',
  'nova_act',
  // Search engine bots
  'searchbot',
  'evensi',
  'yisouspider',
  'naver',
  // Advertising bots
  'naver_ads',
  'meta-externalads',
  // Content fetcher bots
  'naver_preview',
  'censys',
  'imessage_preview',
  'imagesift',
  'meta-externalfetcher',
  'google_cloud_vertex_bot',
  // Social media bots
  'snapchat',
  'tiktok',
  // HTTP library bots
  'fasthttp',
  // Other
  'nytimes',
] as const;

/**
 * All 129 bot organizations from AWS WAF Bot Control v5.0.
 * Each maps to a WAF rule that inserts `x-amzn-waf-bot-name: org:<org>`.
 * These rules evaluate before name rules to act as a fallback — if a bot
 * has both a name and an organization label, the name rule overwrites.
 */
const BOT_ORGS = [
  'acquia',
  'adyen',
  'agencyanalytics',
  'ahrefs',
  'airo',
  'algolia',
  'amazon',
  'anthropic',
  'apple',
  'atlassian',
  'audisto',
  'automattic',
  'baidu',
  'betterstack',
  'blogvault',
  'brandwatch',
  'buttondown',
  'bytedance',
  'capjamesg',
  'censys',
  'cludo',
  'cognition',
  'common_crawl',
  'comscore',
  'cookiehub',
  'criteo',
  'datadog',
  'dataforseo',
  'designmodo',
  'digicert',
  'duckduckgo',
  'easycron',
  'elmahio',
  'facebook',
  'feedbin',
  'flipboard',
  'foxhound_systems',
  'godaddy',
  'google',
  'hetrixtools',
  'host-tracker',
  'huawei',
  'hubspot',
  'huckabuy',
  'immutable',
  'incsub',
  'isdown',
  'jumio',
  'kagiinc',
  'kalpraj_solutions',
  'line',
  'lumar',
  'magnetme',
  'majestic',
  'make',
  'marfeel',
  'marginaliasearch',
  'medialogia',
  'mediamonitoringbot',
  'microsoft',
  'monspark',
  'motominer',
  'mozilla',
  'mushi_labs',
  'naver',
  'new_relic',
  'newsblur',
  'nitropack',
  'nodeping',
  'nytimes',
  'omnisend',
  'oncrawl',
  'openai',
  'oracle',
  'paypal',
  'perplexity',
  'pinterest',
  'pressengine',
  'pro_sitemaps',
  'probely',
  'qualified',
  'qualys',
  'quantcast',
  'qwant',
  'raptive',
  'realify',
  'retool',
  'rois',
  'saasgroup',
  'se_ranking',
  'seekport',
  'semrush',
  'sentry',
  'serverhunter',
  'seznam',
  'siteimprove',
  'siteuptime',
  'skroutz',
  'slack',
  'smartbear',
  'snap',
  'sogou',
  'solarwinds',
  'sspworks',
  'stape',
  'stripe',
  'sureswiftcapital',
  'svix',
  'synopsys',
  'taboola',
  'telegram',
  'the_trade_desk',
  'updown',
  'uptimia',
  'uptrends',
  'w3c',
  'ward',
  'watchful',
  'webceo',
  'webpros',
  'wp_umbrella',
  'wpmudev',
  'x',
  'xy_planning_network',
  'yahoo',
  'yandex',
  'yext',
  'zoho',
  'zoovu',
] as const;

/**
 * Build WAF rules that forward Bot Control labels to the origin as custom
 * headers. These rules use Count action with InsertHeaders so they don't
 * terminate evaluation and the headers reach Lambda@Edge.
 *
 * Three header families are generated:
 *
 * 1. `actor-type` — trust level cascade (last match wins via header overwrite):
 *    - NAMESPACE match on `bot:category:` → `"unverified-bot"`
 *    - LABEL match on `bot:verified` → `"verified-bot"`
 *    - LABEL match on `bot:web_bot_auth:verified` → `"wba-verified-bot"`
 *
 * 2. `bot-category` — one rule per Bot Control category (16 rules):
 *    - LABEL match on `bot:category:<cat>` → `"<cat>"`
 *
 * 3. `bot-name` — organization fallback then specific name (last match wins):
 *    - LABEL match on `bot:organization:<org>` → `"org:<org>"` (fallback)
 *    - LABEL match on `bot:name:<name>` → `"<name>"` (overwrites org)
 *
 * Priorities start after the highest route rule priority to avoid conflicts.
 *
 * @param routeRules - The translated route rules (used to determine starting priority)
 * @returns Array of AWS WAFv2 rule objects for bot signal forwarding
 */
function buildBotSignalForwardingRules(routeRules: WafRule[]): Record<string, unknown>[] {
  // Start priorities after the last route rule
  const maxRoutePriority = routeRules.reduce((max, r) => Math.max(max, r.priority), 0);
  let priority = maxRoutePriority + 100;

  const rules: Record<string, unknown>[] = [];

  const makeCountWithHeader = (name: string, value: string) => ({
    Count: {
      CustomRequestHandling: {
        InsertHeaders: [{ Name: name, Value: value }],
      },
    },
  });

  const makeVisibility = (metricName: string) => ({
    SampledRequestsEnabled: true,
    CloudWatchMetricsEnabled: true,
    MetricName: metricName,
  });

  // --- actor-type cascade (lowest trust first, last match wins) ---

  // Rule 1: Any bot category → "unverified-bot"
  rules.push({
    Name: 'bot-signal-actor-type-unverified',
    Priority: priority++,
    Statement: {
      LabelMatchStatement: {
        Scope: LabelMatchScope.NAMESPACE,
        Key: WafLabels.CATEGORY,
      },
    },
    Action: makeCountWithHeader(BotSignalHeaders.ACTOR_TYPE, ActorType.UNVERIFIED_BOT),
    VisibilityConfig: makeVisibility('bot-signal-actor-type-unverified'),
  });

  // Rule 2: Verified bot → "verified-bot" (overwrites unverified)
  rules.push({
    Name: 'bot-signal-actor-type-verified',
    Priority: priority++,
    Statement: {
      LabelMatchStatement: {
        Scope: LabelMatchScope.LABEL,
        Key: WafLabels.VERIFIED,
      },
    },
    Action: makeCountWithHeader(BotSignalHeaders.ACTOR_TYPE, ActorType.VERIFIED_BOT),
    VisibilityConfig: makeVisibility('bot-signal-actor-type-verified'),
  });

  // Rule 3: WBA verified → "wba-verified-bot" (strongest signal, overwrites all)
  rules.push({
    Name: 'bot-signal-actor-type-wba-verified',
    Priority: priority++,
    Statement: {
      LabelMatchStatement: {
        Scope: LabelMatchScope.LABEL,
        Key: WafLabels.WBA_VERIFIED,
      },
    },
    Action: makeCountWithHeader(BotSignalHeaders.ACTOR_TYPE, ActorType.WBA_VERIFIED_BOT),
    VisibilityConfig: makeVisibility('bot-signal-actor-type-wba-verified'),
  });

  // --- bot-category rules (one per category) ---

  for (const category of BOT_CATEGORIES) {
    rules.push({
      Name: `bot-signal-category-${category}`,
      Priority: priority++,
      Statement: {
        LabelMatchStatement: {
          Scope: LabelMatchScope.LABEL,
          Key: `${WafLabels.CATEGORY}${category}`,
        },
      },
      Action: makeCountWithHeader(BotSignalHeaders.BOT_CATEGORY, category),
      VisibilityConfig: makeVisibility(`bot-signal-category-${category}`),
    });
  }

  // --- bot-name: organization fallback rules (evaluated first, lower priority) ---

  for (const org of BOT_ORGS) {
    rules.push({
      Name: `bot-signal-org-${org}`,
      Priority: priority++,
      Statement: {
        LabelMatchStatement: {
          Scope: LabelMatchScope.LABEL,
          Key: `${WafLabels.ORGANIZATION}${org}`,
        },
      },
      Action: makeCountWithHeader(BotSignalHeaders.BOT_NAME, `org:${org}`),
      VisibilityConfig: makeVisibility(`bot-signal-org-${org}`),
    });
  }

  // --- bot-name: specific name rules (evaluated last, overwrites org fallback) ---

  for (const name of BOT_NAMES) {
    rules.push({
      Name: `bot-signal-name-${name}`,
      Priority: priority++,
      Statement: {
        LabelMatchStatement: {
          Scope: LabelMatchScope.LABEL,
          Key: `${WafLabels.NAME}${name}`,
        },
      },
      Action: makeCountWithHeader(BotSignalHeaders.BOT_NAME, name),
      VisibilityConfig: makeVisibility(`bot-signal-name-${name}`),
    });
  }

  return rules;
}

/**
 * Translate our internal WafRule[] to the AWS WAFv2 API Rules format.
 * Prepends a guard rule that blocks requests with a spoofed
 * x-x402-route-action header. Appends bot signal forwarding rules
 * that translate Bot Control labels into custom headers for Lambda@Edge.
 */
function toAwsRules(rules: WafRule[]): Record<string, unknown>[] {
  const guardRule = buildGuardRule();
  const botSignalRules = buildBotSignalForwardingRules(rules);

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
    } else {
      // Price/free action — Count with InsertHeader custom request handling.
      // Count lets WAF continue evaluation, but the route-matched label
      // combined with scope-down NOT on subsequent rules ensures only the
      // first matching rule's header is effective (first-match-wins).
      awsRule.Action = {
        Count: {
          CustomRequestHandling: {
            InsertHeaders: [
              {
                Name: rule.action.insertHeader.name,
                Value: rule.action.insertHeader.value,
              },
            ],
          },
        },
      };
    }

    // Add rule labels for scope-down exclusion
    if (rule.ruleLabels && rule.ruleLabels.length > 0) {
      awsRule.RuleLabels = rule.ruleLabels.map((label) => ({ Name: label }));
    }

    return awsRule;
  });

  return [guardRule, ...routeRules, ...botSignalRules];
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

  // Update the rule group with the new rules
  await wafv2Client.send(
    new UpdateRuleGroupCommand({
      Name: ruleGroupName,
      Scope: WafScope.CLOUDFRONT,
      Id: ruleGroupId,
      LockToken: lockToken,
      Rules: awsRules as unknown as UpdateRuleGroupCommand['input']['Rules'],
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

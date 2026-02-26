import type { RuleGroupType, RuleType } from 'react-querybuilder';
import type { ConditionExpression, RouteConfig, EditorState, EditorRoute, EditorPolicy } from './types';

let nextId = 0;
const uid = () => `e${++nextId}`;

// --- RouteConfig → EditorState ---

export function routeConfigToEditorState(config: RouteConfig): EditorState {
  return {
    routes: config.routes.map(r => ({
      id: uid(),
      pattern: r.pattern,
      policies: r.policies.map(p => ({
        id: uid(),
        action: p.action,
        isDefault: p.condition === 'default',
        query: p.condition === 'default' ? emptyQuery() : conditionToQuery(p.condition),
      })),
    })),
  };
}

// --- EditorState → RouteConfig ---

export function editorStateToRouteConfig(state: EditorState): RouteConfig {
  return {
    version: '2',
    routes: state.routes.map(r => ({
      pattern: r.pattern,
      policies: r.policies.map(p => ({
        condition: p.isDefault ? 'default' as const : queryToCondition(p.query),
        action: p.action,
      })),
    })),
  };
}

// --- ConditionExpression → RuleGroupType ---

export function conditionToQuery(expr: ConditionExpression): RuleGroupType {
  if (typeof expr === 'string') {
    return { combinator: 'and', rules: [labelRule(expr)] };
  }
  if (Array.isArray(expr)) {
    return { combinator: 'and', rules: expr.map(labelRule) };
  }
  if ('and' in expr) {
    return { combinator: 'and', rules: expr.and.map(flattenOrRule) };
  }
  if ('or' in expr) {
    return { combinator: 'or', rules: expr.or.map(flattenOrRule) };
  }
  if ('not' in expr) {
    return { combinator: 'and', not: true, rules: [flattenOrRule(expr.not)] };
  }
  if ('namespace' in expr) {
    return { combinator: 'and', rules: [nsRule(expr.namespace)] };
  }
  return emptyQuery();
}

function flattenOrRule(expr: ConditionExpression): RuleType | RuleGroupType {
  if (typeof expr === 'string') return labelRule(expr);
  if ('namespace' in expr) return nsRule(expr.namespace);
  return conditionToQuery(expr);
}

function labelRule(value: string): RuleType {
  return { field: 'label', operator: '=', value };
}

function nsRule(value: string): RuleType {
  return { field: 'namespace', operator: '=', value };
}

export function emptyQuery(): RuleGroupType {
  return { combinator: 'and', rules: [] };
}

// --- RuleGroupType → ConditionExpression ---

export function queryToCondition(query: RuleGroupType): ConditionExpression {
  const children = query.rules.map(r =>
    'rules' in r ? queryToCondition(r as RuleGroupType) : ruleToCondition(r as RuleType),
  );

  let result: ConditionExpression;
  if (children.length === 0) {
    result = '';
  } else if (children.length === 1) {
    result = children[0];
  } else if (query.combinator === 'or') {
    result = { or: children };
  } else {
    result = { and: children };
  }

  if (query.not) {
    result = { not: result };
  }
  return result;
}

function ruleToCondition(rule: RuleType): ConditionExpression {
  if (rule.field === 'namespace') return { namespace: rule.value as string };
  return rule.value as string;
}

// --- Helpers ---

export function newEditorRoute(): EditorRoute {
  return { id: uid(), pattern: '', policies: [newEditorPolicy()] };
}

export function newEditorPolicy(isDefault = false): EditorPolicy {
  return { id: uid(), action: '0', isDefault, query: emptyQuery() };
}

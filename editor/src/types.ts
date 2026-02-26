import type { RuleGroupType } from 'react-querybuilder';

// --- Copied subset from src/shared/types.ts ---

export type ConditionExpression =
  | string
  | string[]
  | { and: ConditionExpression[] }
  | { or: ConditionExpression[] }
  | { not: ConditionExpression }
  | { namespace: string };

export interface AccessPolicy {
  condition: ConditionExpression | 'default';
  action: string;
}

export interface RouteEntry {
  pattern: string;
  policies: AccessPolicy[];
}

export interface RouteConfig {
  version?: string;
  routes: RouteEntry[];
}

// --- Editor-specific types ---

export interface EditorPolicy {
  id: string;
  action: string;
  isDefault: boolean;
  query: RuleGroupType;
}

export interface EditorRoute {
  id: string;
  pattern: string;
  policies: EditorPolicy[];
}

export interface EditorState {
  routes: EditorRoute[];
}

export interface ValidationErrors {
  [componentId: string]: string;
}

import type { RouteConfig } from './types';

const STORAGE_KEY = 'x402-editor-autosave';
const SAVED_KEY = 'x402-editor-saved';
const DRAFTS_KEY = 'x402-editor-drafts';
const MAX_DRAFTS = 5;

export interface SavedConfig {
  name: string;
  config: RouteConfig;
  savedAt: string;
}

export interface Draft {
  sessionId: string;
  config: RouteConfig;
  startedAt: string;
  updatedAt: string;
}

// --- Autosave ---

export function loadAutosave(): RouteConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveAutosave(config: RouteConfig): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* ignore */ }
}

// --- Named configs ---

export function loadSavedConfigs(): SavedConfig[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function writeSavedConfigs(configs: SavedConfig[]): void {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(configs)); } catch { /* ignore */ }
}

export function saveConfig(name: string, config: RouteConfig): SavedConfig[] {
  const configs = loadSavedConfigs();
  if (configs.some(c => c.name === name)) return configs;
  configs.unshift({ name, config, savedAt: new Date().toISOString() });
  writeSavedConfigs(configs);
  return configs;
}

export function deleteConfig(name: string): SavedConfig[] {
  const configs = loadSavedConfigs().filter(c => c.name !== name);
  writeSavedConfigs(configs);
  return configs;
}

// --- Drafts (last N sessions) ---

export function loadDrafts(): Draft[] {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function writeDrafts(drafts: Draft[]): void {
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch { /* ignore */ }
}

export function createSession(): string {
  const sessionId = new Date().toISOString();
  return sessionId;
}

function configHash(config: RouteConfig): string {
  const json = JSON.stringify(config);
  // Simple djb2 hash — fast, good enough for equality checks
  let hash = 5381;
  for (let i = 0; i < json.length; i++) {
    hash = ((hash << 5) + hash + json.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

export function saveDraft(sessionId: string, config: RouteConfig): Draft[] {
  const drafts = loadDrafts();
  const hash = configHash(config);
  const existing = drafts.find(d => d.sessionId === sessionId);

  // Our session draft exists and content unchanged — just touch timestamp
  if (existing && configHash(existing.config) === hash) {
    existing.updatedAt = new Date().toISOString();
    writeDrafts(drafts);
    return drafts;
  }

  // No draft for this session yet, and most recent draft from another session
  // has identical content — skip to avoid duplicates on refresh-without-edit
  if (!existing && drafts.length > 0 && configHash(drafts[0].config) === hash) {
    return drafts;
  }

  // Update existing session draft or create new one
  if (existing) {
    existing.config = config;
    existing.updatedAt = new Date().toISOString();
  } else {
    drafts.unshift({ sessionId, config, startedAt: sessionId, updatedAt: new Date().toISOString() });
  }
  const trimmed = drafts.slice(0, MAX_DRAFTS);
  writeDrafts(trimmed);
  return trimmed;
}

export function deleteDraft(sessionId: string): Draft[] {
  const drafts = loadDrafts().filter(d => d.sessionId !== sessionId);
  writeDrafts(drafts);
  return drafts;
}

// --- URL sharing ---

export function encodeConfigToUrl(config: RouteConfig): string {
  const json = JSON.stringify(config);
  const encoded = btoa(unescape(encodeURIComponent(json)));
  const url = new URL(window.location.href);
  url.searchParams.set('config', encoded);
  return url.toString();
}

export function decodeConfigFromUrl(): RouteConfig | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const encoded = params.get('config');
    if (!encoded) return null;
    const json = decodeURIComponent(escape(atob(encoded)));
    const config = JSON.parse(json);
    if (!config.routes || !Array.isArray(config.routes)) return null;
    return config;
  } catch { return null; }
}

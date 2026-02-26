import { useState } from 'react';
import type { RouteConfig } from '../types';
import { loadSavedConfigs, saveConfig, deleteConfig, loadDrafts, deleteDraft, encodeConfigToUrl, type SavedConfig, type Draft } from '../storage';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Button from '@cloudscape-design/components/button';
import Input from '@cloudscape-design/components/input';
import Alert from '@cloudscape-design/components/alert';
import Tabs from '@cloudscape-design/components/tabs';

interface Props {
  config: RouteConfig;
  onLoad: (config: RouteConfig) => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

export function SavedConfigs({ config, onLoad }: Props) {
  const [configs, setConfigs] = useState<SavedConfig[]>(loadSavedConfigs);
  const [drafts, setDrafts] = useState<Draft[]>(loadDrafts);
  const [name, setName] = useState('');
  const [copied, setCopied] = useState(false);

  const nameExists = configs.some(c => c.name === name.trim());

  const handleSave = () => {
    const n = name.trim();
    if (!n || nameExists) return;
    setConfigs(saveConfig(n, config));
    setName('');
  };

  const handleShare = () => {
    const url = encodeConfigToUrl(config);
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const shareConfig = (c: RouteConfig) => {
    const url = encodeConfigToUrl(c);
    navigator.clipboard.writeText(url);
  };

  return (
    <ExpandableSection headerText={`Saved Configs (${configs.length}) · Drafts (${drafts.length})`} defaultExpanded={false}>
      <SpaceBetween size="s">
        <SpaceBetween size="xs" direction="horizontal">
          <div style={{ flexGrow: 1 }}>
            <Input
              value={name}
              onChange={({ detail }) => setName(detail.value)}
              placeholder="Config name…"
              invalid={nameExists}
              onKeyDown={({ detail }) => { if (detail.key === 'Enter') handleSave(); }}
            />
            {nameExists && <span style={{ color: '#d91515', fontSize: 12 }}>Name already exists</span>}
          </div>
          <Button onClick={handleSave} variant="primary" disabled={!name.trim() || nameExists}>Save</Button>
          <Button onClick={handleShare} iconName="share">
            {copied ? 'URL Copied!' : 'Share'}
          </Button>
        </SpaceBetween>

        {copied && <Alert type="success">Shareable URL copied to clipboard.</Alert>}

        <Tabs tabs={[
          {
            id: 'saved',
            label: `Saved (${configs.length})`,
            content: configs.length === 0
              ? <span style={{ color: '#5f6b7a', fontSize: 13 }}>No saved configs yet.</span>
              : (
                <div style={{ maxHeight: 180, overflow: 'auto' }}>
                  <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                    <tbody>
                      {configs.map(c => (
                        <tr key={c.name} style={{ borderBottom: '1px solid #e9ebed' }}>
                          <td style={{ padding: '4px 8px', fontWeight: 500 }}>{c.name}</td>
                          <td style={{ padding: '4px 8px', color: '#5f6b7a', fontSize: 12 }}>{formatTime(c.savedAt)}</td>
                          <td style={{ padding: '4px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <SpaceBetween size="xs" direction="horizontal">
                              <Button onClick={() => onLoad(c.config)} variant="inline-link">Load</Button>
                              <Button onClick={() => shareConfig(c.config)} variant="inline-link">Share</Button>
                              <Button onClick={() => setConfigs(deleteConfig(c.name))} variant="inline-link">Delete</Button>
                            </SpaceBetween>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ),
          },
          {
            id: 'drafts',
            label: `Drafts (${drafts.length})`,
            content: drafts.length === 0
              ? <span style={{ color: '#5f6b7a', fontSize: 13 }}>No drafts yet. Drafts are auto-saved per session (last 5 kept).</span>
              : (
                <div style={{ maxHeight: 180, overflow: 'auto' }}>
                  <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                    <tbody>
                      {drafts.map(d => (
                        <tr key={d.sessionId} style={{ borderBottom: '1px solid #e9ebed' }}>
                          <td style={{ padding: '4px 8px', fontWeight: 500, fontSize: 12 }}>
                            Session {formatTime(d.startedAt)}
                          </td>
                          <td style={{ padding: '4px 8px', color: '#5f6b7a', fontSize: 12 }}>
                            updated {formatTime(d.updatedAt)}
                          </td>
                          <td style={{ padding: '4px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <SpaceBetween size="xs" direction="horizontal">
                              <Button onClick={() => onLoad(d.config)} variant="inline-link">Load</Button>
                              <Button onClick={() => shareConfig(d.config)} variant="inline-link">Share</Button>
                              <Button onClick={() => setDrafts(deleteDraft(d.sessionId))} variant="inline-link">Delete</Button>
                            </SpaceBetween>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ),
          },
        ]} />
      </SpaceBetween>
    </ExpandableSection>
  );
}

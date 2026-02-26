import { useMemo, useEffect, useRef } from 'react';
import type { RouteConfig, EditorState } from './types';
import { editorStateToRouteConfig, routeConfigToEditorState } from './transform';
import { validate } from './validate';
import { loadAutosave, saveAutosave, decodeConfigFromUrl, createSession, saveDraft } from './storage';
import { useHistory } from './use-history';
import { RouteList } from './components/RouteList';
import { JsonPreview } from './components/JsonPreview';
import { HelpGuide } from './components/HelpGuide';
import { SavedConfigs } from './components/SavedConfigs';
import { AwsConsoleLinks } from './components/AwsConsoleLinks';
import AppLayout from '@cloudscape-design/components/app-layout';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Grid from '@cloudscape-design/components/grid';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Button from '@cloudscape-design/components/button';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import defaultConfig from '../../config/default-routes.json';
import { estimateTotalWcu } from './wcu-calculator';

function getInitialState(): EditorState {
  const urlConfig = decodeConfigFromUrl();
  if (urlConfig) {
    const url = new URL(window.location.href);
    url.searchParams.delete('config');
    window.history.replaceState({}, '', url.toString());
    return routeConfigToEditorState(urlConfig);
  }
  const saved = loadAutosave();
  if (saved) return routeConfigToEditorState(saved);
  return routeConfigToEditorState(defaultConfig);
}

export default function App() {
  const { state, setState, undo, canUndo, reset, clear, markCheckpoint } = useHistory(getInitialState());
  const sessionId = useRef(createSession());
  const config = useMemo(() => editorStateToRouteConfig(state), [state]);
  const configJson = useMemo(() => JSON.stringify(config), [config]);
  const errors = useMemo(() => validate(state), [state]);
  const wcuEstimate = useMemo(() => estimateTotalWcu(state), [state]);

  // Autosave + draft on every change
  useEffect(() => {
    saveAutosave(config);
    saveDraft(sessionId.current, config);
  }, [configJson]);

  const loadConfig = (c: RouteConfig) => {
    setState(routeConfigToEditorState(c));
    markCheckpoint();
  };

  return (
    <AppLayout
      navigationHide
      toolsHide
      content={
        <ContentLayout header={<Header variant="h1">x402 Route Config Editor</Header>}>
          <SpaceBetween size="l">
            <HelpGuide />
            <SpaceBetween size="s">
              <SavedConfigs config={config} onLoad={loadConfig} />
              <AwsConsoleLinks />
              <SpaceBetween direction="horizontal" size="xs">
                <Button iconName="undo" disabled={!canUndo} onClick={undo}>Undo</Button>
                <Button iconName="refresh" onClick={reset}>Reset</Button>
                <Button iconName="remove" onClick={clear}>Clear All</Button>
                <Button variant="normal" onClick={() => loadConfig(defaultConfig)}>Load Defaults</Button>
              </SpaceBetween>
            </SpaceBetween>
            <ProgressBar
              value={Math.min((wcuEstimate.totalWcu / wcuEstimate.capacity) * 100, 100)}
              additionalInfo={`~${wcuEstimate.routeRulesWcu} route rules + ${wcuEstimate.fixedOverheadWcu} fixed overhead`}
              description={`~${wcuEstimate.totalWcu} / ${wcuEstimate.capacity} WCU`}
              label="WAF Capacity"
              status={
                wcuEstimate.totalWcu > wcuEstimate.capacity
                  ? 'error'
                  : wcuEstimate.totalWcu > wcuEstimate.capacity * 0.8
                    ? 'in-progress'
                    : 'success'
              }
              resultText={
                wcuEstimate.totalWcu > wcuEstimate.capacity
                  ? `Over capacity by ${wcuEstimate.totalWcu - wcuEstimate.capacity} WCU`
                  : undefined
              }
            />
            <Grid gridDefinition={[{ colspan: 8 }, { colspan: 4 }]}>
              <RouteList state={state} errors={errors} onChange={setState} />
              <JsonPreview config={config} errors={errors} onImport={setState} />
            </Grid>
          </SpaceBetween>
        </ContentLayout>
      }
    />
  );
}

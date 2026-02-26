import { useState, useEffect, useRef } from 'react';
import type { RouteConfig, EditorState, ValidationErrors } from '../types';
import { routeConfigToEditorState } from '../transform';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Button from '@cloudscape-design/components/button';
import Alert from '@cloudscape-design/components/alert';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Textarea from '@cloudscape-design/components/textarea';

interface Props {
  config: RouteConfig;
  errors: ValidationErrors;
  onImport: (state: EditorState) => void;
}

export function JsonPreview({ config, errors, onImport }: Props) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [parseError, setParseError] = useState('');
  const hasErrors = Object.keys(errors).length > 0;
  const configJson = JSON.stringify(config, null, 2);
  const prevConfigRef = useRef(configJson);

  // Sync external config changes into the textarea when not editing
  useEffect(() => {
    if (!editing) {
      setDraft(configJson);
      prevConfigRef.current = configJson;
    } else if (configJson !== prevConfigRef.current) {
      // Config changed externally while editing — reset to avoid conflicts
      setDraft(configJson);
      setEditing(false);
      setParseError('');
      prevConfigRef.current = configJson;
    }
  }, [configJson, editing]);

  const copy = () => {
    navigator.clipboard.writeText(JSON.stringify(config)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const handleChange = (value: string) => {
    setDraft(value);
    setEditing(true);
    setParseError('');
  };

  const handleApply = () => {
    try {
      const parsed = JSON.parse(draft) as RouteConfig;
      if (!parsed.routes || !Array.isArray(parsed.routes)) {
        setParseError('Invalid config: missing "routes" array');
        return;
      }
      onImport(routeConfigToEditorState(parsed));
      setEditing(false);
      setParseError('');
    } catch (e) {
      setParseError(`Parse error: ${(e as Error).message}`);
    }
  };

  const handleDiscard = () => {
    setDraft(configJson);
    setEditing(false);
    setParseError('');
  };

  return (
    <Container
      header={
        <Header
          variant="h2"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              {editing && (
                <>
                  <Button onClick={handleDiscard}>Discard</Button>
                  <Button onClick={handleApply} variant="primary">Apply</Button>
                </>
              )}
              <Button onClick={copy} iconName={copied ? 'status-positive' : 'copy'} disabled={hasErrors}>
                {copied ? 'Copied!' : 'Copy'}
              </Button>
            </SpaceBetween>
          }
        >
          JSON {editing ? '(editing)' : 'Output'}
        </Header>
      }
    >
      <SpaceBetween size="s">
        {errors['global'] && <Alert type="error">{errors['global']}</Alert>}
        {hasErrors && !errors['global'] && (
          <Alert type="warning">Config has validation errors. Fix them before deploying.</Alert>
        )}
        {parseError && <Alert type="error">{parseError}</Alert>}
        <Textarea
          value={draft}
          onChange={({ detail }) => handleChange(detail.value)}
          rows={24}
          ariaLabel="JSON configuration"
        />
      </SpaceBetween>
    </Container>
  );
}

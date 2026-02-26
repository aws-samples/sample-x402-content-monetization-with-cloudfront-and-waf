import type { EditorRoute, EditorPolicy, ValidationErrors } from '../types';
import type { DraggableProvidedDragHandleProps } from '@hello-pangea/dnd';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import { PolicyEditor } from './PolicyEditor';
import { newEditorPolicy } from '../transform';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Button from '@cloudscape-design/components/button';
import Input from '@cloudscape-design/components/input';
import FormField from '@cloudscape-design/components/form-field';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';

function policySummary(policies: EditorPolicy[]): string {
  const parts = policies.map(p => {
    const label = p.isDefault ? 'default' : 'condition';
    if (p.action === 'block') return `🚫 ${label}→block`;
    if (p.action === '0') return `✅ ${label}→free`;
    return `💲 ${label}→$${p.action}`;
  });
  return parts.join('  ·  ');
}

interface Props {
  route: EditorRoute;
  index: number;
  errors: ValidationErrors;
  expanded: boolean;
  onToggle: () => void;
  onChange: (route: EditorRoute) => void;
  onRemove: () => void;
  dragHandleProps: DraggableProvidedDragHandleProps | null | undefined;
}

export function RouteEditor({ route, index, errors, expanded, onToggle, onChange, onRemove, dragHandleProps }: Props) {
  const patternErr = errors[`${route.id}-pattern`];
  const routeErrors = ['policies', 'defaults', 'default-pos', 'dup-condition']
    .map(k => errors[`${route.id}-${k}`])
    .filter(Boolean);

  const updatePolicy = (idx: number, policy: EditorPolicy) => {
    const policies = [...route.policies];
    policies[idx] = policy;
    onChange({ ...route, policies });
  };

  const removePolicy = (idx: number) => {
    onChange({ ...route, policies: route.policies.filter((_, i) => i !== idx) });
  };

  const onPolicyDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    const policies = [...route.policies];
    const [moved] = policies.splice(result.source.index, 1);
    policies.splice(result.destination.index, 0, moved);
    onChange({ ...route, policies });
  };

  return (
    <div style={{ borderLeft: '4px solid #0972d3', borderRadius: 4 }}>
      <Container
        header={
          <Header
            variant="h2"
            actions={
              <SpaceBetween size="xxs" direction="horizontal">
                <Button onClick={onToggle} variant="icon" iconName={expanded ? 'angle-up' : 'angle-down'} />
                <Button onClick={onRemove} iconName="remove" variant="icon" />
              </SpaceBetween>
            }
          >
            <span style={{ cursor: 'pointer' }} onClick={onToggle}>
              <SpaceBetween size="xs" direction="horizontal">
                <span {...(dragHandleProps ?? {})} style={{ cursor: 'grab', fontSize: 18, userSelect: 'none' }} title="Drag to reorder route" onClick={e => e.stopPropagation()}>⠿</span>
                <Badge color="blue">#{index + 1}</Badge>
                <span style={{ fontFamily: 'monospace' }}>{route.pattern || '(no pattern)'}</span>
                {!expanded && (
                  <span style={{ fontSize: 12, color: '#5f6b7a' }}>
                    — {route.policies.length} {route.policies.length === 1 ? 'policy' : 'policies'}
                  </span>
                )}
              </SpaceBetween>
            </span>
          </Header>
        }
      >
        {!expanded ? (
          <div style={{ fontSize: 13, color: '#5f6b7a', padding: '2px 0' }}>
            {policySummary(route.policies)}
          </div>
        ) : (
          <SpaceBetween size="s">
            <FormField label="URL Pattern" errorText={patternErr}>
              <Input
                value={route.pattern}
                onChange={({ detail }) => onChange({ ...route, pattern: detail.value })}
                placeholder="/api/**"
              />
            </FormField>

            {routeErrors.map((err, i) => (
              <Alert key={i} type="warning">{err}</Alert>
            ))}

            <div style={{ fontSize: 13, color: '#5f6b7a', fontWeight: 500 }}>
              Policies — drag to reorder, evaluated top → bottom ({route.policies.length})
            </div>

            <div style={{ paddingLeft: 16 }}>
              <DragDropContext onDragEnd={onPolicyDragEnd}>
                <Droppable droppableId={`policies-${route.id}`}>
                  {(provided) => (
                    <div ref={provided.innerRef} {...provided.droppableProps}>
                      {route.policies.map((policy, idx) => (
                        <Draggable key={policy.id} draggableId={policy.id} index={idx}>
                          {(provided, snapshot) => (
                            <div
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              style={{ ...provided.draggableProps.style, marginBottom: 4, opacity: snapshot.isDragging ? 0.85 : 1 }}
                            >
                              <PolicyEditor
                                policy={policy}
                                index={idx}
                                errors={errors}
                                onChange={p => updatePolicy(idx, p)}
                                onRemove={() => removePolicy(idx)}
                                dragHandleProps={provided.dragHandleProps}
                              />
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </DragDropContext>
            </div>

            <SpaceBetween size="xs" direction="horizontal">
              <Button onClick={() => onChange({ ...route, policies: [...route.policies, newEditorPolicy()] })} iconName="add-plus" variant="normal">
                Policy
              </Button>
              <Button onClick={() => onChange({ ...route, policies: [...route.policies, newEditorPolicy(true)] })} variant="link">
                + Default (fallback)
              </Button>
            </SpaceBetween>
          </SpaceBetween>
        )}
      </Container>
    </div>
  );
}

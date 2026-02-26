import { useState } from 'react';
import type { EditorState, EditorRoute, ValidationErrors } from '../types';
import { RouteEditor } from './RouteEditor';
import { newEditorRoute } from '../transform';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Button from '@cloudscape-design/components/button';
import Header from '@cloudscape-design/components/header';
import Alert from '@cloudscape-design/components/alert';

interface Props {
  state: EditorState;
  errors: ValidationErrors;
  onChange: (state: EditorState) => void;
}

export function RouteList({ state, errors, onChange }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const isExpanded = (id: string) => expanded[id] === true; // default collapsed
  const toggleOne = (id: string) => setExpanded(prev => ({ ...prev, [id]: !isExpanded(id) }));
  const expandAll = () => setExpanded(Object.fromEntries(state.routes.map(r => [r.id, true])));
  const collapseAll = () => setExpanded(Object.fromEntries(state.routes.map(r => [r.id, false])));

  const updateRoute = (idx: number, route: EditorRoute) => {
    const routes = [...state.routes];
    routes[idx] = route;
    onChange({ ...state, routes });
  };

  const removeRoute = (idx: number) => {
    onChange({ ...state, routes: state.routes.filter((_, i) => i !== idx) });
  };

  const onDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    const routes = [...state.routes];
    const [moved] = routes.splice(result.source.index, 1);
    routes.splice(result.destination.index, 0, moved);
    onChange({ ...state, routes });
  };

  const totalPolicies = state.routes.reduce((sum, r) => sum + r.policies.length, 0);

  return (
    <SpaceBetween size="s">
      <Header
        variant="h2"
        description={`${state.routes.length} route${state.routes.length !== 1 ? 's' : ''} · ${totalPolicies} total policies`}
        actions={
          <SpaceBetween size="xs" direction="horizontal">
            <Button onClick={expandAll} variant="normal">Expand All</Button>
            <Button onClick={collapseAll} variant="normal">Collapse All</Button>
            <Button onClick={() => {
              const newRoute = newEditorRoute();
              onChange({ ...state, routes: [...state.routes, newRoute] });
              setExpanded(prev => ({ ...prev, [newRoute.id]: true }));
            }} iconName="add-plus">
              Add Route
            </Button>
          </SpaceBetween>
        }
      >
        Routes
      </Header>

      <Alert type="info">
        Routes are evaluated <strong>top → bottom</strong>. First match wins.
        Drag to reorder. Collapse routes for a compact overview. Put specific patterns above broad ones.
      </Alert>

      {errors['global'] && <Alert type="error">{errors['global']}</Alert>}

      <DragDropContext onDragEnd={onDragEnd}>
        <Droppable droppableId="routes">
          {(provided) => (
            <div ref={provided.innerRef} {...provided.droppableProps}>
              {state.routes.map((route, idx) => (
                <Draggable key={route.id} draggableId={route.id} index={idx}>
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.draggableProps}
                      style={{ ...provided.draggableProps.style, marginBottom: 8, opacity: snapshot.isDragging ? 0.85 : 1 }}
                    >
                      <RouteEditor
                        route={route}
                        index={idx}
                        errors={errors}
                        expanded={isExpanded(route.id)}
                        onToggle={() => toggleOne(route.id)}
                        onChange={r => updateRoute(idx, r)}
                        onRemove={() => removeRoute(idx)}
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
    </SpaceBetween>
  );
}

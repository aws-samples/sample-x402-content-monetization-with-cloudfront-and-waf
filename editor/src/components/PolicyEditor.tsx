import type { EditorPolicy, ValidationErrors } from '../types';
import type { RuleGroupType } from 'react-querybuilder';
import { ConditionBuilder } from './ConditionBuilder';
import type { DraggableProvidedDragHandleProps } from '@hello-pangea/dnd';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Button from '@cloudscape-design/components/button';
import Select from '@cloudscape-design/components/select';
import Input from '@cloudscape-design/components/input';
import FormField from '@cloudscape-design/components/form-field';
import Alert from '@cloudscape-design/components/alert';

const COLORS = [
  '#f0f4ff', '#fff7ed', '#f0fdf4', '#fdf2f8', '#fefce8',
  '#f5f3ff', '#ecfeff', '#fff1f2', '#f0fdfa', '#fef9c3',
];

function actionEmoji(action: string): string {
  if (action === 'block') return '🚫';
  if (action === '0') return '✅';
  return '💲';
}

function actionLabel(action: string): string {
  if (action === 'block') return '🚫 Block';
  if (action === '0') return '✅ Free';
  return '💲 Price (USD)';
}

interface Props {
  policy: EditorPolicy;
  index: number;
  errors: ValidationErrors;
  onChange: (policy: EditorPolicy) => void;
  onRemove: () => void;
  dragHandleProps: DraggableProvidedDragHandleProps | null | undefined;
}

export function PolicyEditor({ policy, index, errors, onChange, onRemove, dragHandleProps }: Props) {
  const actionErr = errors[`${policy.id}-action`];
  const depthErr = errors[`${policy.id}-depth`];
  const emptyErr = errors[`${policy.id}-empty`];
  const stmtErr = errors[`${policy.id}-statements`];
  const childErr = errors[`${policy.id}-children`];
  const policyErrors = [depthErr, emptyErr, stmtErr, childErr].filter(Boolean);
  const bg = COLORS[index % COLORS.length];
  const actionType = policy.action === 'block' ? 'block' : policy.action === '0' ? 'free' : 'price';

  return (
    <div style={{ background: bg, borderRadius: 8, padding: '8px 12px', borderLeft: '3px solid #aab7c4' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span {...(dragHandleProps ?? {})} style={{ cursor: 'grab', userSelect: 'none' }} title="Drag to reorder policy">⠿</span>
          {actionEmoji(policy.action)} {policy.isDefault ? 'Default (fallback)' : `Policy #${index + 1}`}
        </span>
        <Button onClick={onRemove} variant="icon" iconName="close" />
      </div>

      <SpaceBetween size="xs">
        {!policy.isDefault && (
          <>
            <ConditionBuilder
              query={policy.query}
              onChange={(query: RuleGroupType) => onChange({ ...policy, query })}
            />
            {policyErrors.map((err, i) => (
              <Alert key={i} type="warning">{err}</Alert>
            ))}
          </>
        )}

        <FormField label="Action" errorText={actionErr}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 160 }}>
              <Select
                selectedOption={{ value: actionType, label: actionLabel(policy.action) }}
                onChange={({ detail }) => {
                  const v = detail.selectedOption.value!;
                  onChange({ ...policy, action: v === 'block' ? 'block' : v === 'free' ? '0' : '0.001' });
                }}
                options={[
                  { value: 'price', label: '💲 Price (USD)' },
                  { value: 'free', label: '✅ Free (0)' },
                  { value: 'block', label: '🚫 Block' },
                ]}
              />
            </div>
            {actionType === 'price' && (
              <SpaceBetween size="xxs" direction="horizontal">
                <Button onClick={() => {
                  const v = Math.max(0, parseFloat(policy.action || '0') - 0.001);
                  onChange({ ...policy, action: v === 0 ? '0.001' : v.toFixed(Math.max((`${v}`.split('.')[1] || '').length, 3)) });
                }}>−</Button>
                <div style={{ width: 90 }}>
                  <Input
                    value={policy.action}
                    onChange={({ detail }) => onChange({ ...policy, action: detail.value })}
                    placeholder="0.001"
                    type="text"
                  />
                </div>
                <Button onClick={() => {
                  const v = parseFloat(policy.action || '0') + 0.001;
                  onChange({ ...policy, action: v.toFixed(Math.max((`${v}`.split('.')[1] || '').length, 3)) });
                }}>+</Button>
              </SpaceBetween>
            )}
          </div>
        </FormField>
      </SpaceBetween>
    </div>
  );
}

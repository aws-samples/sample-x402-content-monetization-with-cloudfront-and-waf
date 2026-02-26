import { useState } from 'react';
import Autosuggest from '@cloudscape-design/components/autosuggest';
import type { AutosuggestProps } from '@cloudscape-design/components/autosuggest';
import { labelCategories, namespaceEntries, allStaticLabels } from '../label-catalog';
import type { DynamicLabelEntry } from '../label-catalog';

interface Props {
  field: 'label' | 'namespace' | 'custom';
  value: string;
  onChange: (field: string, value: string) => void;
}

/** Build grouped Autosuggest options from the label catalog. */
function buildLabelOptions(): AutosuggestProps.OptionGroup[] {
  return labelCategories.map(cat => ({
    label: cat.name,
    options: [
      ...cat.labels.map(l => ({
        value: l.label,
        label: l.displayName,
        description: l.description,
      })),
      ...(cat.dynamicLabels ?? []).map(d => ({
        value: `__dyn__${d.prefix}`,
        label: `${d.displayName} (enter value…)`,
        description: `Prefix: ${d.prefix}`,
      })),
    ],
  }));
}

function buildNamespaceOptions(): AutosuggestProps.Option[] {
  return namespaceEntries.map(ns => ({
    value: ns.namespace,
    label: ns.displayName,
    description: ns.description,
  }));
}

const labelOptions = buildLabelOptions();
const namespaceOptions = buildNamespaceOptions();

export function LabelPicker({ field, value, onChange }: Props) {
  const [dynamicSuffix, setDynamicSuffix] = useState('');
  const [selectedDynamic, setSelectedDynamic] = useState<DynamicLabelEntry | null>(null);
  const [filterText, setFilterText] = useState('');
  const [isEditing, setIsEditing] = useState(false);

  if (field === 'namespace') {
    const displayValue = namespaceEntries.find(ns => ns.namespace === value)?.displayName ?? value;
    return (
      <Autosuggest
        value={displayValue}
        onChange={({ detail }) => {
          const ns = namespaceEntries.find(n => n.displayName === detail.value);
          onChange('namespace', ns?.namespace ?? detail.value);
        }}
        onSelect={({ detail }) => {
          onChange('namespace', detail.value ?? '');
          setFilterText('');
        }}
        options={namespaceOptions}
        placeholder="Select namespace…"
        enteredTextLabel={v => `Custom: ${v}`}
        empty="No matching namespaces"
      />
    );
  }

  if (field === 'custom') {
    return (
      <input
        type="text"
        value={value}
        onChange={e => onChange('custom', e.target.value)}
        placeholder="Custom WAF label…"
        style={{ minWidth: 300 }}
      />
    );
  }

  // Label field: categorized picker with dynamic label support
  const allDynamic = labelCategories.flatMap(c => c.dynamicLabels ?? []);
  const staticMatch = allStaticLabels.find(l => l.label === value);
  const dynamicMatch = allDynamic.find(d => value.startsWith(d.prefix));

  if (selectedDynamic || (dynamicMatch && !staticMatch)) {
    const dyn = selectedDynamic ?? dynamicMatch!;
    const suffix = dynamicMatch ? value.slice(dyn.prefix.length) : dynamicSuffix;
    const fullLabel = dyn.prefix + suffix;
    return (
      <span title={fullLabel}>
        <strong title={`Label prefix: ${dyn.prefix}`} style={{ cursor: 'help' }}>{dyn.displayName}: </strong>
        <input
          type="text"
          value={suffix}
          placeholder={dyn.placeholder}
          title={`Full label: ${dyn.prefix}${suffix || `<${dyn.placeholder}>`}`}
          onChange={e => {
            setDynamicSuffix(e.target.value);
            onChange('label', dyn.prefix + e.target.value);
          }}
        />
        <button type="button" onClick={() => { setSelectedDynamic(null); onChange('label', ''); }} style={{ marginLeft: 4 }}>✕</button>
        {suffix && <span style={{ marginLeft: 6, fontSize: 11, color: '#888', fontFamily: 'monospace' }} title={fullLabel}>{fullLabel}</span>}
      </span>
    );
  }

  const displayValue = isEditing ? filterText : (staticMatch?.displayName ?? filterText);

  return (
    <span>
      <Autosuggest
        value={displayValue}
        onChange={({ detail }) => {
          setIsEditing(true);
          setFilterText(detail.value);
        }}
        onSelect={({ detail }) => {
          const selected = detail.value ?? '';
          const dyn = allDynamic.find(d => selected === `__dyn__${d.prefix}`);
          if (dyn) {
            setSelectedDynamic(dyn);
            setDynamicSuffix('');
            onChange('label', dyn.prefix);
          } else {
            onChange('label', selected);
          }
          setFilterText('');
          setIsEditing(false);
        }}
        onBlur={() => {
          setIsEditing(false);
          setFilterText('');
        }}
        options={labelOptions}
        placeholder="Search labels…"
        enteredTextLabel={v => `Custom: ${v}`}
        empty="No matching labels"
        filteringType="auto"
      />
      {value && <span style={{ marginLeft: 6, fontSize: 11, color: '#888', fontFamily: 'monospace' }} title={value}>{value}</span>}
    </span>
  );
}

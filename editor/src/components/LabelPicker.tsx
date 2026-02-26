import { useState } from 'react';
import { labelCategories, namespaceEntries, allStaticLabels } from '../label-catalog';
import type { DynamicLabelEntry } from '../label-catalog';

interface Props {
  field: 'label' | 'namespace' | 'custom';
  value: string;
  onChange: (field: string, value: string) => void;
}

export function LabelPicker({ field, value, onChange }: Props) {
  const [dynamicSuffix, setDynamicSuffix] = useState('');
  const [selectedDynamic, setSelectedDynamic] = useState<DynamicLabelEntry | null>(null);

  if (field === 'namespace') {
    return (
      <select value={value} onChange={e => onChange('namespace', e.target.value)} title={value || undefined}>
        <option value="">Select namespace…</option>
        {namespaceEntries.map(ns => (
          <option key={ns.namespace} value={ns.namespace} title={ns.namespace}>
            {ns.displayName}
          </option>
        ))}
      </select>
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

  // Label field: categorized picker
  const staticMatch = allStaticLabels.find(l => l.label === value);
  const allDynamic = labelCategories.flatMap(c => c.dynamicLabels ?? []);
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

  return (
    <span>
      <select
        value={value}
        onChange={e => {
          const v = e.target.value;
          const dyn = allDynamic.find(d => v === `__dyn__${d.prefix}`);
          if (dyn) {
            setSelectedDynamic(dyn);
            setDynamicSuffix('');
            onChange('label', dyn.prefix);
          } else {
            onChange('label', v);
          }
        }}
        title={value || undefined}
      >
        <option value="">Select label…</option>
        {labelCategories.map(cat => (
          <optgroup key={cat.name} label={cat.name}>
            {cat.labels.map(l => (
              <option key={l.label} value={l.label} title={l.label}>
                {l.displayName}
              </option>
            ))}
            {cat.dynamicLabels?.map(d => (
              <option key={d.prefix} value={`__dyn__${d.prefix}`} title={`${d.prefix}<${d.placeholder}>`}>
                {d.displayName} (enter value…)
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {value && <span style={{ marginLeft: 6, fontSize: 11, color: '#888', fontFamily: 'monospace' }} title={value}>{value}</span>}
    </span>
  );
}

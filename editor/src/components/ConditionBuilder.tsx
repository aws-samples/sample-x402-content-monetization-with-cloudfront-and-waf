import { QueryBuilder, type RuleGroupType, type Field, type ValueEditorProps, type CombinatorSelectorProps } from 'react-querybuilder';
import 'react-querybuilder/dist/query-builder.css';
import { LabelPicker } from './LabelPicker';

const fields: Field[] = [
  { name: 'label', label: 'WAF Label' },
  { name: 'namespace', label: 'Namespace' },
  { name: 'custom', label: 'Custom' },
];

const operators = [{ name: '=', label: 'matches' }];

function ValueEditor(props: ValueEditorProps) {
  return (
    <LabelPicker
      field={props.field as 'label' | 'namespace' | 'custom'}
      value={props.value as string}
      onChange={(_field, value) => props.handleOnChange(value)}
    />
  );
}

function OperatorSelector() {
  return <span style={{ margin: '0 4px', fontWeight: 'bold' }}>=</span>;
}

function CombinatorSelector(props: CombinatorSelectorProps) {
  const ruleCount = props.rules?.length ?? 0;
  if (ruleCount < 2) return null;

  return (
    <select value={props.value} onChange={e => props.handleOnChange(e.target.value)}>
      {props.options.map(opt => {
        if ('options' in opt) return null; // skip option groups
        const name = 'name' in opt ? opt.name : String(opt);
        const label = 'label' in opt ? opt.label : name;
        return <option key={name} value={name}>{label}</option>;
      })}
    </select>
  );
}

interface Props {
  query: RuleGroupType;
  onChange: (query: RuleGroupType) => void;
}

export function ConditionBuilder({ query, onChange }: Props) {
  return (
    <QueryBuilder
      fields={fields}
      operators={operators}
      query={query}
      onQueryChange={onChange}
      controlElements={{
        valueEditor: ValueEditor,
        operatorSelector: OperatorSelector,
        combinatorSelector: CombinatorSelector,
      }}
      combinators={[
        { name: 'and', label: 'AND' },
        { name: 'or', label: 'OR' },
      ]}
      showNotToggle
      showCombinatorsBetweenRules
      resetOnFieldChange={false}
    />
  );
}

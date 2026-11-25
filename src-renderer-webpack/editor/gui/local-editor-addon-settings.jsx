import React from 'react';
import styles from './desktop-settings-menu.css';

const messages = locale => locale.startsWith('ja') ?
  {settings: 'アドオン設定', apply: '設定を適用', reset: '既定値に戻す', pending: '次回の起動時に反映'} :
  {settings: 'Add-on settings', apply: 'Apply settings', reset: 'Restore defaults', pending: 'Applied on next startup'};

function SettingInput ({field, value, onChange}) {
  switch (field.kind) {
  case 'boolean':
    return <input type="checkbox" checked={value} onChange={event => onChange(event.target.checked)} />;
  case 'select':
    return <select value={field.options.findIndex(option => option.value === value)}
      onChange={event => onChange(field.options[Number(event.target.value)].value)}>
      {field.options.map((option, index) => <option key={index} value={index}>{option.label}</option>)}
    </select>;
  case 'integer':
  case 'number':
    return <input type="number" value={value} required min={field.min} max={field.max}
      step={field.kind === 'integer' ? 1 : 'any'} onChange={event => onChange(event.target.value)} />;
  default:
    return <input type={field.kind === 'color' ? 'color' : 'text'} value={value}
      maxLength={800} onChange={event => onChange(event.target.value)} />;
  }
}

export function LocalEditorAddonSettings ({locale, fields, disabled, apply}) {
  const [draft, setDraft] = React.useState(() => new Map());
  const text = messages(locale);
  const update = (id, value) => setDraft(previous => new Map(previous).set(id, value));
  const submit = async event => {
    event.preventDefault();
    const changes = fields.filter(field => draft.has(field.id)).map(field => {
      const value = draft.get(field.id);
      return [field.id, field.kind === 'number' || field.kind === 'integer' ? Number(value) : value];
    });
    if (changes.length && await apply(changes)) setDraft(new Map());
  };
  return <details className={styles.editorAddonSettings}>
    <summary>{text.settings}</summary>
    <form onSubmit={submit}>
      <fieldset disabled={disabled} aria-label={text.settings}>
        {fields.map(field => <label key={field.id}>
          <span>{field.label}</span>
          <SettingInput field={field} value={draft.get(field.id) ?? field.value}
            onChange={value => update(field.id, value)} />
          {!field.dynamic && <small>{text.pending}</small>}
        </label>)}
        <div className="twextsec-actions">
          <button type="button" onClick={() => setDraft(new Map(fields.map(field => [field.id, field.default])))}>
            {text.reset}
          </button>
          <button type="submit" disabled={!draft.size}>{text.apply}</button>
        </div>
      </fieldset>
    </form>
  </details>;
}

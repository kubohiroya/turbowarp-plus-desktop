const settingId = /^[a-z\d_-]{1,80}$/iu;
const color = /^#[a-f\d]{6}$/iu;
const primitive = value => typeof value === 'boolean' || Number.isFinite(value) ||
  (typeof value === 'string' && value.length <= 800);
const label = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : fallback;

function validSettingValue (field, value) {
  switch (field.kind) {
  case 'boolean': return typeof value === 'boolean';
  case 'text': return typeof value === 'string' && value.length <= 800;
  case 'color': return typeof value === 'string' && color.test(value);
  case 'select': return field.options.some(option => option.value === value);
  case 'integer': return Number.isSafeInteger(value) && value >= field.min && value <= field.max;
  case 'number': return Number.isFinite(value) && value >= field.min && value <= field.max;
  default: return false;
  }
}

function readAddonSettings (settings) {
  const fields = new Map();
  for (const setting of Array.isArray(settings) ? settings : []) {
    if (fields.size === 64) break;
    if (typeof setting?.id !== 'string' || !settingId.test(setting.id) ||
        !primitive(setting.default) || fields.has(setting.id)) continue;
    const field = {id: setting.id, label: label(setting.name, setting.id), default: setting.default,
      dynamic: setting.dynamic === true};
    switch (setting.type ?? typeof setting.default) {
    case 'boolean': field.kind = 'boolean'; break;
    case 'string':
    case 'untranslated': field.kind = 'text'; break;
    case 'color': field.kind = 'color'; break;
    case 'select':
      field.kind = 'select';
      field.options = Array.isArray(setting.potentialValues) ? setting.potentialValues.slice(0, 64)
        .filter(option => primitive(option?.id))
        .map(option => ({value: option.id, label: label(option.name, String(option.id))})) : [];
      break;
    case 'positive_integer':
    case 'integer':
    case 'number':
      field.kind = setting.type === 'number' || !setting.type ? 'number' : 'integer';
      field.min = Math.max(setting.type === 'positive_integer' ? 1 : Number.MIN_SAFE_INTEGER,
        Number.isFinite(setting.min) ? setting.min : Number.MIN_SAFE_INTEGER);
      field.max = Math.min(Number.MAX_SAFE_INTEGER, Number.isFinite(setting.max) ? setting.max : Number.MAX_SAFE_INTEGER);
      break;
    default: field.kind = 'readonly';
    }
    if (!validSettingValue(field, field.default)) field.kind = 'readonly';
    fields.set(field.id, field);
  }
  return Array.from(fields.values());
}

function settingValues (fields, overrides) {
  return new Map(fields.map(field => {
    const override = overrides.get(field.id);
    return [field.id, validSettingValue(field, override) ? override : field.default];
  }));
}

module.exports = {readAddonSettings, settingValues, validSettingValue};

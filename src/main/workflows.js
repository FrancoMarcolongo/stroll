const fs = require('fs');
const os = require('os');
const path = require('path');

// Workflows: saved session templates for recurring work. The template is the first message,
// with blanks the start form asks for:
//   {{name}}            a text field
//   {{name=default}}    a text field with a default
//   {{name?text}}       a switch that puts `text` there when on
const FIELD_RE = /\{\{\s*([\w-]+)\s*(?:([=?])([^}]*))?\}\}/g;

const labelFor = key => key.replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase());

function parseFields(template) {
  const fields = new Map();
  for (const m of String(template || '').matchAll(FIELD_RE)) {
    const [, key, op, rest = ''] = m;
    if (fields.has(key)) continue;
    fields.set(key, op === '?'
      ? { key, label: labelFor(key), kind: 'switch', text: rest.trim() || key }
      : { key, label: labelFor(key), kind: 'text', default: op === '=' ? rest.trim() : '' });
  }
  return [...fields.values()];
}

// A switch's value is true/false; a text field's is its text (its default when never set).
function renderTemplate(template, values = {}) {
  const fields = new Map(parseFields(template).map(f => [f.key, f]));
  return String(template || '').replace(FIELD_RE, (_m, key) => {
    const f = fields.get(key);
    const v = values[key];
    if (f.kind === 'switch') return v ? f.text : '';
    return v == null || v === '' ? f.default : String(v);
  }).split('\n').map(l => l.replace(/[ \t]{2,}/g, ' ').trimEnd()).join('\n').trim();
}

// ---------- schedules: { days: [0-6, Sunday = 0], time: 'HH:MM', action: 'remind' | 'prepare' }
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function slotOn(dayStartMs, time) {
  const [h, m] = String(time || '').split(':').map(Number);
  const d = new Date(dayStartMs);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
}

function validSchedule(s) {
  return s && Array.isArray(s.days) && s.days.length > 0 && /^\d{1,2}:\d{2}$/.test(s.time || '');
}

// The most recent scheduled time at or before now (looking back a week), or null.
function lastSlot(schedule, nowMs) {
  if (!validSchedule(schedule)) return null;
  for (let back = 0; back <= 7; back++) {
    const day = nowMs - back * DAY;
    const at = slotOn(day, schedule.time);
    if (at <= nowMs && schedule.days.includes(new Date(day).getDay())) return at;
  }
  return null;
}

function nextSlot(schedule, nowMs) {
  if (!validSchedule(schedule)) return null;
  for (let ahead = 0; ahead <= 7; ahead++) {
    const day = nowMs + ahead * DAY;
    const at = slotOn(day, schedule.time);
    if (at > nowMs && schedule.days.includes(new Date(day).getDay())) return at;
  }
  return null;
}

// The latest slot not handled yet, if any. Slots from before the schedule was set don't count,
// and one older than `graceMs` was missed (Stroll was closed): it's reported, never run late.
function dueSlot(wf, nowMs, graceMs) {
  const at = lastSlot(wf.schedule, nowMs);
  if (at == null) return null;
  const since = Math.max(Date.parse(wf.lastSlotAt || 0) || 0, Date.parse(wf.scheduleSetAt || wf.createdAt || 0) || 0);
  if (at <= since) return null;
  return { at, missed: nowMs - at > graceMs };
}

// ---------- skills in background runs
// Runs load no user settings, so they see neither plugin skills nor ~/.claude/skills. A prompt
// that starts with /plugin:skill gets just that plugin enabled (through --settings); one that
// starts with a personal skill is told to read and follow its SKILL.md.
function runSkillSetup(prompt, { enabledPlugins = {}, skillsDir = path.join(os.homedir(), '.claude', 'skills') } = {}) {
  const m = String(prompt || '').match(/^\/([\w.-]+)(?::([\w.-]+))?(?:\s+([\s\S]*))?$/);
  if (!m) return { prompt, settings: null };
  const [, first, skill, args] = m;
  if (skill) {
    const key = Object.keys(enabledPlugins).find(k => k.split('@')[0] === first && enabledPlugins[k]);
    return { prompt, settings: key ? { enabledPlugins: { [key]: true } } : null };
  }
  const file = path.join(skillsDir, first, 'SKILL.md');
  if (!fs.existsSync(file)) return { prompt, settings: null };
  return { prompt: `Read ${file} and follow that skill${args ? ` with these arguments: ${args.trim()}` : ''}.`, settings: null };
}

function userEnabledPlugins() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).enabledPlugins || {};
  } catch (_) {
    return {};
  }
}

module.exports = { parseFields, renderTemplate, labelFor, lastSlot, nextSlot, dueSlot, validSchedule, runSkillSetup, userEnabledPlugins };

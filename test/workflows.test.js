// Workflows: the blanks in a template, and when a schedule comes due. Dates are built in local
// time, as the schedules are, so these pass in any time zone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFields, renderTemplate, lastSlot, nextSlot, dueSlot } = require('../src/main/workflows');

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
// Wednesday 25 November 2026, 11:30.
const now = at(2026, 11, 25, 11, 30);
const weekdays = { days: [1, 2, 3, 4, 5], time: '10:00', action: 'prepare' };

test('parseFields: text fields, defaults and switches, each once', () => {
  assert.deepEqual(parseFields('Release {{service}} to {{env=prod}}{{dry?--dry-run}} {{service}}'), [
    { key: 'service', label: 'Service', kind: 'text', default: '' },
    { key: 'env', label: 'Env', kind: 'text', default: 'prod' },
    { key: 'dry', label: 'Dry', kind: 'switch', text: '--dry-run' },
  ]);
});

test('renderTemplate: values, defaults, switches off and spaces tidied', () => {
  const tpl = 'Release {{service}} to {{env=prod}} {{dry?with --dry-run}}';
  assert.equal(renderTemplate(tpl, { service: 'asado' }), 'Release asado to prod');
  assert.equal(renderTemplate(tpl, { service: 'asado', env: 'dev', dry: true }), 'Release asado to dev with --dry-run');
});

test('nextSlot: later today if it’s still to come, else the next day on the list', () => {
  assert.equal(nextSlot(weekdays, at(2026, 11, 25, 9, 0)), at(2026, 11, 25, 10, 0));
  assert.equal(nextSlot(weekdays, now), at(2026, 11, 26, 10, 0));
  // Friday afternoon: Monday.
  assert.equal(nextSlot(weekdays, at(2026, 11, 27, 15, 0)), at(2026, 11, 30, 10, 0));
});

test('lastSlot: the latest slot at or before now', () => {
  assert.equal(lastSlot(weekdays, now), at(2026, 11, 25, 10, 0));
  // Sunday: back to Friday.
  assert.equal(lastSlot(weekdays, at(2026, 11, 29, 12, 0)), at(2026, 11, 27, 10, 0));
});

test('an invalid schedule has no slots', () => {
  assert.equal(nextSlot({ days: [], time: '10:00' }, now), null);
  assert.equal(nextSlot({ days: [1], time: 'ten' }, now), null);
  assert.equal(lastSlot(null, now), null);
});

test('dueSlot: due once per slot, never for one before the schedule was set, missed when too old', () => {
  const grace = 30 * 60 * 1000;
  const wf = { schedule: weekdays, scheduleSetAt: new Date(at(2026, 11, 20)).toISOString() };
  assert.deepEqual(dueSlot(wf, at(2026, 11, 25, 10, 10), grace), { at: at(2026, 11, 25, 10, 0), missed: false });
  assert.deepEqual(dueSlot(wf, now, grace), { at: at(2026, 11, 25, 10, 0), missed: true });
  assert.equal(dueSlot({ ...wf, lastSlotAt: new Date(at(2026, 11, 25, 10, 0)).toISOString() }, now, grace), null);
  assert.equal(dueSlot({ ...wf, scheduleSetAt: new Date(at(2026, 11, 25, 11, 0)).toISOString() }, now, grace), null);
});

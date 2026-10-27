const test = require('node:test'), assert = require('node:assert');
const L = require('../lib/alerts');
// 2026-10-28 10:00 Chicago (CDT, UTC-5) = 15:00Z
const NOW = new Date('2026-10-28T15:00:00Z');
const job = (o = {}) => ({ id: 'j1', num: 'J-1042', client: 'c1', clientName: 'Smith', desc: 'Replace water heater', when: '2026-10-29T09:00', status: 'Scheduled', techEmails: ['mike@x.com'],
  total: 1850, price: 1850, actual: { labor: 400, parts: 920 }, rate: 95, cost: 920, markup: 0.3, ...o });
const MONEY = /\$|\b1850\b|\b920\b|\b95\b|\b400\b|price|cost|pay|rate|markup|profit|total/i;
const techPayloads = (alerts) => alerts.filter((a) => L.GROUP[a.type] === 'tech').map(L.payload);

test('localStr is Chicago time', () => { assert.equal(L.localStr(NOW), '2026-10-28T10:00'); assert.equal(L.localStr(new Date('2026-12-01T01:30:00Z')), '2026-11-30T19:30'); });
test('fmtWhen', () => assert.equal(L.fmtWhen('2026-10-29T09:00'), 'Thu, Oct 29, 9:00 AM'));

test('new job → assigned tech, no money', () => {
  const a = L.jobAlerts(null, job(), { now: NOW });
  assert.equal(a.length, 1); assert.equal(a[0].type, 'assigned'); assert.deepEqual(a[0].to, ['mike@x.com']);
  assert.match(a[0].title, /J-1042 · Smith/); assert.equal(JSON.parse(L.payload(a[0])).jobId, 'j1');
  for (const p of techPayloads(a)) assert.doesNotMatch(p, MONEY);
});
test('adding a 2nd tech alerts only the new one', () => {
  const a = L.jobAlerts(job(), job({ techEmails: ['mike@x.com', 'Joe@X.com'] }), { now: NOW });
  assert.deepEqual(a.map((x) => [x.type, x.to]), [['assigned', ['joe@x.com']]]);
});
test('time change alerts kept techs (not the new one twice)', () => {
  const a = L.jobAlerts(job(), job({ when: '2026-10-30T13:30', techEmails: ['mike@x.com', 'joe@x.com'] }), { now: NOW });
  assert.deepEqual(a.map((x) => [x.type, x.to]), [['assigned', ['joe@x.com']], ['changed', ['mike@x.com']]]);
  assert.match(a[1].body, /Fri, Oct 30, 1:30 PM.*was Thu, Oct 29, 9:00 AM/);
  for (const p of techPayloads(a)) assert.doesNotMatch(p, MONEY);
});
test('no alerts when nothing relevant changed (e.g. owner full re-sync / price edit)', () => {
  assert.deepEqual(L.jobAlerts(job(), job({ total: 2000, techNotes: 'x' }), { now: NOW }), []);
});
test('past job assignment is silent; deleted job silent', () => {
  assert.deepEqual(L.jobAlerts(null, job({ when: '2026-10-01T09:00' }), { now: NOW }), []);
  assert.deepEqual(L.jobAlerts(job(), null), []);
});
test('Completed → owners once', () => {
  const a = L.jobAlerts(job({ status: 'In Progress' }), job({ status: 'Completed' }), { now: NOW });
  assert.deepEqual(a.map((x) => [x.type, x.to]), [['completed', 'owners']]);
  assert.deepEqual(L.jobAlerts(job({ status: 'Completed' }), job({ status: 'Completed' }), { now: NOW }), []);
});

test('day clock in / out → owners, excluding the worker', () => {
  const t = { worker: 'w1', kind: 'day', in: '2026-10-28T12:05:00Z', out: null, email: 'mike@x.com' };
  const a = L.timeAlerts(null, t, { workerName: 'Mike', actor: 'mike@x.com' });
  assert.equal(a[0].type, 'dayClock'); assert.equal(a[0].title, 'Mike clocked in for the day'); assert.equal(a[0].body, 'At 7:05 AM.'); assert.deepEqual(a[0].exclude, ['mike@x.com']);
  const b = L.timeAlerts(t, { ...t, out: '2026-10-28T22:30:00Z' }, { workerName: 'Mike' });
  assert.equal(b[0].title, 'Mike clocked out for the day'); assert.equal(b[0].body, 'At 5:30 PM.');
  assert.deepEqual(L.timeAlerts(t, { ...t, note: 'edit' }), []);
});
test('job start/stop shows job number + name', () => {
  const t = { worker: 'w1', kind: 'job', job: 'j1', in: '2026-10-28T14:00:00Z', out: null };
  const a = L.timeAlerts(null, t, { workerName: 'Mike', job: job(), clientName: 'Smith' });
  assert.equal(a[0].type, 'jobClock'); assert.equal(a[0].title, 'Mike started J-1042 · Smith'); assert.equal(a[0].jobId, 'j1');
  assert.equal(L.timeAlerts(t, { ...t, out: '2026-10-28T16:00:00Z' }, { workerName: 'Mike', job: job() })[0].title, 'Mike stopped J-1042 · Smith');
  assert.equal(L.timeAlerts(null, { worker: 'w1', job: 'j1', in: t.in, out: null }, { workerName: 'Mike', job: job() })[0].type, 'jobClock'); // legacy entry
});

test('tech note / lead → owners; owner notes silent; lead from note not doubled', () => {
  const n = { by: 'mike@x.com', byName: 'Mike', clientName: 'Smith', text: 'Wants a softener next spring', lead: true, jobId: 'j1' };
  const a = L.noteAlert(n, { kind: 'note' });
  assert.equal(a[0].type, 'notes'); assert.equal(a[0].title, 'Mike added a note (future work)'); assert.equal(a[0].body, 'Smith: Wants a softener next spring');
  assert.deepEqual(L.noteAlert(n, { kind: 'note', isOwnerAuthor: true }), []);
  assert.deepEqual(L.noteAlert({ ...n, note: 'n1' }, { kind: 'lead' }), []);
  assert.equal(L.noteAlert({ ...n, note: undefined }, { kind: 'lead' })[0].title, 'New lead from Mike');
});

test('30-min reminders window + dedupe key, no money', () => {
  const js = [job({ id: 'a', when: '2026-10-28T10:30' }), job({ id: 'b', when: '2026-10-28T10:20' }), job({ id: 'c', when: '2026-10-28T10:30', status: 'Completed' }), job({ id: 'd', when: '2026-10-28' }), job({ id: 'e', when: '2026-10-28T11:30' })];
  const r = L.remindersDue(js, NOW);
  assert.deepEqual(r.map((x) => x.jobId), ['a']); assert.equal(r[0].key, 'rem30_a_202610281030'); assert.equal(r[0].body, 'Your job starts at 10:30 AM.');
  for (const p of r.map(L.payload)) assert.doesNotMatch(p, MONEY);
});
test('7 PM forgot-to-clock-out', () => {
  const ents = [{ id: 't1', worker: 'w1', kind: 'day', in: '2026-10-28T12:00:00Z', out: null }, { id: 't2', worker: 'w2', kind: 'job', job: 'j', in: '2026-10-28T12:00:00Z', out: null }, { id: 't3', worker: 'w3', kind: 'day', in: '2026-10-27T12:00:00Z', out: null }];
  const em = (t) => ({ w1: 'mike@x.com', w2: 'joe@x.com', w3: 'al@x.com' })[t.worker];
  assert.deepEqual(L.clockoutDue(ents, em, new Date('2026-10-28T23:55:00Z')), []); // 6:55 PM
  const r = L.clockoutDue(ents, em, new Date('2026-10-29T00:00:00Z')); // 7:00 PM
  assert.deepEqual(r.map((x) => [x.key, x.to]), [['co7_t1', ['mike@x.com']]]); assert.match(r[0].body, /7:00 AM/);
});
test('prefs: defaults on, can turn off', () => {
  assert.equal(L.wants(null, 'jobClock'), true); assert.equal(L.wants({ owner: { jobClock: false } }, 'jobClock'), false); assert.equal(L.wants({ owner: { jobClock: false } }, 'dayClock'), true);
});

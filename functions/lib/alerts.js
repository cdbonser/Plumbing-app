// Pure alert logic (no Firebase). Decides WHO gets WHAT. Unit-tested in test/alerts.test.js.
// Keep the type keys in sync with NOTIF_TECH / NOTIF_OWNER in index.html.
const TZ = 'America/Chicago';
const OWNER_EMAILS = ['cdbonser@gmail.com', 'thecentralplumber@gmail.com'];
const DEFAULTS = {
  tech: { assigned: true, changed: true, remind30: true, clockout7: true },
  owner: { dayClock: true, jobClock: true, completed: true, notes: true },
};
const GROUP = { assigned: 'tech', changed: 'tech', remind30: 'tech', clockout7: 'tech', dayClock: 'owner', jobClock: 'owner', completed: 'owner', notes: 'owner' };
const DONE = ['Completed', 'Invoiced', 'Paid'];

const low = (e) => String(e || '').trim().toLowerCase();
const clip = (s, n = 120) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// "YYYY-MM-DDTHH:MM" in Chicago for a Date
function localStr(d = new Date(), tz = TZ) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
// "Tue Oct 28, 9:00 AM" from a job's local "when" string (already Chicago time)
function fmtWhen(w) {
  if (!w) return 'no date set';
  const [d, t] = String(w).split('T');
  const [y, m, dd] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, dd));
  let s = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (t) { let [h, mi] = t.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; s += `, ${h}:${String(mi || 0).padStart(2, '0')} ${ap}`; }
  return s;
}
function fmtTime(iso) { return iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ }) : ''; }

// Only these job fields ever reach a notification (no prices, costs, pay or totals).
const jobLabel = (j, clientName) => [j.num || 'Job', clip(clientName || j.clientName || '', 40)].filter(Boolean).join(' · ');

// ---------- jobs/{id} written ----------
function jobAlerts(before, after, { clientName, now = new Date() } = {}) {
  if (!after) return [];
  const out = [], id = after.id, label = jobLabel(after, clientName);
  const was = new Set((before && before.techEmails || []).map(low));
  const today = localStr(now).slice(0, 10);
  const upcoming = !after.when || String(after.when).slice(0, 10) >= today;
  const active = !DONE.includes(after.status);
  const added = (after.techEmails || []).map(low).filter((e) => e && !was.has(e));
  if (added.length && upcoming && active) out.push({ type: 'assigned', to: added, jobId: id, title: `New job: ${label}`, body: `You're on this job ${after.when ? 'on ' + fmtWhen(after.when) : '(no date yet)'}. Tap to see details.` });
  if (before && (before.when || '') !== (after.when || '') && active) {
    const kept = (after.techEmails || []).map(low).filter((e) => was.has(e));
    if (kept.length) out.push({ type: 'changed', to: kept, jobId: id, title: `Time changed: ${label}`, body: `Now ${fmtWhen(after.when)}${before.when ? ' (was ' + fmtWhen(before.when) + ')' : ''}.` });
  }
  if (after.status === 'Completed' && (!before || before.status !== 'Completed')) out.push({ type: 'completed', to: 'owners', jobId: id, title: `✅ Completed: ${label}`, body: clip(after.desc ? `Job marked Completed. ${after.desc}` : 'Job marked Completed.') });
  return out;
}

// ---------- timeEntries/{id} written ----------
const isJobEntry = (t) => t.kind === 'job' || (!t.kind && !!t.job);
function timeAlerts(before, after, { workerName = 'A worker', job = null, clientName = '', actor = '' } = {}) {
  if (!after) return [];
  const started = !before && !after.out, stopped = before && !before.out && !!after.out;
  if (!started && !stopped) return [];
  const exclude = actor ? [low(actor)] : [];
  if (isJobEntry(after)) {
    const label = job ? jobLabel(job, clientName) : 'a job';
    return [{ type: 'jobClock', to: 'owners', exclude, jobId: after.job || '', title: `${workerName} ${started ? 'started' : 'stopped'} ${label}`, body: `${started ? 'Started' : 'Stopped'} at ${fmtTime(started ? after.in : after.out)}.` }];
  }
  return [{ type: 'dayClock', to: 'owners', exclude, title: `${workerName} clocked ${started ? 'in' : 'out'} for the day`, body: `At ${fmtTime(started ? after.in : after.out)}.` }];
}

// ---------- notes / leads created ----------
function noteAlert(note, { kind = 'note', isOwnerAuthor = false } = {}) {
  if (!note || isOwnerAuthor) return [];
  if (kind === 'lead' && note.note) return []; // lead made from a note: the note already alerted
  const who = note.byName || note.by || 'A tech';
  const where = clip(note.clientName || '', 40);
  return [{ type: 'notes', to: 'owners', exclude: [low(note.by)], jobId: note.jobId || note.job || '', title: kind === 'lead' ? `New lead from ${who}` : `${who} added a note${note.lead ? ' (future work)' : ''}`, body: clip((where ? where + ': ' : '') + (note.text || '')) }];
}

// ---------- scheduled (every 5 min) ----------
// jobs: list of job docs; returns reminders for jobs starting in 25–35 min (dedupe key included)
function remindersDue(jobs, now = new Date()) {
  const from = localStr(new Date(now.getTime() + 25 * 60000)), to = localStr(new Date(now.getTime() + 35 * 60000));
  return jobs.filter((j) => j.when && String(j.when).length > 10 && j.when >= from && j.when <= to && !DONE.includes(j.status) && (j.techEmails || []).length)
    .map((j) => ({ type: 'remind30', to: j.techEmails.map(low), jobId: j.id, key: `rem30_${j.id}_${String(j.when).replace(/[^0-9]/g, '')}`, title: `Starting soon: ${jobLabel(j)}`, body: `Your job starts at ${fmtWhen(j.when).split(', ').pop()}.` }));
}
// open time entries; email resolver(entry)->email. Only after 7 PM Chicago, day entries started today.
function clockoutDue(entries, emailOf, now = new Date()) {
  const l = localStr(now), today = l.slice(0, 10), hour = +l.slice(11, 13);
  if (hour < 19) return [];
  return entries.filter((t) => !t.out && !isJobEntry(t) && t.in && localStr(new Date(t.in)).slice(0, 10) === today)
    .map((t) => ({ t, e: low(emailOf(t)) })).filter((x) => x.e)
    .map(({ t, e }) => ({ type: 'clockout7', to: [e], key: `co7_${t.id}`, title: 'Still clocked in?', body: `You clocked in at ${fmtTime(t.in)} and haven't clocked out. Tap to clock out if you're done for the day.` }));
}

// prefs: {tech:{...}, owner:{...}} or undefined
function wants(prefs, type) { const g = GROUP[type]; const p = prefs && prefs[g]; return p && type in p ? !!p[type] : DEFAULTS[g][type]; }
function payload(a) { return JSON.stringify({ title: a.title, body: a.body, jobId: a.jobId || '', tag: a.key || `${a.type}_${a.jobId || ''}` }); }

module.exports = { TZ, OWNER_EMAILS, DEFAULTS, GROUP, localStr, fmtWhen, fmtTime, jobAlerts, timeAlerts, noteAlert, remindersDue, clockoutDue, wants, payload, isJobEntry, low };

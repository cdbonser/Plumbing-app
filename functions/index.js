// Central Plumbing push notifications (Firebase Cloud Functions v2, Node 22).
// Sends standard Web Push using our VAPID keys. The private key is a Functions secret:
//   firebase functions:secrets:set VAPID_PRIVATE_KEY
const { onDocumentWritten, onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions, logger } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const webpush = require('web-push');
const L = require('./lib/alerts');

setGlobalOptions({ region: 'us-central1', maxInstances: 3 });
admin.initializeApp();
const db = admin.firestore();
const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');
const VAPID_PUBLIC_KEY = 'BOovCGs1wlE4p2sxpkUnSK2SjOoj3dQqBrnGZx8BidfEuS7owS-HLiBd4LbE5p8FgdXlQ-jUPSDwimiW_h7zK60';
const SUBJECT = 'mailto:thecentralplumber@gmail.com';
const CO = 'main';
const co = () => db.collection('companies').doc(CO);
const opts = { secrets: [VAPID_PRIVATE_KEY] };

async function ownerEmails() {
  const s = await co().collection('users').where('role', '==', 'owner').get();
  return [...new Set([...L.OWNER_EMAILS, ...s.docs.map((d) => L.low(d.id))])];
}
async function isOwnerEmail(e) { return (await ownerEmails()).includes(L.low(e)); }
async function workerName(id) { if (!id) return 'A worker'; const d = await co().collection('workers').doc(id).get(); return (d.exists && d.data().name) || 'A worker'; }
async function emailForWorker(id) { if (!id) return ''; const s = await co().collection('users').where('workerId', '==', id).limit(1).get(); return s.empty ? '' : s.docs[0].id; }
async function clientName(job) { if (!job) return ''; if (job.clientName) return job.clientName; if (!job.client) return ''; const d = await co().collection('clients').doc(job.client).get(); return d.exists ? d.data().name || '' : ''; }

// Deliver a list of alerts. Respects each person's prefs, fans out to all their devices, removes dead devices.
async function deliver(alerts) {
  if (!alerts.length) return;
  webpush.setVapidDetails(SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.value());
  const owners = alerts.some((a) => a.to === 'owners') ? await ownerEmails() : [];
  for (const a of alerts) {
    const to = [...new Set((a.to === 'owners' ? owners : a.to).map(L.low))].filter((e) => !(a.exclude || []).includes(e));
    for (const email of to) {
      const pref = await co().collection('pushPrefs').doc(email).get();
      if (!L.wants(pref.exists ? pref.data() : null, a.type)) continue;
      const subs = await co().collection('pushSubs').where('email', '==', email).get();
      await Promise.all(subs.docs.map(async (d) => {
        const s = d.data();
        try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, L.payload(a), { TTL: 6 * 3600, urgency: 'high' }); }
        catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) { await d.ref.delete(); logger.info('removed dead device', email); }
          else logger.warn('push failed', email, e.statusCode, e.body || e.message);
        }
      }));
    }
  }
}

exports.onJobWrite = onDocumentWritten({ ...opts, document: `companies/${CO}/jobs/{id}` }, async (ev) => {
  const before = ev.data.before.exists ? { id: ev.params.id, ...ev.data.before.data() } : null;
  const after = ev.data.after.exists ? { id: ev.params.id, ...ev.data.after.data() } : null;
  if (!after) return;
  await deliver(L.jobAlerts(before, after, { clientName: await clientName(after) }));
});

exports.onTimeWrite = onDocumentWritten({ ...opts, document: `companies/${CO}/timeEntries/{id}` }, async (ev) => {
  const before = ev.data.before.exists ? ev.data.before.data() : null;
  const after = ev.data.after.exists ? ev.data.after.data() : null;
  if (!after) return;
  const started = !before && !after.out, stopped = before && !before.out && after.out;
  if (!started && !stopped) return;
  let job = null;
  if (L.isJobEntry(after) && after.job) { const j = await co().collection('jobs').doc(after.job).get(); job = j.exists ? { id: j.id, ...j.data() } : null; }
  const actor = after.email || (await emailForWorker(after.worker));
  await deliver(L.timeAlerts(before, after, { workerName: await workerName(after.worker), job, clientName: await clientName(job), actor }));
});

exports.onNoteCreate = onDocumentCreated({ ...opts, document: `companies/${CO}/notes/{id}` }, async (ev) => {
  const n = ev.data.data();
  await deliver(L.noteAlert(n, { kind: 'note', isOwnerAuthor: await isOwnerEmail(n.by) }));
});
exports.onLeadCreate = onDocumentCreated({ ...opts, document: `companies/${CO}/leads/{id}` }, async (ev) => {
  const n = ev.data.data();
  await deliver(L.noteAlert(n, { kind: 'lead', isOwnerAuthor: await isOwnerEmail(n.by) }));
});

// once-only guard: creates pushLog/{key}; returns false if it already existed
async function once(key) { try { await co().collection('pushLog').doc(key).create({ at: admin.firestore.FieldValue.serverTimestamp() }); return true; } catch (e) { if (e.code === 6) return false; throw e; } }

exports.everyFiveMinutes = onSchedule({ ...opts, schedule: 'every 5 minutes', timeZone: L.TZ }, async () => {
  const now = new Date();
  const js = await co().collection('jobs').where('when', '>=', L.localStr(now)).where('when', '<=', L.localStr(new Date(now.getTime() + 40 * 60000))).get();
  const rem = L.remindersDue(js.docs.map((d) => ({ id: d.id, ...d.data() })), now);
  const open = await co().collection('timeEntries').where('out', '==', null).get();
  const ents = open.docs.map((d) => ({ id: d.id, ...d.data() }));
  const emails = {};
  for (const t of ents) if (!t.email && t.worker && !(t.worker in emails)) emails[t.worker] = await emailForWorker(t.worker);
  const co7 = L.clockoutDue(ents, (t) => t.email || emails[t.worker], now);
  const due = [];
  for (const a of [...rem, ...co7]) if (await once(a.key)) due.push(a);
  await deliver(due);
});

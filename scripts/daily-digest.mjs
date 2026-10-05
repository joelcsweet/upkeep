// Sends a daily push notification via ntfy.sh, only for tasks that have newly become due.
// Runs from GitHub Actions; secrets come from environment variables, never from the repo.
import admin from 'firebase-admin';

const TZ = 'Australia/Adelaide';
const FREQ_DAYS = {
  Weekly: 7, Fortnightly: 14, Monthly: 30, 'Bi-monthly': 60,
  Quarterly: 90, 'Bi-annually': 182, Annually: 365,
};

const { FIREBASE_SERVICE_ACCOUNT, UPKEEP_UID, NTFY_TOPIC, FORCE_SEND } = process.env;
const force = FORCE_SEND === 'true';
for (const [k, v] of Object.entries({ FIREBASE_SERVICE_ACCOUNT, UPKEEP_UID, NTFY_TOPIC })) {
  if (!v) { console.error(`Missing required secret: ${k}`); process.exit(1); }
}

const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
const toUtcDay = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const today = toUtcDay(todayStr);

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const snap = await db.doc(`upkeep/${UPKEEP_UID}`).get();
if (!snap.exists) { console.error('No Upkeep document found for that UID.'); process.exit(1); }

// Remembers which task deadlines we've already notified about (separate doc so the app never overwrites it)
const notifiedRef = db.doc(`upkeepNotify/${UPKEEP_UID}`);
const notifiedSnap = await notifiedRef.get();
const notified = notifiedSnap.exists ? (notifiedSnap.data().notified || {}) : {};

const tasks = (snap.data().tasks || [])
  .filter((t) => t.status === 'Active' && t.lastOccurrence)
  .map((t) => {
    const freq = FREQ_DAYS[t.frequency] || 30;
    const deadlineMs = toUtcDay(t.lastOccurrence) + freq * 86400000;
    const overdueDays = Math.round((today - deadlineMs) / 86400000);
    return {
      id: String(t.id), name: t.name, priority: t.priority, overdueDays,
      ratio: overdueDays / freq, deadline: new Date(deadlineMs).toISOString().slice(0, 10),
    };
  })
  .filter((t) => t.overdueDays >= 0);

// Same ordering idea as the app: 100+ days overdue, then overdue P1, then most overdue relative to cycle
tasks.sort((a, b) =>
  (b.overdueDays >= 100) - (a.overdueDays >= 100) ||
  ((b.priority === 1 && b.overdueDays >= 1) - (a.priority === 1 && a.overdueDays >= 1)) ||
  b.ratio - a.ratio);

// A task is "new" if we haven't notified about its current deadline yet.
// Completing a task changes its deadline, so it can notify again next cycle.
const fresh = force ? tasks : tasks.filter((t) => notified[t.id] !== t.deadline);
if (!fresh.length) { console.log('Nothing newly due - no notification sent.'); process.exit(0); }

const stillOverdue = tasks.length - fresh.length;
const top = fresh.slice(0, 5).map((t) => `- ${t.name} (${t.overdueDays === 0 ? 'due today' : t.overdueDays + 'd overdue'})`);
const extra = (fresh.length > 5 ? `\n+ ${fresh.length - 5} more new` : '')
  + (stillOverdue > 0 ? `\n(${stillOverdue} other${stillOverdue === 1 ? '' : 's'} still overdue)` : '');

const res = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
  method: 'POST',
  headers: { Title: `Upkeep: ${fresh.length} newly due task${fresh.length === 1 ? '' : 's'}`, Tags: 'house' },
  body: top.join('\n') + extra,
});
if (!res.ok) { console.error('ntfy responded', res.status); process.exit(1); }

if (!force) {
  // Record every currently-due task's deadline; tasks no longer due drop out automatically
  const next = {};
  for (const t of tasks) next[t.id] = t.deadline;
  await notifiedRef.set({ notified: next, updatedAt: new Date().toISOString() });
}
console.log(`Sent digest for ${fresh.length} newly due task(s).`);

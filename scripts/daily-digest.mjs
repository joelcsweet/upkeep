// Sends a daily "what's due" push notification via ntfy.sh.
// Runs from GitHub Actions; secrets come from environment variables, never from the repo.
import admin from 'firebase-admin';

const TZ = 'Australia/Adelaide';
const SEND_HOUR = 7;
const FREQ_DAYS = {
  Weekly: 7, Fortnightly: 14, Monthly: 30, 'Bi-monthly': 60,
  Quarterly: 90, 'Bi-annually': 182, Annually: 365,
};

const { FIREBASE_SERVICE_ACCOUNT, UPKEEP_UID, NTFY_TOPIC, FORCE_SEND } = process.env;
for (const [k, v] of Object.entries({ FIREBASE_SERVICE_ACCOUNT, UPKEEP_UID, NTFY_TOPIC })) {
  if (!v) { console.error(`Missing required secret: ${k}`); process.exit(1); }
}

// Cron runs at two UTC times to cover daylight saving; only send when it is 7am local.
const localHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date()));
if (localHour !== SEND_HOUR && FORCE_SEND !== 'true') {
  console.log(`Local hour is ${localHour}, not ${SEND_HOUR} — skipping.`);
  process.exit(0);
}

const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
const toUtcDay = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const today = toUtcDay(todayStr);

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
const snap = await admin.firestore().doc(`upkeep/${UPKEEP_UID}`).get();
if (!snap.exists) { console.error('No Upkeep document found for that UID.'); process.exit(1); }

const tasks = (snap.data().tasks || [])
  .filter((t) => t.status === 'Active' && t.lastOccurrence)
  .map((t) => {
    const freq = FREQ_DAYS[t.frequency] || 30;
    const overdueDays = Math.round((today - (toUtcDay(t.lastOccurrence) + freq * 86400000)) / 86400000);
    return { name: t.name, priority: t.priority, overdueDays, ratio: overdueDays / freq };
  })
  .filter((t) => t.overdueDays >= 0);

// Same ordering idea as the app: 100+ days overdue, then overdue P1, then most overdue relative to cycle
tasks.sort((a, b) =>
  (b.overdueDays >= 100) - (a.overdueDays >= 100) ||
  ((b.priority === 1 && b.overdueDays >= 1) - (a.priority === 1 && a.overdueDays >= 1)) ||
  b.ratio - a.ratio);

if (!tasks.length) { console.log('Nothing due today — no notification sent.'); process.exit(0); }

const top = tasks.slice(0, 5).map((t) => `- ${t.name} (${t.overdueDays === 0 ? 'due today' : t.overdueDays + 'd overdue'})`);
const more = tasks.length > 5 ? `\n+ ${tasks.length - 5} more` : '';
const res = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
  method: 'POST',
  headers: { Title: `Upkeep: ${tasks.length} task${tasks.length === 1 ? '' : 's'} due or overdue`, Tags: 'house' },
  body: top.join('\n') + more,
});
if (!res.ok) { console.error('ntfy responded', res.status); process.exit(1); }
console.log(`Sent digest for ${tasks.length} task(s).`);

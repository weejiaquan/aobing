#!/usr/bin/env node
/**
 * Backfill daily/{date}/visitorCount and clean up the bot-spammed
 * daily/{date}/visitors/ map.
 *
 * Why this exists: the analytics page used to count visitors by
 * downloading daily/{date}/visitors/ (a per-visitor-id boolean map) and
 * calling Object.keys(...).length on it. After a bot inflated some days
 * with hundreds of thousands of fake IDs, that download became multi-
 * megabytes and the page took ~10s to load for a 7-day range.
 *
 * Going forward the client writes daily/{date}/visitorCount as a
 * transactional counter and never writes the visitors/{id} map. This
 * script:
 *   1. Walks the last N days of daily/{date}/visitors/.
 *   2. Classifies each ID as legit (matches guest- or 28-char UID) or
 *      bot (anything else).
 *   3. Sets daily/{date}/visitorCount to the legit count.
 *   4. Deletes daily/{date}/visitors/ entirely (unless --keep-map).
 *
 * Dry-run by default; pass --apply to actually write.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account.json \
 *   FIREBASE_DB_URL=https://aobing-dfe10-default-rtdb.firebaseio.com \
 *   node scripts/cleanup-bot-visitors.js [--apply] [--keep-map] [--days=N]
 *
 * Flags:
 *   --apply        Actually write visitorCount and (unless --keep-map)
 *                  delete the visitors/ subtree per affected date.
 *                  Without this flag, runs as a dry-run.
 *   --keep-map     Don't delete daily/{date}/visitors/ after backfill.
 *                  Use if you want to keep the raw IDs around for audit.
 *   --days=N       How many days back to scan, default 120. Today is
 *                  included. The script computes UTC dates client-side
 *                  so this matches what the app writes (toISOString).
 *
 * Get a service-account key from:
 *   Firebase Console → Project Settings → Service Accounts → Generate
 *   new private key.
 */

const admin = require('firebase-admin');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const KEEP_MAP = args.includes('--keep-map');
const daysArg = args.find(a => a.startsWith('--days='));
const DAYS = daysArg ? parseInt(daysArg.slice('--days='.length), 10) : 120;

const dbUrl = process.env.FIREBASE_DB_URL;
if (!dbUrl) {
  console.error('FIREBASE_DB_URL env var required.');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: dbUrl,
});

const db = admin.database();

const GUEST_RE = /^guest-[a-z0-9]+$/i;
const FIREBASE_UID_RE = /^[A-Za-z0-9]{28}$/;

function classify(id) {
  if (GUEST_RE.test(id)) return 'guest';
  if (FIREBASE_UID_RE.test(id)) return 'uid';
  return 'bot';
}

function lastNDays(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

(async () => {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Visitors map after backfill: ${KEEP_MAP ? 'kept' : 'deleted'}`);
  console.log(`Scanning last ${DAYS} days.\n`);

  let totalLegit = 0;
  let totalBot = 0;
  let datesTouched = 0;

  for (const date of lastNDays(DAYS)) {
    const snap = await db.ref(`daily/${date}/visitors`).once('value');
    const map = snap.val();
    if (!map) continue;

    let legit = 0;
    let bot = 0;
    for (const id of Object.keys(map)) {
      if (classify(id) === 'bot') bot++; else legit++;
    }
    if (legit + bot === 0) continue;
    datesTouched++;

    const flag = bot > legit ? ' ⚠ MOSTLY BOTS' : '';
    console.log(`${date}: ${legit} legit, ${bot} bot (total ${legit + bot})${flag}`);

    if (APPLY) {
      await db.ref(`daily/${date}/visitorCount`).set(legit);
      if (!KEEP_MAP) {
        // Firebase rejects a single write over ~16 MB, so 676K booleans in
        // one set(null) fails with WRITE_TOO_BIG. Batch the deletes via
        // update({key: null, ...}) with at most BATCH keys per request.
        const keys = Object.keys(map);
        const BATCH = 5000;
        for (let i = 0; i < keys.length; i += BATCH) {
          const updates = {};
          for (let j = i; j < Math.min(i + BATCH, keys.length); j++) {
            updates[keys[j]] = null;
          }
          await db.ref(`daily/${date}/visitors`).update(updates);
          if (keys.length > BATCH) {
            process.stdout.write(`  ...deleted ${Math.min(i + BATCH, keys.length)}/${keys.length}\r`);
          }
        }
        if (keys.length > BATCH) process.stdout.write('\n');
      }
    }
    totalLegit += legit;
    totalBot += bot;
  }

  console.log(`\nSummary: ${datesTouched} dates with visitor data.`);
  console.log(`  Legit visitors backfilled: ${totalLegit}`);
  console.log(`  Bot entries identified:    ${totalBot}`);
  if (!APPLY) {
    console.log(`\nDry-run only. Re-run with --apply to commit changes.`);
  } else {
    console.log(`\nApplied. visitorCount set per date${KEEP_MAP ? '' : '; visitors/ map deleted'}.`);
  }
  process.exit(0);
})().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});

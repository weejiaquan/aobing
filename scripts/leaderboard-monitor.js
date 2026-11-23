'use strict';
// Leaderboard injection monitor.
//
// Scans the public leaderboard boards for values that look like an injection
// attempt (the class of attack behind the Nov-2026 photoURL XSS) and alerts a
// Discord webhook. Meant to run on a schedule in CI as cheap defence-in-depth
// on top of output-escaping + database rules.
//
// Detection is tuned to ATTACK SIGNATURES, not punctuation. A legitimate name
// like "O'Brien" or "Søren <3" is NOT flagged (those render safely once escaped),
// so the monitor stays quiet until something actually looks like an injection —
// which is what keeps alerts trustworthy instead of ignored.

// Every publicly-readable board whose string fields get rendered somewhere.
const BOARDS = [
  'leaderboard/topClicks',
  'leaderboard/typingWords',
  'leaderboard/typingWpm/s15', 'leaderboard/typingWpm/s30', 'leaderboard/typingWpm/s60',
  'leaderboard/typingScore/s15', 'leaderboard/typingScore/s30', 'leaderboard/typingScore/s60',
];

// A photo URL must be empty or a clean https URL with no HTML-significant chars —
// the same shape the database rules now enforce. Anything else is the exact hole
// the real attack used, so treat it as hostile.
const CLEAN_PHOTO = /^https:\/\/[^"'<>\s]+$/;
const PHOTO_FIELDS = new Set(['photoURL', 'discordPhotoURL']);

// Attack signatures in ANY string field: an HTML tag opening, an inline event
// handler (` on...=`), a dangerous URL scheme, or a known scanner marker
// (Dalfox `dlx`/`xld`, XSStrike `v3dm0s`). Deliberately narrow: it keys on the
// shapes an exploit needs, not on bare quotes or angle brackets.
const ATTACK = /<\s*\/?\s*(?:script|iframe|svg|img|style|body|a|details|object|embed)\b|\son\w+\s*=|javascript:|data:text\/html|\b(?:dlx|xld)[0-9a-f]{4,}|v3dm0s/i;

function scanRow(board, uid, row) {
  const findings = [];
  for (const [field, value] of Object.entries(row || {})) {
    if (typeof value !== 'string') continue;
    if (PHOTO_FIELDS.has(field) && value !== '' && !CLEAN_PHOTO.test(value)) {
      findings.push({ board, uid, field, reason: 'photoURL is not a clean https URL', value });
    } else if (ATTACK.test(value)) {
      findings.push({ board, uid, field, reason: 'matches an injection signature', value });
    }
  }
  return findings;
}

function scanBoard(board, rows) {
  return Object.entries(rows || {}).flatMap(([uid, row]) => scanRow(board, uid, row));
}

module.exports = { BOARDS, scanRow, scanBoard, CLEAN_PHOTO, ATTACK };

// --- live run: only when executed directly, and only with credentials --------
if (require.main === module) {
  (async () => {
    const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    const dbUrl = process.env.FIREBASE_DB_URL || 'https://aobing-dfe10-default-rtdb.firebaseio.com';
    const webhook = process.env.ALERT_WEBHOOK_URL;

    // No credentials (e.g. a fork, or before secrets are set): skip cleanly so
    // the scheduled job stays green instead of nagging with red failures.
    if (!saJson) { console.log('No FIREBASE_SERVICE_ACCOUNT set — skipping live scan (detector tests still run separately).'); return; }

    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(saJson)), databaseURL: dbUrl });
    const db = admin.database();

    const findings = [];
    for (const board of BOARDS) {
      const snap = await db.ref(board).once('value');
      findings.push(...scanBoard(board, snap.val()));
    }

    if (findings.length === 0) {
      console.log(`Clean: no injection signatures across ${BOARDS.length} boards.`);
      process.exit(0);
    }

    console.error(`ALERT: ${findings.length} suspicious value(s):`);
    for (const f of findings) console.error(`  ${f.board}/${f.uid} [${f.field}] ${f.reason}: ${f.value.slice(0, 160)}`);

    if (webhook) {
      const lines = findings.slice(0, 10).map(f =>
        `• \`${f.board}/${f.uid}\` **${f.field}** — ${f.reason}\n  \`${f.value.slice(0, 180).replace(/`/g, "'")}\``);
      const body = { content: `⚠️ Leaderboard injection monitor found ${findings.length} suspicious value(s):\n${lines.join('\n')}` };
      try {
        const r = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        console.error('webhook status', r.status);
      } catch (e) { console.error('webhook failed:', e.message); }
    }
    // Non-zero exit turns the CI run red, so GitHub also emails the repo owner.
    process.exit(1);
  })().catch(e => { console.error('monitor error', e); process.exit(2); });
}

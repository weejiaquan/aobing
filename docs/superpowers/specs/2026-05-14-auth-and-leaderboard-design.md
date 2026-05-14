# Auth, per-user stats, and leaderboard — design

**Status:** approved 2026-05-14
**Scope:** v1 (Google sign-in, anonymous baseline, single all-time leaderboard, level/XP, currency field)

## Goal

Introduce per-user identity to a previously fully anonymous clicker, without
adding hosting infrastructure or storing sensitive data. Players who don't
care can keep clicking as anonymous; players who want progression can link a
Google account, get a leaderboard slot, customize a display name and
country flag, and accrue a currency for a future cosmetics shop.

Keep the existing keyboard-spam feature, but stop it from polluting the
leaderboard — keyboard input feeds the satisfaction loop and the site-wide
totals, mouse/tap input feeds the personal leaderboard.

## Constraints

- Static frontend only (GitHub Pages). No backend, no Cloud Functions.
- Firebase Auth + Firebase Realtime Database. No new Firebase products.
- Free tier only. No Blaze plan upgrade.
- No PII stored by us: no email, no password handling, no DOB. UID + provider-supplied
  display name + photo + ISO-2 country code is the maximum we hold.
- Existing global counters and analytics paths must keep working unchanged.

## Architecture

Two new Firebase services on top of the current stack:

- **Firebase Authentication** — anonymous-by-default, linkable to Google.
  Replaces the current `aobing_visitor_id` localStorage UUID.
- **Realtime Database** gets two new top-level paths: `users/{uid}` for
  per-user data, and `leaderboard/topClicks` as a public denormalized
  projection. Existing paths (`clicks`, `daily/*`, `skins/*`) stay untouched.

## Data model

```
users/{uid}/
  profile/                  ← linked-only; anonymous users have no profile node
    displayName             "Mari-fan"           (1-24 chars, unicode allowed, no uniqueness)
    photoURL                "https://..."        (from Google)
    country                 "JP"                 (ISO-2, ipapi.co pre-fill, user-editable)
    linkedAt                1715683200000
    provider                "google"
  stats/
    totalClicks             12431                (lifetime mouse/tap, monotonic → level + rank)
    coinBalance             12180                (spendable; +1 per mouse/tap, −cost on purchase)
    maxCombo                240
    skins/{variantId}/      1832                 (per-variant mouse/tap counts)
    createdAt               1715600000000
    lastClickAt             1715683500000        (anti-cheat throttle)

leaderboard/
  topClicks/{uid}/
    name                    "Mari-fan"
    country                 "JP"
    photoURL                "https://..."
    totalClicks             12431
    level                   24
```

`spentCoins` is derivable as `totalClicks − coinBalance` — not stored.

`leaderboard/topClicks` is a denormalized projection updated alongside
`users/{uid}/stats/totalClicks` and `users/{uid}/profile/*` so the board can
be queried cheaply with `orderByChild('totalClicks').limitToLast(100)` without
fanning out to every user record.

## Auth flow

```
First visit:
  signInAnonymously() → permanent UID stored on the Firebase Auth client
  Each mouse/tap writes users/{uid}/stats/*. No profile node yet.
  Sensei bar shows "Trainer  Lv.N", no avatar.

User clicks "Sign in with Google":
  linkWithPopup(GoogleAuthProvider)
  → preserves the same UID (all existing anon stats carry over)
  → reads Google credential, creates users/{uid}/profile/* from {displayName,
    photoURL} and visitorCountry (already known from ipapi.co at page load)
  → mirrors a leaderboard/topClicks/{uid} row

Sign out (from a linked account):
  signOut() then signInAnonymously() → fresh anon UID. The linked account's
  stats stay in the cloud under the old UID and are reachable again by
  signing in with Google. The new anon session starts from zero.

Sign out (from an anonymous account):
  Not exposed in the UI — the profile editor "Sign out" button only shows
  for linked accounts. Anonymous-only users have no way to abandon their
  UID short of clearing browser storage (which is identical to the natural
  "I cleared my cookies and lost my progress" case).

Edge case — Google account already linked to a different UID
  (e.g. user originally signed up on browser A, now linking from browser B):
  linkWithPopup throws auth/credential-already-in-use.
  Catch it, surface "This Google account is already linked to another
  player. Sign in to that one instead?". On confirm, signInWithCredential
  attaches the existing linked UID; the throwaway anon UID is discarded
  along with its pre-link stats. Acceptable — they'd have been double-counting otherwise.
```

## Profile editor

Linked users only. Opened by clicking the sensei bar (or via a "Profile"
entry in the existing settings panel). Three fields + a sign-out button:

- **Display name** — text input, 1-24 chars, unicode allowed (so 青葉ファン
  works), uniqueness *not* enforced, no profanity filter. Trust users; ban
  bad actors via Firebase Auth's disable.
- **Country** — flag picker, alphabetized list of all ISO-2 codes with flag
  emoji. Pre-populated from ipapi.co at link time.
- **Sign out** — drops back to a fresh anonymous UID.

Writes go to `users/{uid}/profile/*` and mirror to
`leaderboard/topClicks/{uid}` so the board reflects the new name/country
within the next read.

## Sensei profile bar (always visible)

Bottom-left of viewport, mirroring the existing time pill at bottom-right.
Shared BA card styling (cyan accent, translucent white card, same shadow as
the existing pills).

Linked:
```
┌──────────────────────────────────────┐
│ [avatar] Mari-fan  🇯🇵  Lv.15        │
│          ████████░░░░  1,432 / 1,600 │
│                          💰 12,180   │
└──────────────────────────────────────┘
```

Anonymous:
```
┌──────────────────────────────────────┐
│ [?] Trainer  Lv.3                    │
│     ██░░░░░░░░  22 / 200             │
│                  💰 22  Sign in →    │
└──────────────────────────────────────┘
```

- Avatar: `<img>` of `photoURL` for linked users; a placeholder glyph for anon.
- XP bar uses the same gradient as the combo bar fill.
- The "current clicks / clicks needed for next level" text under the bar
  updates live on each mouse/tap.
- Click anywhere on the bar → opens the profile panel (sign-in flow for
  anon; edit form for linked).

Mobile (< 480px): single line, no avatar, no coin counter; tap still opens
the panel.

## Level system

```
level(c)              = floor(sqrt(c / 20))
clicksForLevel(n)     = n² × 20
clicksInLevel(c)      = c − clicksForLevel(level(c))
clicksToNextLevel(c)  = clicksForLevel(level(c) + 1) − clicksForLevel(level(c))
```

Calibration:
- 100 clicks → Lv.2
- 1,000 clicks → Lv.7
- 10,000 clicks → Lv.22
- 100,000 clicks → Lv.70
- 1,000,000 clicks → Lv.223

Cosmetic only — drives the level number and XP bar in the sensei bar and
the leaderboard rows. The leaderboard sort key is `totalClicks` itself, not
`level`, so two players at Lv.15 sort by raw clicks.

The 20-coefficient is a tunable; expect to retune after launch based on
actual play patterns.

## Leaderboard UI

New 🏆 button in the top-right corner, alongside the existing 📊 stats
button. Opens a modal styled like the stats modal:

- **Header**: title "Leaderboard" + info banner: *"Only mouse and tap
  clicks count toward your rank. Keyboard mashing is fun, but it's not
  on the board."* (translated, like all other strings.)
- **Top 100**: fetched on open via `orderByChild('totalClicks').limitToLast(100)`.
  Live updates while the modal is open through a single value listener.
  Detaches on close.
- **Row format**: rank, country flag, avatar, display name, level badge,
  click count. Highlighted background if it's the viewer's row.
- **Below the top 100**: "Your rank: #237 of N players" if signed in and
  outside top 100. Computed by a second query that counts UIDs with
  `totalClicks > yours`.
- **Bottom**: "Sign in to join the leaderboard →" CTA, only shown for
  anonymous viewers.

Public-readable, so anonymous players can browse without signing in.

## Mouse vs keyboard — what counts where

| Counter | Mouse / tap | Keyboard | Visible where |
|---|:---:|:---:|---|
| Global lifetime clicks (site headline) | ✓ | ✓ | Top-center pill (unchanged) |
| Per-skin lifetime (current skin) | ✓ | ✓ | Top-center pill subvalue (unchanged) |
| Daily aggregates + country chart | ✓ | ✓ | Stats modal (unchanged) |
| `users/{uid}/totalClicks` | ✓ | ✗ | Sensei bar, leaderboard |
| `users/{uid}/coinBalance` | ✓ | ✗ | Sensei bar 💰 |
| Combo / max combo | ✓ | ✓ | Combo display (unchanged) |

The keyboard event handler continues to fire SFX, bump combo, spawn
particles, and increment the global / daily / per-skin / per-country
counters. It does *not* write to `users/{uid}/stats/totalClicks` or
`users/{uid}/stats/coinBalance`.

### Transparency feedback

- **Mouse/tap click**: a small `+1` floats up near the character. The XP
  fill on the sensei bar emits a brief glow pulse. Coin counter ticks.
- **Keyboard press**: same SFX, combo, particles. *No* `+1` and *no*
  sensei-bar glow. The absence is the signal.
- A new **"Keyboard clicks" toggle** in the settings panel (default ON)
  lets players disable keyboard input entirely if they find it distracting.

## Anti-cheat

Two layers, enforced in RTDB Security Rules — frontend can't cheat past them.

- **Rate limit**: a click write must include `lastClickAt` set to server
  time `now`, and the *previous* `lastClickAt` must be at least 15 ms
  ago. Caps to ~65 writes/sec — comfortable for the fastest human
  (~12/sec) and any reasonable burst, blocks scripts hammering 1000/sec.
- **Delta cap**: each `totalClicks` and `coinBalance` write must
  increment by exactly 1: `newData.val() === (data.val() || 0) + 1`.
  No setting the counter to a million directly from the console.

Each mouse/tap is a single multi-path `update()` that writes
`totalClicks`, `coinBalance`, and `lastClickAt` atomically. The
`totalClicks` rule cross-references `lastClickAt` so the client cannot
bypass the throttle by skipping the timestamp.

Won't stop a patient cheater with a 15ms-paced loop, but blocks 99% of
casual cheating with no server-side compute. Server-validated counters
(Cloud Function increment endpoint) are the Phase 2 escalation if
real-time cheating shows up.

## Security rules sketch

```
{
  "rules": {
    ".read": false,
    "users": {
      "$uid": {
        ".read":  "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid",
        "stats": {
          "totalClicks": {
            ".validate":
              "newData.isNumber()
               && newData.val() === (data.val() || 0) + 1
               && now - (data.parent().child('lastClickAt').val() || 0) >= 15
               && newData.parent().child('lastClickAt').val() === now"
          },
          "coinBalance": {
            ".validate":
              "newData.isNumber()
               && newData.val() >= 0
               && newData.val() <= (data.val() || 0) + 1"
          },
          "lastClickAt": {
            ".validate": "newData.val() === now"
          }
        }
      }
    },
    "leaderboard": {
      "topClicks": {
        ".read": true,
        ".indexOn": "totalClicks",
        "$uid": {
          ".write": "auth != null && auth.uid === $uid && root.child('users/' + $uid + '/profile').exists()"
        }
      }
    },
    "clicks":         { ".read": true, ".write": true },
    "daily":          { ".read": true, ".write": true },
    "skins":          { ".read": true, ".write": true },
    "combo":          { ".read": true, ".write": true }
  }
}
```

`coinBalance` is allowed to *decrease* (purchases) — only the
increment-by-1-on-click case is bounded above. The lower bound `>= 0`
prevents going negative; a future shop will add validation that the
decrement matches a known item cost.

Existing site-wide paths stay world-writable to preserve current
unauthenticated click behavior; only the user-scoped paths are gated.

## What happens to existing data

- Global `clicks` and `daily/*` aggregates **stay as-is** — they're
  site-wide stats, not user stats. Continue to be incremented by both
  mouse and keyboard from any source.
- `skins/{variantId}` global per-skin totals stay (they power the
  "current skin clicks" pill subvalue).
- `aobing_visitor_id` localStorage key is **deleted** on the first
  post-deploy load. The Firebase Auth UID takes over as the visitor key
  for the daily-visitor uniqueness logic.
- **No backfill**: pre-launch anonymous clicks are not attributed to any
  user. Every user starts at `totalClicks = 0`. The global lifetime
  count is unchanged, so the headline pill on the homepage doesn't
  reset.

## i18n

New translation keys to add across all seven locales:
- `auth.sign_in_google` ("Sign in with Google")
- `auth.sign_out`
- `auth.already_linked` (the credential-already-in-use error)
- `profile.title`, `profile.display_name`, `profile.country`
- `sensei.trainer` (default anon name)
- `sensei.sign_in_cta` ("Sign in →")
- `leaderboard.title`
- `leaderboard.your_rank` ("Your rank: #{rank} of {total}")
- `leaderboard.info_banner`
- `leaderboard.sign_in_cta`
- `level.label` ("Lv.{n}")
- `settings.keyboard_clicks` (new toggle)

I'll lean on existing key naming conventions.

## Out of scope (Phase 2 candidates)

- Discord / X / GitHub sign-in
- Email link or password sign-in
- Cosmetics shop, coin spending UI, gacha
- Daily / weekly / per-character leaderboards
- Friend lists, profile pages, direct messaging
- Achievements, badges, titles
- Server-side anti-cheat via Cloud Functions
- Click streaks, daily login bonuses
- Animated XP-up effects beyond the brief glow pulse

## Open risks

- **Anti-cheat strength**: 15ms throttle in security rules is a soft
  defense. A determined cheater with a paced loop can grind faster than
  any human. Acceptable for v1; escalate to server-validated counters if
  the board becomes obviously gamed.
- **Linked-only board feels empty at launch**: until enough users sign
  in, the leaderboard will look sparse. Mitigation: the sign-in CTA at
  the bottom of the board converts viewers; the sensei bar nudges
  anonymous players toward linking.
- **Anonymous UID loss**: clearing the browser wipes the anon UID and
  all its progress. By design — that's exactly the friction "sign in to
  save progress" addresses. Make the CTA visible in the sensei bar.
- **ipapi.co dependency**: country pre-fill relies on a third-party
  service that's already in use. If it fails the country field is
  empty; the user can still set it manually in the profile editor.

# Multiplayer implementation and verification

Updated 2026-10-05. The client is in `aobing`; the matching Python service is in
the sibling `kei-bot` repository. These are local implementation changes, not a
deployment record.

## Supported flow

- Signed-in web and Discord Activity players create/join a Standard lobby.
  Passwords and unlisted room codes are supported. Anonymous Firebase users
  cannot join. The first action waits for socket authentication.
- Activity players can join one unlisted room using the SDK's `instanceId`.
  This groups an Activity instance, not every Activity in a voice channel. The
  server requires a Discord identity claim. Instance IDs are routing capabilities,
  not independently verified voice-channel membership. These rooms cannot be
  joined through the public browser or ordinary room-code command.
- The host selects an imported, cached Standard chart. Local folder-only entries
  must first be imported into the cached library. WebRTC is attempted first; an
  unavailable, failed or stalled peer connection falls back to WebSocket relay.
- The existing SHA-256 of `.osu` text remains the library key. A separate
  `contentHash` verifies text, audio, artwork and beatmap samples. Derived display
  metadata is excluded so parser updates do not invalidate otherwise identical
  assets. Unexpected senders, stale transfer IDs and old maps cannot complete a
  pending transfer. Received charts retain their origin information.
- Ready prepares audio under a user gesture. The host starts a four-second
  countdown after the ready/spectator gate. Clients estimate server-clock offset
  from ping round trips and schedule their local AudioContext accordingly.
- Points are `300*h300 + 100*h100 + 50*h50`; accuracy and maximum combo break
  ties, with forfeits last. Scores are client-reported casual results. Autoplay,
  intro skip and quick restart are disabled for an active race. Pause/blur/tab
  hiding/leaving forfeits the network result while preserving local gameplay.
- Final results arrive independently of saving local personal bests. A host
  departure promotes the earliest remaining member. Every round expires after
  the last object time plus a 60-second grace period, including long intros.
  Host migration retains prepared audio for the unchanged map; players do not
  lose readiness simply because the host left. A paused forfeit can prepare the
  next round without requiring a page reload.

## Failure recovery and limits

- Eight seconds to authenticate; periodic ping; client detects silence after
  45 seconds and server drops clients idle for 60 seconds. Offline play remains
  available; Retry obtains a fresh Firebase token and connection. A second tab
  with the same UID is rejected without evicting the first session.
- Four ephemeral lobbies, eight members each, one room per UID, 64 authenticated
  plus pending connections per process. Lost server state after a restart is
  intentional; players create or join a new room.
- 128 KiB WebSocket frame limit, bounded send queues, approximately 1 MiB/s
  ingress budget per client, command throttling and a lobby-wide 4 Hz score feed.
  Final results bypass the score-feed throttle. A failed receiver does not
  disconnect the host or other receivers.
- 64 Mi characters maximum encoded chart (normally base64/ASCII, roughly 48 MiB
  of binary assets), 512 beatmap samples, and at most one hour to the last object.
  Each transfer has a 20-second inactivity watchdog and 20-minute total deadline
  to accommodate seven simultaneous maximum-sized relay downloads. Failure
  makes that player a spectator; they can retry. P2P uses STUN only, no TURN.
  A DataChannel that opens but stalls still falls back to relay. Offers/answers
  are sent before locally discovered ICE candidates. Verification and saving
  have a separate 30-second watchdog; a stalled save cannot hold the room in
  loading forever. Failed host reads are not cached across retries.
- The process must run as **one worker/one replica**. Registry and socket hub are
  in memory; multiple independent workers will split rooms and break routing.
- Discord presence re-arms `onDisconnect` before republishing on every RTDB
  reconnect. Stale acknowledgments cannot reactivate a disconnected session.
  Loading presence after the profile is ready now triggers initialization too.
- Activity boot has bounded SDK/auth/token waits and a Retry button. App Check
  refresh is single-flight, checks HTTP and payload validity, and retries failed
  refreshes without caching an invalid token. Existing web sign-in is preserved.

## Automated verification

From `aobing`, run the root test files explicitly (untracked `_localmod` scripts
are separate developer experiments):

```powershell
node --test (Get-ChildItem -File -Filter '*.test.js' | ForEach-Object FullName)
node scripts/test-multiplayer-integration.cjs
```

The integration runner accepts a backend path as its first argument and
`MP_TEST_PYTHON` to override the backend interpreter. It starts
`kei-bot/tests/mp_fixture_server.py` on a free loopback port, uses test-only
identities, and shuts the process down. It does not contact Discord or Firebase.
The production JavaScript controller runs with DOM/audio stubs against real
WebSockets. It covers chart relay and samples, repeat rounds after host migration,
eight simultaneous players, Activity grouping, service restart and Retry, stale
map checks, temporary host-storage failures and stalled receiver saves. A
deterministic peer-transport fixture also exercises successful, interrupted and
stalled P2P controller paths and verifies their relay fallback and cleanup.
Pure peer-session tests cover
signaling, early ICE, chunking, backpressure failure and fallback cleanup; these
are not a real browser-to-browser WebRTC/NAT test.

From `kei-bot`:

```powershell
.venv/Scripts/python.exe -m pytest tests/test_multiplayer_registry.py tests/test_multiplayer_routes.py tests/test_activity_routes.py tests/test_firebase.py -q
```

## Deployment and live acceptance still required

The public health endpoint responded successfully during this session, but the
public lobby endpoint did **not** advertise protocol 2. The new implementation
has not been deployed. Deploy the backend and client together, backend first.
The new client refuses an older protocol rather than showing controls that cannot
work. Existing open clients need a reload after the update.

The client continues using the existing `/kei` URL mapping to `kei.aobing.it`;
no new mapped host or Discord OAuth scope is needed. WebRTC may be unavailable
inside the Activity, so verify the relay path there. The server-side OAuth
exchange and RTDB presence model remain in place; no unauthenticated SDK roster
commands are needed.

Before calling the live release verified:

1. On web, use two accounts to create a password room, transfer a real `.osz`,
   ready, play, compare results, and repeat a round. Confirm audible timing and
   controls, including a chart with an intro longer than a minute.
2. In Discord desktop and mobile, join the same Activity, enter its shared room,
   play the same flow and verify the `/.proxy/kei` WebSocket/relay. Check the lobby
   and standings at narrow portrait and short landscape sizes.
3. Exercise host departure, guest disconnect, blocked WebRTC, interrupted
   download, server restart and Retry. Verify single-player remains usable.
4. Leave the Activity open across App Check expiry and a network reconnect;
   confirm refresh, presence and subsequent rounds recover.

No interactive browser or Discord surface was available in this environment.
Mocked DOM/audio checks cannot establish hardware latency, visual layout, real
NAT traversal or Discord proxy behavior. No claim of flawless live operation is
made from the automated checks alone.

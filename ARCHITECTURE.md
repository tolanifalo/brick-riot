# Architecture

## Packages

| Package | Depends on | Role |
| ------- | ---------- | ---- |
| `@brick-riot/shared` | none | Simulation, boards, balance/economy config, progression rules, replay, autoplayer, multiplayer protocol, board profiles, compatibility service, **Glicko-2, Quick Match pairing, adaptive lead, input-log codec, account API types**. Pure TS, no DOM/Phaser/network. |
| `@brick-riot/server` | shared | Colyseus match server: HTTP API, `MatchRoom` (lobby → match → result), **`QueueRoom` (Quick Match)**, `MatchEngine` (authoritative race), join-code registry, rate limits, telemetry. **better-auth accounts, Prisma/PostgreSQL persistence, server-side progression, read models.** |
| `@brick-riot/client` | shared | React screens, Phaser rendering, DOM input, local (guest) persistence, **account client and server-backed progress**, multiplayer client (Colyseus SDK, prediction, adaptive lead). |

Packages are consumed as TypeScript source. The server runs with `tsx` (no build step).

## Simulation (`shared/src/sim`)

- **Fixed timestep**: 120 ticks/s (`SIM.dt`). The world is 480×800 units (portrait).
  Multiplayer also uses 120 Hz: the physics constants and the Phase 1 golden replays
  depend on it.
- **Single entry point**: `Simulation.step(TickInput) → SimEvent[]`. State
  (`SimState`) is plain JSON. A simulation whose `state` is replaced by a transported
  copy continues bit-identically (tested); multiplayer resync relies on this.
- **Determinism**:
  - Seeded Mulberry32 streams (launch, drops).
  - Only `+ - * / %` and `Math.sqrt` are used in the step path, with `TRIG` literals.
  - Iteration is in id order.
  - `stateChecksum` (FNV-1a over the state JSON) is equal on server and browser for
    equal states.
- Tick order, collisions, explosions and golden replays are unchanged from Phase 2
  (see CHANGELOG).

## Boards and progression
- `BoardDefinition` data and validation (as in Phase 2).
- Pure progression rules live in `shared/src/progress`, and local saves sit behind
  `ProgressRepository`. **Local progress is not authoritative.**
- Phase 4 save format v2 adds `upgrades`, the preferred `loadout` and `settings`, with a
  1→2 migration.
- Workshop purchases use the pure `purchaseUpgrade(progress, id, expectedLevel)`. The
  store runs it inside the serialised save chain and applies the result only after a
  successful save, so coins and levels always change together.
- A solo run records the upgrade levels it used, and local verification replays it with
  the same config.

## Multiplayer

### Authority model
The server owns everything that affects the outcome:
- the match clock and both simulations;
- paddle positions (from validated intents), balls, bricks, power-ups and lives;
- completion and exhaustion ticks;
- the result and its persistence.

Clients send only **intentions**:
- tick-stamped paddle target/axis/launch;
- ready, board choice, loadout choice and (host) equipment mode;
- rematch;
- ability *requests* `{ability, seq, tick}`.

**No message can set score, bricks, lives, positions, energy, cooldowns, effects,
completion or results.** Unknown message types (e.g. a forged `complete`, `result` or a
client-sent `ext`) are logged and refused.

### Server structure (`packages/server/src`)

```
main.ts / app.ts      createGameServer(): one HTTP server = Express API + Colyseus WebSocket transport (CORS locked to allowed origins)
http/api.ts           /api/auth/* (better-auth) · /api/me · /api/solo/runs · /api/workshop/purchase · /api/loadout ·
                      /api/account/import-local · /api/game/ticket · /api/leaderboards/:category · /api/me/matches ·
                      /api/matches/:id · /api/players/:id · /api/ranked/status · /api/health · /api/boards · /api/rooms/resolve
auth/                 better-auth instance, mailer (SMTP or dev outbox), single-use game tickets
progression/          ProgressionService: issue/finish verified solo runs, purchases, loadouts, ledger, guest import
db/                   Prisma client (adapter-pg), migrations runner, embedded PostgreSQL for dev/tests
queries/readModels.ts leaderboards (paginated), match history (cursor), match detail, board telemetry
rooms/MatchRoom.ts    one 1v1 room (private with a code, or a reserved Quick Match room): seats, lobby, countdown, match loop, result, rematch, reconnection
rooms/QueueRoom.ts    the Quick Match queue: pairs every second, creates the match room, reserves both seats
match/MatchEngine.ts  pure: two Simulations on one clock, input buffers, race rules, replay verification, input-timing feedback
security/roomCodes.ts CSPRNG 6-char codes (32-char alphabet, ~1.07e9), tombstones for "expired"
security/rateLimit.ts token buckets (messages) + per-IP keyed limiter with blocking (code guesses)
persistence/…         MatchResultRepository: PostgreSQL when DATABASE_URL is set (in-memory otherwise), immutable per match id
telemetry.ts          BalanceTelemetry: per-board clears/clear ticks for future BDR calibration
config.ts             env config (see README); production refuses dev/test settings
```

### Match engine (pure, unit-tested)
- **One `Simulation` per player** (each with its own board and seed). Both are stepped
  in the same loop iteration for every match tick: one shared clock.
- **Clock**: the room computes `target = floor((now - goAt) × 120 / 1000)` from the
  server's wall clock (`goAt` is chosen by the server) and calls `advanceTo(target)`
  from a 60 Hz server loop. Physics never depends on message arrival.
- **Input policy**:
  - Inputs are buffered per player by tick, and ticks must strictly increase per
    player. Sequence numbers must increase; duplicates are dropped.
  - At tick T, the buffered input for T is used. Otherwise the last paddle intent
    repeats with `launch=false`.
  - A *late* input (for an already-simulated tick) becomes the held intent from the
    next tick, and a late launch is applied on the next tick rather than dropped.
  - Inputs more than 240 ticks (2 s) in the future are rejected.
  - Launch actions are limited to 15/s.
  - Players are independent, so seat order (A then B) within a tick cannot change
    anything.
- **Race rules** (evaluated after both simulations step, every tick):
  1. Both cleared on this tick → draw (`same_tick_clear`).
  2. Exactly one cleared → that player wins (`board_cleared`). A player who ran out of
     balls earlier does not end the match; the other keeps playing.
  3. Both ran out of balls → draw (`both_exhausted`).
  4. The duration tick is reached → draw (`time_expired`).
  5. Forfeit (deadline missed or deliberate leave) → the opponent wins (`forfeit`).
  6. Nobody present when a deadline passes → no contest (`both_disconnected`).
- **Finality**: the first outcome is final. Later clears, forfeits, inputs and ticks are
  ignored, and the room finalises exactly once.
- **Verification**: at finalisation, each player's *applied* input log is replayed from
  scratch and must reproduce the live final state (`replayVerified`). Logs and seeds
  are stored with the result.

### Room lifecycle
`lobby → countdown → playing → finished → (rematch) lobby`. Codes map to private rooms
(not listed by the matchmaker).

| Situation | Behaviour |
| --------- | --------- |
| Join | `POST /api/rooms/resolve` (per-IP rate limit; 10 wrong codes → 10-minute block), then `joinById`. `onAuth` re-checks the code (also counted), phase, capacity, and that this browser profile has no seat yet |
| Board choice | Must be multiplayer-eligible. Normal rooms check unlocks against the client's **claimed** local progress (private matches only). Dev rooms skip unlock checks and are labelled |
| Ready | Requires a board. If the boards are incompatible, both players must accept an unranked race. Changing a board resets readiness |
| Countdown | Server-chosen `goAt`; inputs are rejected until it passes; a drop or cancel aborts it (recorded as `match_cancelled`) |
| Drop during play | Seat held for `RECONNECT_SECONDS` (default 20). **The game continues for both players**: the absent player's paddle holds its last intent and never launches. The opponent sees an offline countdown |
| Reconnect | Colyseus single-use reconnection token, same seat and session. The client receives `matchStart` and fetches the authoritative state. Nothing (balls, score, time) is reset |
| Deadline missed | Forfeit if the opponent is present; otherwise `both_disconnected` (no winner) |
| Deliberate leave mid-match | Immediate forfeit |
| After result | Request/accept/decline rematch → lobby with boards kept, readiness reset, new match id. A lone player can reopen the room |
| Idle | Lobbies with no match for 15 min close and their code becomes "expired" |

### Messages
Defined in `shared/src/multiplayer/protocol.ts`. Server → client:
- `welcome`, `lobby` (full lobby view on every change), `matchStart` (own seed, both
  boards, `goAt`, server time).
- `sync` at 20 Hz: authoritative progress of both players, time left, and a checksum
  of the receiver's own simulation.
- `preview` at 10 Hz: a compact opponent board.
- `state`: a full resync, only on request.
- `result`, `pong`, `rejected`, `closed`.

State travels as explicit typed messages rather than Colyseus Schema, which keeps the
protocol in `shared` and testable.

### Client prediction (`client/src/net`, `game/MatchScene.ts`)
- `ServerClock` estimates the server time from pings, taking the offset from the
  lowest-RTT sample.
- `MatchScene` (a `SoloScene` subclass with the same rendering) steps its own
  simulation up to the **predicted tick** (server tick + RTT/2 + 40 ms), records each
  consumed input and sends it tick-stamped, in batches of about 30 Hz (launches
  immediately). With on-time inputs, server and client compute identical states, so the
  paddle and ball respond with zero added latency.
- Every `sync` checksum is compared with the client's own checksum for that tick. On
  a mismatch, the client requests `state`, adopts it, replays its own inputs since that
  tick, and redraws the board. It cannot silently diverge (e2e asserts that checks run
  throughout).
- If the client falls more than 2 s behind (hidden tab, rejoin), it waits for the
  server state instead of fast-forwarding.
- The opponent is shown only from server data (`sync` progress plus `preview` canvas).
  The local "board clear" banner says "confirming"; results come only from the server.

### Board eligibility and compatibility (`shared/src/multiplayer`)
- `MULTIPLAYER_BOARD_PROFILES`: id/version, collection, difficulty, eligibility (with
  reason), required unlock, expected completion time and IQR, calibration source and
  samples, allowed modifiers, band, mechanics. Six boards are eligible. The data is
  **bot-estimated**, so it is labelled `estimated`, never `calibrated`.
- `evaluateCompatibility`:
  - Blocks pairs whose expected times differ by more than 15%, whose ratings differ by
    more than 2, whose estimated first-to-clear chance is outside 40–60% (Phase 4), or
    that lack data. The thresholds are provisional.
  - Warns about variance, timer pressure and differing mechanics.
  - Ranked eligibility additionally requires human-playtest calibration, which nothing
    has yet.
  - There are no handicaps.

### Ranked foundation (`shared/src/competitive`, interfaces only)
- Interfaces: `PlayerRating` (MMR, deviation, volatility, placements),
  `BoardDifficultyRating`, `EquipmentPowerRating`, `ExperienceLevel`, `QueueEntry`,
  `MatchmakingEligibility`, `MatchResultVerification`.
- `evaluatePairing` checks skill (a window widened by uncertainty and wait time),
  boards, equipment band and beginner protection **as separate pass/fail criteria**,
  never blended into one score.
- `verifyForRating` requires a server-authoritative, replay-verified result and verified
  identities. No ratings change in Phase 3.

### Abilities and sabotage (Phase 4)
Abilities run **inside the one deterministic simulation**. There is no second engine.

```
client ──ability {ability, seq, tick}──▶ MatchRoom ──▶ MatchEngine.queueAbility (shape, seq, 6/s)
                                                          │ next server step, at tick R:
                                       resolveAbilities() │ sorted by (client tick, seat)
                                                          ▼
                     AbilityArbiter.request(seat, ability, both sims, R)   (shared/src/abilities/arbiter.ts)
                       validates: equipped · cooldown · energy (minus reserved) · lockout · target
                       serving/finished/debuffed/immune · shield · frost space   → refused = free
                       schedules ExternalCommands at R + 48 into the affected simulation(s):
                         attacker: {spend}   target: {debuff} or, if shielded, {block}
                         self:     {spend} + {shield} / {cleanse}
                                                          │
       stepOnce(t): TickInput.ext = arbiter.take(seat, t) │  (client-sent ext is stripped)
                                                          ▼
                                    Simulation.applyExternal → events
```

- **Commands are input.** `TickInput.ext` is part of each player's applied input log, so
  replay verification covers sabotage.
- **Simulation state** (`SimState`) holds `energy10` (tenths), `cooldowns`,
  `shieldUntil`, `debuff` (pending/active, remaining, deferral) and `immuneUntil`, so
  resync and replay carry them.
- **Frost Brick** is a `frost`-type brick appended to `bricks`. It is not required and
  awards no score, energy or combo. Its cell is chosen deterministically by
  `Simulation.frostCell()`.
- **Prediction stays exact.** Right after deciding, the server sends each affected player
  `ext {upcoming}` (their scheduled commands). `MatchNet` stores them by tick and
  `MatchScene` attaches them to the local input on exactly that tick, which is 0.4 s
  later and ahead of the client's ~5-tick lead.
  - If a command arrives for a tick the client already simulated without it, the client
    requests a resync (`stats.lateCommands`).
  - A resync `state` includes `upcoming`, and the replay after adoption uses the
    authoritative schedule.
- **Per-player config.** `buildPlayerConfig(equipment, mode)` (passives, capped upgrades)
  is built identically on both sides. `matchStart` carries the receiver's locked
  equipment, and `matchConfig(start)` rebuilds it on the client.
- **Feedback.** `abilityResult` goes to the requester, `abilityEvent` to both players,
  and `sync` carries energy, debuff, shield and immunity per player.

### Equipment (Phase 4)
- Loadouts are validated on join and on `setLoadout` (`validateLoadout`: slots, unlock
  level, budget). They change only in the lobby while not ready, and lock at the
  countdown.
- **Phase 5:** for signed-in players the server loads the loadout, owned abilities and
  upgrade levels from the database (`loadSeatAccount`). A `setLoadout` in the lobby must
  use owned abilities and is saved to the account. **Guests always get no upgrades**:
  client-claimed upgrade levels are ignored. Equipment is locked into the match at the
  countdown, so later purchases cannot change a running match.
- Equipment Power Ratings (`rateEquipment`, `compareEquipment`) are computed by the
  server from definitions and feed a separate equipment-acceptance check.
- Match records store the equipment mode, the locked equipment and each player's
  equipment power.

### Multiplayer boards (Phase 4)
`getMatchBoard(id)` resolves campaign boards **and** versioned multiplayer variants
(`MULTIPLAYER_VARIANTS`, ids `<base>-mp`). The room, board-choice validation, client
scene, preview and result panel all go through it. The campaign (`getCampaignBoard`)
never sees variants. Compatibility adds a first-to-clear estimate from stored decile
distributions; see BOARD_COMPATIBILITY.md.

## Accounts and persistence (Phase 5)

Accounts are optional. Without `DATABASE_URL` the server runs exactly as in Phase 4
(guests, private rooms, in-memory results), and account routes answer
`503 accounts_unavailable`. Policy details and the guest-import rules are in
[ACCOUNTS.md](ACCOUNTS.md).

### Database
PostgreSQL through Prisma 7 (`prisma-client` generator → `src/generated/prisma`, git-ignored,
regenerated by `typecheck`/`test`; `@prisma/adapter-pg`). The schema is in
`packages/server/prisma/schema.prisma`.

| Area | Tables |
| ---- | ------ |
| better-auth | `user` (+ `status`, `lastLoginAt`), `session`, `account` (password hash), `verification`, `rate_limit` |
| Progress | `player_profile` (xp, level, coins: integers), `solo_board_progress`, `board_unlock` (source: default/progression/import), `solo_run` (issued → finished; seed, upgrade snapshot, gzipped inputs, summary) |
| Equipment | `owned_ability`, `loadout` (+ equipment power), `upgrade_level`, `purchase` |
| Money | `ledger_entry`: one row per XP/coin change, unique `(user, idempotencyKey, currency)`, balance after |
| Matches | `match` + `match_participant` (seat, board, result, equipment power, rating before) |
| Competitive | `season`, `rating` (`(user, queue, season)`), `leaderboard_entry` (best value per category/board/season/player, with evidence id) |
| Import | `local_import` (one per user), `imported_record` |

Integrity is enforced in the database, not only in code:
- CHECK constraints: coins and XP between 0 and 10^8, level ≥ 1, upgrade levels 0–10,
  positive purchase costs, non-negative ledger balances, non-negative board counters.
- Triggers make `match` rows immutable, and `match_participant` rows immutable except
  for detaching `userId` when an account is deleted.
- Unique keys make rewards idempotent: a run is claimed with a conditional
  `UPDATE … WHERE status='issued'`, purchases are unique per idempotency key and per
  `(user, upgrade, toLevel)`, and ledger entries are unique per source key.

Migrations are committed SQL in `prisma/migrations/<timestamp>_<name>/migration.sql`.
Generate a new one with
`npx prisma migrate diff --from-schema <old> --to-schema prisma/schema.prisma --script`,
add any hand-written constraints or triggers to the same file, and apply it with
`npm run db:migrate`. Tests and the e2e server apply the same files to throwaway
databases (`applyMigrations`).

Development and tests use **embedded PostgreSQL** (`embedded-postgres`, real PostgreSQL
binaries from npm, listening on 127.0.0.1 only). `npm run db:start` keeps a persistent
cluster in `.pgdata`. The Vitest global setup starts a throwaway cluster and gives each
test file a fresh database (`TEST_DATABASE_URL` points tests at an existing server
instead).

### Authentication
better-auth, mounted at `/api/auth/*`:
- scrypt password hashes and HTTP-only session cookies;
- origin checks, plus rate limits stored in the database and keyed on a server-set
  client-IP header (a client-supplied value is overwritten);
- email verification and reset through `Mailer` (SMTP in production, an in-memory
  outbox in development);
- account creation provisions the profile, the starter unlock, level abilities, a
  default loadout and a casual rating in one go.

Our routes add a CSRF guard (an allowed Origin plus a JSON body) and `requireUser`.
Colyseus' own matchmaking endpoints used to reflect any Origin with credentials. The
server replaces those CORS headers with the same allow-list.

WebSocket rooms do not read cookies. The client exchanges its session for a **game
ticket** (`POST /api/game/ticket`): 256 random bits, single use, 60 s, kept in server
memory. It passes the ticket in the join options, and `onAuth` redeems it. A single
server process is therefore assumed; multiple instances would need a shared ticket
store.

### Server-authoritative solo progression
```
client                      server
POST /api/solo/runs  ─────▶ check unlock · rate limit (20/min) · pick seed · snapshot upgrades → solo_run(issued)
  …play locally (same seed & upgrades)…
POST /runs/:id/finish ────▶ decode input log (≤ MAX_SOLO_TICKS) · replay with the shared Simulation
  {inputs}                    must finish (won/lost) · transaction: claim run (issued→finished) ·
                              applyRunResult (shared rules) on the DB snapshot · board progress ·
                              ledger credit (key run:<id>) · unlocks · leaderboards · store evidence
                     ◀───── rewards from the replay; a repeated finish returns the stored result
```
The client prefetches run tickets so starting a board stays instant. A run that never
reaches the server simply earns nothing. Signed-in purchases (`Idempotency-Key`, expected
level) and loadout changes go to the API. The client shows the server's numbers and never
applies them locally first.

### Persistent match results
`PrismaMatchResultRepository.save` writes the match and both participants in one
transaction when the room finalises. For a Quick Match that is replay-verified and not
cancelled, the same transaction:
- updates both casual Glicko-2 ratings;
- increments `casual_wins`;
- credits match rewards (`MATCH_REWARDS`, none for a player who forfeited (left or missed
  the reconnect deadline), at most 20 rewarded matches per player per day, key `match:<id>`).

A second save of the same match id returns `duplicate` and changes nothing. Private-room
and dev-room matches are stored but never rated or rewarded.

### Quick Match
`QueueRoom` (`quick_queue`):
- `onAuth` requires a game ticket, refuses a second queue entry per account, validates
  preferences and loads the verified rating, unlocks and equipment.
- Every second it calls the pure `findQuickPairs` (shared). For each pair it creates a
  `MatchRoom` with `QUICK_ROOM_SECRET` (assigned boards, `equipmentMode: casual`), reserves
  both seats (`reserveSeatFor` with the account data) and sends each player `matched`.
- If room creation fails, both stay queued (`retrying`). After 300 s the search stops
  (`timeout`).

`evaluateQuickPair` checks four criteria, which all must pass and are never blended:
- **skill**: a window of 150 + (deviation sum)/4, widened by 6 points/s after 15 s, up
  to 500;
- **boards**: the best compatible pair from each player's preferences and verified
  unlocks, with optional explained alternatives. Compatibility thresholds are never
  loosened, and players may race on different boards;
- **equipment**: the loadout power gap;
- **beginner protection**: players with fewer than 10 games never meet players with 30
  or more.

The quick room accepts only its two reserved accounts. Boards are fixed (`selectBoard`
→ `assigned_by_matchmaking`) and the lobby shows each player why they got their board.
Both must confirm READY within `QUICK_READY_SECONDS`. A timeout, decline or pre-start
leave closes the room with `closed {reason, seats}`. The player who did not fail is
requeued automatically by the client; the one who failed is not.

### Ratings and leaderboards
- `shared/src/competitive/glicko2.ts` is standard Glicko-2 (τ 0.5, start 1500/350/0.06)
  and reproduces Glickman's published example. Divisions use the conservative rating
  (rating − 2·deviation). The **casual** rating is hidden and only used for matchmaking.
  **Ranked is disabled** (`/api/ranked/status` lists the blockers), so no ranked rating
  or division is created or shown.
- Leaderboards (`solo_time`, `solo_score`, `mastery`, `casual_wins`) are written only by
  verified events: a replayed solo run or a server-run, replay-verified Quick Match. Each
  entry keeps its evidence id. Reads list active accounts with a verified email, 50 per
  page at most, plus the viewer's own rank. Imported records never appear.

### Network: adaptive input lead
The server measures, per player, how many inputs arrived after their tick was simulated
and the smallest arrival margin. It reports both in every `sync` (`lead`). The client's
`LeadController` (shared) raises its extra lead by 3 ticks on any late input. It lowers
the lead by 1 tick after 3 s of margins above 3 ticks, and caps the total at 36 ticks,
below the 48-tick ability delay. Local controls are still applied immediately; only how
far ahead the client simulates changes. `NET_DIAGNOSTICS=1` (refused in production) adds
per-player timing to `sync`, and e2e/dev builds show it with `?netdebug`. Results are in
`netsim.test.ts` and the CHANGELOG.

## Client (solo)
Unchanged from Phase 2: React screens, Phaser `SoloScene` with interpolation, run
recording and local replay verification, the campaign and its unlock checks, and the
e2e hooks compiled only into `--mode e2e` builds.

## Security notes
- The join code is not a secret credential, but guessing is rate-limited and blocked
  per IP. Rooms are private, and joining requires the code even with a room id.
- The `profileId` (browser local storage) only prevents accidental double seats. For
  **guests**, names are self-declared and board unlocks in private rooms come from
  untrusted client claims. Signed-in players (Phase 5) are identified by a game ticket,
  and their name, unlocks, loadout and upgrades come from the database. Quick Match and
  everything that is rated, rewarded or on a leaderboard require an account.
- Seeds are sent to their own player (needed for prediction). Knowing one's own seed
  reveals one's own drops and launch angles, not the opponent's.
- CORS for `/api` defaults to `*` outside production (set `ALLOWED_ORIGINS`). There is
  no TLS: put a TLS-terminating proxy in front for internet play
  (`TRUST_PROXY=1` for correct client IPs). Do not expose the server publicly without
  HTTPS/WSS.
- Ability security:
  - Every request is validated server-side.
  - Duplicate or old sequence numbers are refused.
  - Requests are limited to 6/s per player.
  - Cooldowns and energy live in the authoritative simulation, and energy is reserved
    for pending spends, so double activations cannot overspend.
  - Client-supplied `ext` fields are stripped, and `ext` sent as a message is unknown.
- Test-only settings (`CLOCK_SCALE`, `TEST_START_ENERGY`) and dev rooms are refused or
  disabled under `NODE_ENV=production`.
- Guests' upgrade claims are ignored (no upgrades). Loadout unlocks for guests in private
  rooms are still level claims, which is acceptable for unranked private play only.
- Accounts (Phase 5): see [ACCOUNTS.md](ACCOUNTS.md). Passwords and tokens are never
  logged; API errors return stable codes without internals; request bodies are size-limited
  (4 KB, 600 KB import, 2 MB run inputs).

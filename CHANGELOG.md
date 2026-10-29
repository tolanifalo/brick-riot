# Changelog

## 0.6.0 (in progress): power-ups, power-downs, a fun level 1, endless levels

Plan: (1) new power-ups and power-downs, (2) a short level 1 and onboarding,
(3) endless generated levels, (4) power-downs in races, (5) polish.

### Stage 1: power-ups and power-downs (done)
- New power-ups: **Safety Net** (one save) and **Nuke** (5×5 blast; steel survives).
- New power-downs: **Mini Paddle** (×0.7, waits for a safe moment, cancels with Wide),
  **Reversed** (0.75 s warning, then mirrored controls, implemented inside the
  simulation so replays and race prediction stay exact) and **Fast Ball** (×1.35).
  Catching one pays a +250 "brave catch" bonus.
- Boards opt in with `powerUpPool` and `powerDownChance`. Boards that don't opt in keep
  their exact drop stream: every existing replay, calibration and multiplayer
  measurement is unchanged (tested). Power-up bricks can never drop power-downs.
- Power-up bricks show their letter (or "?"). Power-downs have hazard-striped capsules
  and HUD chips. Added a net line, a Nuke ring and blast, Fast Ball glow and Reversed
  warnings.
- The test bot ignores power-down capsules and mirrors its aim while Reversed.
- Found by the new tests: Mini Paddle at ×0.65 was clamped to the 60-unit minimum width,
  so it is now ×0.7.

### Stage 2: level 1 (started)
- Level 1 is now **Kickoff** (`classic-01` v2): one-hit bricks, two explosives, visible
  Multiball, Laser and Wide bricks, 12% drops, no power-downs. Bot median clear is 51 s,
  against about 256 s for Opening Riot.
- Opening Riot v1 is kept, frozen, as the golden replay fixture (`levels/legacy.ts`).
  Same id, so saves and unlocks carry over. **Known:** server records and leaderboards
  are keyed by board id, not version, so Opening Riot times would sit next to Kickoff
  times. Only development test data exists; separating them is part of the stage 3
  leaderboard work.
- `onboarding.test.ts` guards level 1: at least three visible power-ups, no power-downs,
  bot clears under 90 s.

### Stage 3: endless levels (done)
- **Levels 13 to 9999 are generated** (`levels/endless.ts`) from the level number alone:
  the same level N for everyone, and the server rebuilds it to verify runs. Integer RNG
  only (no `Math.exp`/`log`), so every JS engine builds identical boards.
  - Mirror-symmetric pattern templates (pyramid, diamond, frame, zigzag, checker, …)
    and a palette per chapter.
  - Armour, explosives, steel (from level 18), sliding lanes (26), moving steel gates
    (40) and power-downs (16, rising to 30%) arrive gradually.
  - Sawtooth difficulty: rating 4 rising towards 9, HARD every 10th level, a BOSS every
    50th, breathers after them.
  - 1–3 visible power-up bricks per level; the drop pool grows (Heavy from 15, Magnet
    18, Nuke 22).
  - Names are unique within a chapter.
- **Level catalog** (`levels/catalog.ts`): `getLevel`, `levelNumber`, `nextLevel`,
  chapters (12 hand-made, then 20 per chapter), `unlockCandidates`. Clearing level N
  unlocks N+1 on the client and the server.
- **Level select by chapter**: ◀ CHAPTER N ▶, HARD/BOSS tags, a power-down notice,
  highest level and total stars. You can look one chapter past your progress.
- **Leaderboards**: new TOP LEVEL and STARS boards (migration
  `20261029000000_endless_leaderboards`). Per-level boards accept any level through a
  level-number picker.
  - Records are now kept **per board version** (`recordKey`): version 1 keeps the plain
    id, so old records stay valid, and Opening Riot times no longer appear on Kickoff.
    This fixes the stage 2 known issue.
- Verified: every level 13–3000 passes board validation. The bot beat all 30 calibration
  levels (13–300, 5 seeds each) and a test sample up to level 9999. A frozen fingerprint
  test forces a generator version bump on any change.
- Star targets come from a fitted estimate (18 s + 1 s per hit point + 8 s per steel
  cell + 10 s per lane). Bot clear times vary 2–3× by layout, so stars on generated
  levels are approximate. Refit with `npm run calibrate:endless`.
- Known: personal records (`solo_board_progress`) are still keyed by board id only, so a
  player's old Opening Riot best score can sit on their Kickoff card. This affects
  development data only.

## 0.5.0 (2026-10-29): Phase 5 accounts, server progression, Quick Match

*These entries were written at the end of the phase. The work was interrupted once by an
authentication timeout and resumed from the existing files. No commits exist for the
milestones: Git was not installed until the end of the phase (the winget installs failed,
and a portable MinGit was used afterwards).*

### Milestone A: database
- PostgreSQL via Prisma 7 (`prisma-client` generator, `@prisma/adapter-pg`), with one
  committed migration (`20261028000000_init`).
- Hand-written CHECK constraints (coins, XP, levels, upgrade levels, costs, ledger
  balances, board counters) and immutability triggers on `match` and `match_participant`.
- Development and tests use `embedded-postgres` from npm. A local PostgreSQL install was
  first chosen by mistake, then reverted on request: there is no system install.
  `npm run db:start`, `db:migrate`, `db:seed` (the preseason only, no fake players).

### Milestone B: accounts (better-auth)
- Register, sign in/out, email verification, password reset (revokes sessions), session
  list and revocation, account deletion, suspension.
- Rate limits are stored in the database and keyed on a server-set IP header, so client
  values are overwritten.
- CSRF guard (allowed Origin plus a JSON body). SMTP mailer for production and a dev
  outbox (`/api/dev/outbox`, refused in production).
- **Security fix:** Colyseus' matchmaking endpoints reflected any Origin with
  credentials. They now use the same allow-list as the API.
- Production refuses to start with the dev secret, the dev outbox, test settings, `*`
  origins, non-SMTP mail or a non-https `PUBLIC_URL`.

### Milestone C: server-authoritative progression
- Solo runs are issued by the server (seed and upgrade snapshot), finished with the input
  log only, replayed on the server and rewarded once, through an idempotent integer
  ledger.
- Workshop purchases on the server use idempotency keys and an expected level.
  Concurrent purchases succeed once and never overdraw.
- Abilities are granted by server level, and loadouts must be owned.
- One-time guest-save import (ACCOUNTS.md): unlocks, records marked imported, settings
  and an owned loadout. It **never** imports coins, XP, upgrades, mastery or competitive
  data, and reports exactly what was left behind.
- Client: account mode with server-backed progress, run-ticket prefetch, and retries
  that reuse the same idempotency key. The guest save is left untouched.

### Milestone D: verified equipment and persistent matches
- Rooms identify accounts by single-use game tickets. Name, unlocks, loadout and upgrades
  come from the database and are locked at the countdown.
- **Guests' claimed upgrades are now ignored** (no upgrades). One Phase 4 test that relied
  on guest claims was updated to assert this.
- Match results and participants are persisted in one transaction and are immutable.
  Match history uses cursor pagination; match details are participant-only.

### Milestone E: Quick Match (casual)
- `QueueRoom` with the pure `findQuickPairs`: separate skill, board, equipment and
  beginner criteria; different boards allowed, with alternatives labelled; no bots; a
  5-minute timeout.
- Reserved match rooms: boards are fixed, both players confirm READY within 20 s, and the
  blameless player is requeued automatically.
- Casual Glicko-2 updates and match rewards (daily cap 20; none for forfeits).
- Fix found by the e2e test: the client attached its match-room handlers only after
  leaving the queue, so the first lobby message was dropped and both players stayed on
  "Joining the match…". It now attaches immediately.
- Known: with loadouts only, every valid loadout is within the even-equipment gap, so the
  equipment criterion always passes today.

### Milestone F: ratings and leaderboards
- Glicko-2 reproduces Glickman's published example. Divisions use the conservative
  rating. **Public ranked is disabled** (`/api/ranked/status` lists the blockers), and no
  ranked ratings or divisions are shown.
- Leaderboards (solo time/score per board, mastery, casual wins) are written only by
  verified events. Reads are paginated (max 50), list verified emails only and include
  the viewer's rank.

### Milestone G: network
- The server reports late inputs and the minimum arrival margin in each `sync`. The
  client's `LeadController` raises the lead fast and lowers it slowly, capped at 36
  ticks. Optional diagnostics (`NET_DIAGNOSTICS`, `?netdebug` overlay in dev/e2e builds).
- Simulated results (`netsim.test.ts`):

  | Scenario | Fixed lead | Adaptive lead |
  | -------- | ---------- | ------------- |
  | Jitter + loss spikes: late inputs | 22.4% | 2.2% |
  | Frame stalls: late inputs | 21.5% | 0.4% |
  | Clean link | same late rate | about +17 ms more lead |

  These are simulations, not real-network measurements.

### Milestone H: UI, tests and docs
- Account, profile (overview, equipment, history, account), Quick Match, Quick lobby and
  leaderboard screens in the arcade style. The ranked tab is disabled and says why.
- Tests: 444 unit/integration tests (shared 281, server 126 including real-PostgreSQL
  suites, client 37) and 21 browser tests, all passing. A stale menu e2e assertion
  (Leaderboards "Unavailable") was updated.
- Server scripts now load `packages/server/.env` (`--env-file-if-exists`), and the server
  prints whether accounts are on. Node 22.9+ is required.
- Docs: README, ACCOUNTS (new), ARCHITECTURE, GAME_DESIGN, BALANCE_CONFIG, TESTING,
  ROADMAP, CLAUDE.md.
- Not done: real-device testing. Known noise: Vitest warns that "something prevents 2 Vite
  servers from exiting" after the server suite (open handles; the run completes).

## 0.4.0 (2026-10-25): Phase 4 abilities, loadouts, upgrades

*Note: these milestone entries were written at the end of the phase, not after each
milestone as requested.*

### Milestone A: stabilisation and baseline
- Re-verified the Phase 3 baseline before changes: tests, lint, typecheck and build pass.
- Git is still not installed, so **no commits exist**. The README has the Windows install
  and first-commit commands.
- `npm audit`: 0 vulnerabilities.
- Install scripts reviewed:
  - esbuild's postinstall only verifies its prebuilt binary.
  - msgpackr-extract's install would only compile if no prebuilt binary matched, and
    msgpackr falls back to JavaScript.
  - Nothing needs enabling. Documented in the README.

### Milestone B: ability engine (shared)
- `abilities/definitions.ts`: EMP Pulse, Shrink Ray, Frost Brick, Shield, Cleanse,
  Precision Aim, Energy Accelerator and Quick Relaunch, plus `ABILITY_RULES`.
- New `SimState` fields: energy in tenths, cooldowns, shield, debuff (pending/active with
  safe deferral), immunity and serve-ready tick.
- `TickInput.ext` carries server commands (`spend`, `shield`, `block`, `debuff`,
  `cleanse`), applied by `Simulation.applyExternal`.
- Energy is earned from damage, destruction and combo milestones only.
- Frost Brick: a non-required `frost` brick with deterministic, trap-free placement.
- `AbilityArbiter` validates every request against both simulations and schedules
  commands 48 ticks ahead.
- Golden replays unchanged. 27 ability tests.

### Milestone C: sabotage over the network (server)
- `MatchEngine.queueAbility` (shape, seq, 6/s) and `resolveAbilities` (deterministic
  order). Client-supplied `ext` is stripped.
- `MatchRoom` messages:
  - `ability` → `abilityResult` to the requester and `abilityEvent` to both players;
  - `ext {upcoming}` for client prediction;
  - `sync` gains energy, debuff, shield and immunity;
  - resync `state` includes upcoming commands.
- Replays verify with sabotage, and records store equipment.
- `TEST_START_ENERGY` test-only setting, refused in production.

### Milestone D: loadouts
- Three slots, an 80-power budget, level unlocks and a default beginner loadout.
- Validated on join and on `setLoadout`. Changeable only while not ready; locked at the
  countdown; visible to both players in the lobby.
- Preferred loadout saved locally (save v2).

### Milestone E: Workshop upgrades and equipment
- Five upgrades with diminishing returns: Paddle Control, Paddle Width, Ball Power (armour
  charge), Magnet Duration and Starting Energy.
- `purchaseUpgrade` is pure and atomic, with a stale-level guard. The store saves before
  applying. Save format v2 with migration 1→2.
- Mode policies:
  - solo: all upgrades;
  - casual (default): none;
  - host-chosen "Upgrades on": trimmed to 20 power;
  - ranked: none.
- Equipment Power Rating from definitions only. An uneven equipment race needs explicit
  acceptance, separately from board compatibility.
- Solo runs record their upgrades, so local verification replays with the same config.

### Milestone F: board compatibility
- `npm run compat`: 48-seed distributions under the multiplayer config, plus pairwise
  first-to-clear estimates. Several 16-seed medians were off by up to 24 s.
- **Stricter** compatibility: the estimated first-to-clear chance must be within 40–60%,
  and there is a new warning for boards that rarely beat the timer. No tolerance was
  raised.
- Versioned variants `classic-07-mp` (Fortress Sprint) and `classic-10-mp` (Gatekeeper
  Sprint) cut timer time-outs. Campaign boards are untouched.
- `getMatchBoard` registry used by the room, validation and client.
- Report: BOARD_COMPATIBILITY.md. All data is bot-estimated.

### Milestone G: presentation
- Ability bar: energy meter; offensive and defensive buttons with cost, key hint (1/2)
  and cooldown sweep. Buttons act on pointer-down without taking focus and don't
  interfere with dragging. Thumb-sized (≥ 48 px).
- Effect chips (incoming, jammed/shrunk/frosted countdown, shield, immune, passive),
  opponent effect chips and energy, and a feedback feed (sent, blocked, incoming,
  refusal reasons).
- VFX:
  - EMP: yellow paddle flicker and burst;
  - Shrink: burst;
  - Frost: brick texture, grow-in, crack and shatter;
  - Shield: ring and block shockwave;
  - Cleanse: burst;
  - also ability-used popups and the upgrade purchase pop.
- Opponent preview draws Frost Bricks.
- Lobby: loadout picker, EPR, equipment-mode toggle and warnings.
- Workshop screen: upgrades with confirmation, preferred loadout, reduce-effects
  setting. Reduce effects and `prefers-reduced-motion` remove shake and most particles.

### Milestone H: testing and docs
- New tests:
  - `equipment.test.ts`, `abilities.room.test.ts` (real sockets);
  - engine same-tick test with sabotage;
  - MatchNet command scheduling;
  - Workshop store tests;
  - variant and first-to-clear tests;
  - two e2e tests (abilities across two browsers, Workshop).
- Totals: 366 unit/integration (shared 262, server 72, client 32) and 18 browser tests.
- Measured: about 20% of inputs arrive late when two software-rendered browsers share
  the CPU, which causes resyncs (same as Phase 3). Documented in TESTING.md.
- New docs: BOARD_COMPATIBILITY.md, REAL_DEVICE_TEST_PLAN.md (not yet performed).
  Updated README, ARCHITECTURE, GAME_DESIGN, BALANCE_CONFIG, TESTING, ROADMAP and
  CLAUDE.md.

## 0.3.0 (2026-10-25): Phase 3 multiplayer foundation

### Baseline audit
- Verified the Phase 2 claims before any change: 215 unit tests and 13 browser tests
  pass, and strict typecheck, lint and build succeed.
- Git is not installed, so no commits were made. Installation and branch commands are
  in the README.
- **Found and fixed a Phase 2 regression**: a PowerShell edit had re-saved files as ANSI.
  - The campaign screen showed a stray "A-circumflex" (U+00C2) before every middle
    dot in mastery rewards and "LOCKED".
  - The README had corrupted arrows and separators, a backspace character, and a
    scripts-table update that had silently not applied.
  - New `encoding.test.ts` scans all sources and docs so this cannot ship again.

### Milestone A: server foundation
- `packages/server`: a Colyseus 0.18 server (core + WebSocket transport; the optional
  uWebSockets transport is avoided because it is fetched from GitHub).
- `MatchEngine`, pure and unit-tested:
  - Two independent simulations on one 120 Hz clock.
  - A tick-stamped input buffer with a documented late-input policy.
  - Validation (malformed, NaN, bounds, axis, launch, duplicate seq/tick, future ticks,
    launch rate) and the race rules.
  - Finality and applied-input replay verification.
- Shared protocol types and validator, `stateChecksum`, and `MATCH_CONFIG`.

### Milestone B: private rooms
- `MatchRoom`: private room with a CSPRNG 6-character code; `POST /api/rooms/resolve`
  with per-IP rate limiting and blocking; the code is re-checked in `onAuth`; one seat
  per browser profile.
- Lobby: host/guest seats, board selection (eligibility; claimed unlocks or a dev
  room), ready/unready, unranked acceptance for uneven boards, server-timed countdown
  with controls locked.
- Client: multiplayer menu (name, create, join, rejoin, dev-room toggle) and the lobby
  screen (code + copy, slots, board grid with expected times, compatibility panel,
  ready).

### Milestone C: multiplayer gameplay
- The server steps both boards on the shared clock and streams 20 Hz `sync` (progress,
  time left, own-state checksum), 10 Hz opponent `preview`, and `state` on request.
- Client `MatchScene` (a `SoloScene` subclass): predicts its own board ahead of the
  server, sends consumed inputs tick-stamped, and resyncs on any checksum mismatch.
  Rendering is identical to solo.
- Match screen:
  - Opponent strip (name, board, server clear %, balls, offline countdown, mini
    preview), timer, own HUD with ping.
  - Countdown, launch/out-of-balls banners, connection overlay, leave confirmation.
  - Result panel (identical on both clients, "SERVER VERIFIED").

### Milestone D: resilience
- Reconnection: the seat is held for `RECONNECT_SECONDS` and the match continues. Rejoin
  works with a single-use token, including after a page reload ("REJOIN MATCH").
- Forfeit on a missed deadline or a deliberate leave; no contest if both are absent;
  a cancelled countdown is recorded.
- The result is finalised once and saved to `MatchResultRepository` with seeds, applied
  inputs and an event log. Rematch request/accept/decline gives a new match id, and
  previous results stay immutable.
- Unknown and forged messages are refused; pause and abilities are refused in
  multiplayer.

### Milestone E: competitive foundation
- `MULTIPLAYER_BOARD_PROFILES`: six eligible boards, from 16-seed bot statistics
  labelled `bot-estimate`.
- `evaluateCompatibility`: provisional 15% expected-time limit and 2-point difficulty
  limit, with warnings. Ranked eligibility requires human calibration (none yet).
- Ranked interfaces: rating with deviation, BDR, equipment power, queue entry,
  eligibility, result verification; `evaluatePairing` checks each criterion separately.
- `BalanceTelemetry` hook (in memory).

### Milestone F: polish and QA
- Portrait-first match layout; desktop opponent panel; connection indicator; mechanic
  names in player terms.
- Fixed: the client resync throttle suppressed a divergence detected in the first
  600 ms after page load.
- Tests:
  - 59 server tests over real WebSockets.
  - 18 new shared tests and 6 new client tests.
  - 3 two-browser Playwright tests (desktop + phone contexts against the real server).
  - All earlier tests rerun and passing; the menu test was updated now that
    multiplayer is enabled.

## 0.2.0 (2026-10-24): Phase 2 solo game

### Milestone F: UI polish and comprehensive tests
- Level intro animation, screen transitions, star-award animation, itemised XP/coin
  rewards, level-up and unlock callouts, "BEST" record tags.
- Power-up feedback: label popup, burst, paddle flash. Active-effect chips with draining
  timers. Bomb ring and Heavy glow on the ball. Laser cannons on the paddle. Magnet
  paddle glow.
- Result panel compacted so every action fits a 720 px-tall desktop stage (e2e-checked).
- Campaign: on narrow screens, selecting a card scrolls its detail panel into view.
- Hit flashes now expire in the render loop instead of timers, so a pending flash can
  no longer un-whiten a brick mid-destroy.
- New tests: server verification of full Phase 2 runs, the client record path
  (verified once, duplicate ignored, forged summary rejected), and e2e for campaign
  navigation, a real level clear with reload persistence, corrupted-save recovery and
  late-board rendering.

### Milestone E: XP, coins and mastery
- `applyRunResult` (shared, pure, idempotent per run id).
- Rewards: completion scaled by difficulty, stars, balls left, combo, first clear ×2,
  replay decay (×0.6ⁿ, floor 0.1), star improvement bonus, one-time mastery rewards.
- Five mastery objectives per board; progress and rewards shown on the campaign screen.
- Wins earn rewards only when the input log replays to the same result.
- Economy config in `config/economy.ts`, documented in BALANCE_CONFIG.md.

### Milestone D: power-ups and special bricks (client side)
- Rendering for capsules, laser bolts, moving bricks, power-up bricks and moving steel.
- The autoplayer now catches capsules when safe. Calibration was rerun: Reactor was
  armoured after showing a 39 s median.

### Milestone C: level selection and progression
- Campaign screen: 12 cards with lock state, stars, best score/time, "current" marker,
  next-unlock text, and a detail panel with star targets, records and mastery.
- `startBoard` is the only entry point and refuses locked boards. There is no URL
  routing, and `SoloScreen` re-checks.
- The scene records seed, run id and every consumed input. `recordRun` verifies by
  replay, applies, saves and returns the outcome. "Next level" flow.
- Player badge (level, XP bar, coins) on the menu and campaign. Notices for recovered or
  unsaved progress.

### Milestone A: stabilisation and persistence
- Golden replay fingerprints for Opening Riot (`golden.test.ts`), recorded with the
  Phase 1 engine. Phase 2 engine changes must keep them identical.
- `createAutoplayer` scripted player (`shared/src/tools`) for playtesting and e2e.
- E2E hooks (`window.__BRICK_RIOT_E2E__`), compiled only into `vite build --mode e2e`
  (served from `dist-e2e`). Production bundles do not contain them.
- E2E rewritten: the mobile drag test now asserts the paddle's world position and edge
  clamping. Game over is deterministic (the 'lose' autopilot), and the keyboard paddle
  test asserts position. A new high-DPI (3×) project checks the 960×1600 canvas fits in
  portrait and landscape.
- Fixed: in landscape the narrow field column squeezed the HUD so the timer
  overlapped the ball indicators. The HUD now keeps a minimum readable width.
- Versioned local save system (shared `progress/save.ts`): envelope format, migration
  registry, field-level sanitising and repair, unsupported-version detection.
- `LocalStorageProgressRepository` behind a `ProgressRepository` interface: last-good
  backup, quarantine of damaged saves, in-memory fallback when storage is blocked.
- XP level curve (`config/economy.ts`) and unlock rules derived from completions.
- README: Git installation and repository setup instructions.

### Milestone B: twelve-board CLASSIC campaign (with D's engine work pulled forward)
- Boards 8 to 12 need moving bricks and several boards use power-up bricks, so the
  engine support for both (milestone D's simulation work) was built first.
- Engine:
  - Power-up drops from a separate seeded stream, so drops never perturb launch angles.
  - Six power-ups, moving bricks (a triangle-wave function of the tick) and moving steel
    obstacles.
  - Explosions are now geometric (bricks within N cells), equivalent to the old 3×3
    rule on static grids.
  - Golden replays are unchanged.
- Fixed: two balls draining on the same tick emitted only one `ballDrained` event.
- Schema:
  - `powerUp` and `move` legend fields, `stars` thresholds, `dropChance`.
  - Six mastery objective kinds, and `validateBoard(..., { campaign: true })`, which
    requires stars and exactly five objectives.
  - Moving-brick paths must stay inside the grid and cross only empty cells.
- 11 new boards: Twin Pillars, Chevron, Corridor, Lattice, Fuse Line, Fortress,
  Slipstream, Staircase, Gatekeeper, Reactor, Riot Finale. Opening Riot is unchanged.
- Autoplayer fixed: it stalled when aiming at bricks shielded by steel, because the
  sim's progress counter resets on every paddle touch. It now tracks cleared bricks
  itself.
- Scripted playtests: every board is cleared on 5 seeds in the test suite (8 seeds in
  calibration).
- Par and star times are derived from the measured clear-time distribution
  (`npm run calibrate -w @brick-riot/shared`). Staircase lost its top row after
  calibration showed a 377 s median grind.

## 0.1.0 (2026-10-24): Phase 1 foundation

### Added
- npm-workspaces monorepo (`shared`, `server`, `client`) with strict TypeScript,
  ESLint, Vitest and Playwright.
- Deterministic 120 Hz simulation: sub-stepped collisions, angle-based paddle rebounds,
  min-angle and stuck-ball safeguards, seeded launch spread.
- Brick types: standard, reinforced, explosive (chaining 3×3), indestructible.
- Data-driven `BoardDefinition` schema with validator; board `classic-01` "Opening Riot".
- Scoring with combo multiplier and clear bonus; elapsed-time tracking.
- `replayRun` and the server's `verifySoloRun` for authoritative result checks.
- Phaser renderer with interpolation, procedural textures, pooled particles, trails,
  popups, shockwaves and adaptive low-effects mode.
- React screens: loading, main menu (unbuilt modes clearly marked unavailable), solo
  game with HUD, pause, win and loss overlays.
- Touch drag/tap, mouse and keyboard controls; auto-pause on focus loss.

### Known limitations
- Progress and best scores are not persisted yet (Phase 2).
- No audio (Phase 7).
- Only the CLASSIC visual theme exists; other collections fall back to it.

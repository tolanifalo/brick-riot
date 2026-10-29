# Development Roadmap

## ✅ Phase 1: Foundation
Monorepo, deterministic fixed-step simulation, physics, lives, win/loss, pause/restart,
combo and score, one polished board, responsive UI, touch/mouse/keyboard input, replay
verification helper, tests.

## ✅ Phase 2: Solo game
- Stabilisation: golden replays, deterministic e2e, asserted mobile drag, high-DPI and
  landscape checks.
- Versioned local saves with migrations, repair, backup and quarantine.
- 12-board CLASSIC campaign, calibrated by scripted playtests.
- Campaign/level-select screen, derived unlocks, stars, records, history.
- Six power-ups, power-up bricks, moving bricks and moving steel.
- XP, levels, coins, anti-farming, five mastery objectives per board.
- Results UI: star animation, reward breakdown, level-up/unlock callouts, effect chips.

Deferred from the original Phase 2 list:
- **Settings screen** (effects quality, reduced motion). The game already honours
  `prefers-reduced-motion` and auto-reduces effects, so this moves to Phase 7.
- **Coin spending**: delivered in Phase 4 (Workshop).

## ✅ Phase 3: Multiplayer foundation
- Colyseus server with a pure `MatchEngine` (two simulations, one clock, race rules,
  replay verification).
- Private rooms with secure codes and per-IP guess limits; lobby, board choice, ready
  checks, server-timed countdown.
- Different boards per player; Board Compatibility Service; six multiplayer-eligible
  boards (bot-estimated).
- Client prediction with checksum-verified resync; opponent strip and live preview;
  results and rematches.
- Reconnection with a held seat, forfeits, a both-disconnected policy, finality,
  persistence and telemetry interfaces.
- Ranked interfaces (rating, BDR, equipment power, queue, pairing criteria) with no
  live rating changes.

Not done in Phase 3 (deliberately or out of reach):
- **Human calibration of multiplayer boards.** All compatibility data is bot-estimated,
  so every match is labelled "estimated" and nothing is ranked-eligible.
- **Real-network testing on phones** has not been automated (manual procedure in
  README).
- **Public matchmaking and ranked play** (Phase 6). **Accounts and verified
  entitlements** (Phase 5).
- **PostgreSQL persistence**: results are in memory and lost on server restart
  (Phase 5).

## ✅ Phase 4: Abilities, loadouts, upgrades (implemented; real phones untested)
- Abilities run inside the deterministic simulation:
  - EMP Pulse, Shrink Ray, Frost Brick, Shield, Cleanse, plus three passives.
  - Energy is earned only from brick play.
  - A server `AbilityArbiter` schedules tick-stamped commands into the applied input
    logs, so replays still verify.
- Sabotage rules: opening lockout, one debuff at a time plus immunity, no attacks on a
  serving target, safe-moment Shrink, trap-free Frost placement, free refusals,
  deterministic ordering of simultaneous requests.
- Exact client prediction of effects: commands are sent ahead, with resync as the
  fallback.
- Three-slot loadouts with an 80-power budget and level unlocks. They are chosen in the
  lobby, visible to both players, locked at the countdown and validated by the server.
- Workshop: five upgrades with diminishing returns, atomic purchases and save v2.
  Upgrades apply in solo, in multiplayer only in capped upgrade rooms, and never in
  ranked.
- Equipment Power Rating from definitions (not XP), with a separate equipment-acceptance
  check.
- Board compatibility:
  - 48-seed distribution analysis and a stricter first-to-clear rule.
  - Two versioned multiplayer variants (Fortress Sprint, Gatekeeper Sprint).
  - Full report in BOARD_COMPATIBILITY.md.
- UI: ability bar (touch and keys 1/2), energy meter, cooldowns, effect chips, feedback
  feed, ability VFX, Workshop screen, reduce-effects setting.

Not done in Phase 4:
- **Real-phone testing**: the plan exists (REAL_DEVICE_TEST_PLAN.md) but has not been
  run.
- **Human calibration** of boards and ability values. Everything is still bot-estimated
  or designer-set.
- **Verified equipment ownership.** Upgrades and unlocks come from local saves, so
  ranked play cannot use them yet (Phase 5).
- **Adaptive input lead.** On a starved CPU many inputs arrive late and cause resyncs.
  The lead could grow based on server late-input feedback. (Done in Phase 5.)

## ✅ Phase 5: Accounts, server progression, Quick Match (implemented; real phones untested)
- PostgreSQL + Prisma 7 with committed migrations, DB-level CHECK constraints and
  immutability triggers. Embedded PostgreSQL from npm for development and tests.
- better-auth accounts: register, sign in/out, email verification, password reset,
  session list and revocation, account deletion, rate limits, CSRF/origin checks. Guests
  keep full solo play and private rooms.
- One-time guest-save import: unlocks, records marked imported, settings, an owned
  loadout. It never imports coins, XP, upgrades, mastery or competitive data.
- Server-authoritative progression:
  - solo runs are issued by the server and paid only after a server replay;
  - integer coins and XP go through an idempotent ledger;
  - Workshop purchases are server-side with idempotency keys;
  - abilities are granted by server level, and loadouts are checked for ownership.
- Verified equipment in matches: account equipment is loaded from the database and
  locked at the countdown. Guests play without upgrades.
- Persistent, immutable match results with participants, history (cursor pagination)
  and match detail.
- Public **casual Quick Match**: a real-player queue, separate skill/board/equipment/
  beginner criteria, different boards allowed with explanations, ready confirmation,
  timeouts and requeue, no bots. Casual Glicko-2 updates and match rewards (daily cap).
- Glicko-2 implemented and tested (Glickman example). **Public ranked stays disabled.**
- Verified leaderboards (solo time/score per board, mastery, casual wins), paginated,
  verified emails only.
- Adaptive input lead driven by server feedback, plus network diagnostics.

Not done in Phase 5:
- **Public ranked play** is disabled by design. Its blockers are human board
  calibration, real-device testing and an anti-cheat review.
- **Real-phone testing**: still not run.
- **Git**: not installed on the development machine (the winget install failed), so
  there are no commits.
- The Quick Match **equipment criterion** compares loadout power only, and every valid
  loadout is within the even gap, so in practice it always passes. It becomes meaningful
  if upgrade rooms or a wider power range are added to public play.
- Imported unlocks grant casual board access without proof (ACCOUNTS.md). Ranked must use
  verified clears only.
- Game tickets live in server memory: a single server instance is assumed.
- Display names are not unique and not moderated. Deleted accounts' names remain in
  opponents' match history.

## 0.6 (in progress): fun first, then forever
1. ✅ Power-ups (Safety Net, Nuke) and power-downs (Mini Paddle, Reversed, Fast Ball).
2. ✅ A short, fun level 1 (Kickoff).
3. ✅ Endless generated levels, chapters, TOP LEVEL and STARS leaderboards.
4. Power-downs in races: race boards opt in, re-measure compatibility.
5. Polish: capsule art, sounds, a real level map, docs, the full multiplayer e2e run.

## Phase 6: Competitive systems
- Human BDR calibration from the stored match and run telemetry
  (`/api/telemetry/boards`).
- **Ranked queue** on verified clears: placements, visible divisions, seasons.
- Anti-cheat review (input plausibility on stored evidence, account-age and
  verified-email gates).
- Moderation of display names, reports and abuse handling.
- A shared ticket/queue store (Redis) for more than one server instance.
- Load testing.

## Phase 7: Polish
Audio, CIRCUIT/TIDAL/VOID themes and the board collection screen, settings,
accessibility, mobile performance work, Capacitor packaging, deployment.

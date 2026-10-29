# Testing

Run everything with `npm run check` (lint + typecheck + unit/integration tests + build)
and `npm run e2e` (browser tests, including two-browser multiplayer). Board calibration
is a separate report: `npm run calibrate -w @brick-riot/shared`, and multiplayer board
fairness is `npm run compat -w @brick-riot/shared` (BOARD_COMPATIBILITY.md).

Current totals (0.6 in progress): **474 unit/integration tests** (shared 309, server 128,
client 37), all passing in `npm run check`. Of the **22 browser tests**, the 17
desktop/phone tests pass; the 5 multiplayer tests were last run (passing) before 0.6.

0.6 additions: `powerdowns.test.ts` (new power-ups and power-downs, opt-in drops,
validation, replay determinism), `onboarding.test.ts` (level 1 promises),
`endless.test.ts` (generator fingerprint, levels 13–3000 valid, unique names,
sawtooth, power-down ramp, bot beats a sample up to 9999, catalog, unlock chain), server
endless and per-version record tests in `progression.test.ts`, and the e2e endless
chapter test.

Database tests need no setup: `test/support/globalSetup.ts` starts a throwaway embedded
PostgreSQL and each test file gets a fresh, migrated database. Set `TEST_DATABASE_URL` to
use an existing server instead.

### Phase 5 test files
| File | Covers |
| ---- | ------ |
| shared `glicko2.test.ts` | Glickman's published example reproduced; divisions on the conservative rating; solo input-log codec round trip and limits |
| shared `quickmatch.test.ts` | Quick Match criteria evaluated separately (skill window and widening, boards, equipment, beginner protection), different boards, labelled alternatives, deterministic pairing |
| server `db.schema.test.ts` | Every migration applies; negative balances refused by the database; a constraint violation rolls back the whole transaction; duplicate ledger idempotency key refused; finalised matches immutable |
| server `auth.test.ts` | Register (player provisioned, HttpOnly cookie, only a hash stored); login/logout; **same answer for wrong password and unknown email**; short passwords; email verification and forged tokens; **password reset revokes old sessions**; expired sessions; session list and revocation; suspended accounts; deletion of private data; **CSRF** (foreign Origin, non-JSON); credentialed CORS and preflights only for allowed origins (Colyseus defaults overridden); session required for private data; public profiles without email; **per-IP login rate limit** |
| server `progression.test.ts` | Server replay then rewards exactly once; **concurrent duplicate finishes rewarded once**; unfinished, malformed, foreign and tampered logs earn nothing; verified clears feed leaderboards; atomic purchases with ledger entries; idempotency-key retries; **concurrent purchases succeed once and never overdraw**; refusals; un-owned abilities refused; level-up grants abilities; **guest import never imports coins/XP/upgrades**, once only; corrupt saves change nothing |
| server `matches.db.test.ts` | Verified account name, unlocks and equipment used, claims ignored, forged tickets refused; match persisted to PostgreSQL, history survives a server restart, details participant-only |
| server `quickmatch.db.test.ts` | Account required, one queue entry each; **two real players paired on different compatible boards**, match persisted and rewarded; ready timeout calls it off and names who failed; incompatible preferences never paired, allowed alternatives explained; cancelled searches leave the queue |
| server `leaderboards.db.test.ts` | Sorting, pagination, counts, unverified emails hidden; one row per player/category; category/board validation and page-size cap; ranked reports itself disabled; telemetry has no player data |
| server `netsim.test.ts` | `LeadController` behaviour, and simulated jitter, loss spikes and frame stalls with fixed vs adaptive lead (numbers in CHANGELOG 0.5.0) |
| client `account.test.ts` | Server profile replaces local progress when signed in and the guest save is untouched; purchase retries reuse the idempotency key; server refusals change nothing; a signed-in run without a server ticket is never rewarded |

## Unit / integration (Vitest), `npm test`

### shared
| File | Covers |
| ---- | ------ |
| `golden.test.ts` | **Phase 1 replay compatibility**: frozen Opening Riot fingerprints |
| `collisions`, `bricks`, `lifecycle`, `scoring`, `determinism`, `levels` | Core physics, bricks, serve/loss/win, pause, safeguards, scoring, schema validation |
| `campaign.test.ts` | 12 boards valid, unlock chain, rising rating; **each cleared by the autoplayer on 5 seeds** |
| `powerups.test.ts`, `moving.test.ts` | All power-ups, expiry, multiball life rules, moving-brick collisions, replay with power-ups |
| `save`, `progression`, `rewards` | Saves, migrations, corruption repair, unlocks, stars, rewards, duplicate-run rejection |
| `multiplayer.test.ts` | ≥6 eligible boards with data; exclusions; **versioned multiplayer variants** (valid, separate from the campaign, unlock with their base, deterministic; campaign boards untouched); the exact list of compatible pairs; **first-to-clear rule** catches a pair the median ratio passes; estimates agree with the 48-seed measurements; unlock checks vs dev rooms; **compatibility** (same board, within 15%, too different, no data, estimated ≠ ranked, warnings); wire-format round trip; name sanitising; **state checksums equal across JSON transport; a restored simulation continues bit-identically**; ranked pairing checks each criterion separately; rating gate |
| `abilities.test.ts` | **Energy**: earned only from brick damage, destruction and combo milestones, capped; Accelerator ×1.2; solo config unchanged. **Arbiter**: not equipped / malformed / not enough energy; opening lockout (attacks only); rejections free, acceptance reserves energy (no double spend); cooldowns; no attacks on a serving target; no second attack on an affected target. **EMP** suspends power-ups only, then immunity. **Shrink**: −15% for 3 s, waits for a safe moment, never below the minimum. **Frost**: spawns in open space below the bricks, clear of balls, not required; expires after 5 s; shatters after 2 hits with no score, combo or energy; refused free with no space. **Shield** blocks one attack (attacker pays, shield consumed), even when raised in the same window. **Cleanse** removes the debuff and starts immunity; refused free when there is nothing to remove. Relaunch delay 1 s / 0.5 s; Precision Aim. **Determinism**: applied logs (with server commands) replay to the identical state |
| `equipment.test.ts` | Loadout validation (slots, unlocks, budget, dev rooms keep the budget); **upgrade purchases** (atomic, stale-level double-submit guard, max level, insufficient coins, never negative); diminishing returns; Ball Power; equipment modes (solo all, casual none, upgrade rooms trimmed to the cap, ranked none); **EPR** from definitions only, never XP; even/uneven comparison; **save v1→v2 migration** and repair of invalid upgrades/loadouts |
| `encoding.test.ts` | No mojibake or control characters in any source, test or doc file (guards the Phase 2 regression where UTF-8 text was re-saved as ANSI) |

### server
| File | Covers |
| ---- | ------ |
| `matchEngine.test.ts` | Independent simulations on different boards; one shared clock; **first clear wins**; **A out of balls, B continues and wins**; **both exhausted = draw**; **timer expiry = draw at exactly the duration tick**; **same-tick clear = draw**; one tick earlier wins (measured exactly); forfeit; abandonment; **finality** (nothing changes a decided match); malformed/NaN/out-of-bounds/axis/launch input rejection; **duplicate seq and tick**; future ticks; exact-tick application; late launch applied next tick; launch rate limit; **forged completion impossible through inputs**; replay verification passes, and detects tampering; determinism; performance (a 120 s two-player match well under 2 s CPU); **symmetric same-tick attacks keep a same-tick clear a draw and replays verify**; client-supplied `ext` ignored |
| `rooms.test.ts` | Real server, **real WebSocket clients**. Room creation and code format; join by code; invalid/malformed codes; join by id with a wrong code refused; **capacity**; one profile, one seat; host cancel expires the code; leaving before start and host reassignment; ineligible boards; unlocks in normal vs dev rooms; different boards and compatibility; **ready/unready**; acceptance required for uneven match-ups; board change resets readiness; **synchronised start** (same `goAt`, own seeds); inputs locked during countdown; streaming authoritative progress and preview; **forged `complete`/`result`/`score` messages refused**; **both clients receive the identical verified result**; **reconnect with token** (match continues, state intact); **token cannot be reused**; **missed deadline forfeits**; **expired token refused**; deliberate leave forfeits; **both gone = no contest**; countdown drop/cancel records `match_cancelled`; **finalised exactly once and persisted**; decline then accept rematch; **new match id, previous result unchanged**; pause refused |
| `abilities.room.test.ts` | Real sockets, `TEST_START_ENERGY=100`. Loadouts and EPRs shown in the lobby, defaults; **loadout validation** (locked outside dev rooms, slots, budget even in dev rooms; no change while ready; **locked at countdown**); **host-only equipment mode**; uneven equipment requires acceptance; **opening lockout**; EMP lands: `abilityResult`, `abilityEvent`, `ext` to both, debuff visible in `sync`; **forged/abusive messages**: not equipped, replayed seq, malformed, **cooldown bypass**, rate limit, client `ext` refused, injected `ext` on inputs ignored; **Shield blocks** (both told, shield consumed, no debuff); **simultaneous attacks**; **reconnect during an effect** (state + upcoming carry it); **finalisation with sabotage**: replay verified, equipment and `ext` in the stored logs, exactly one result; **variants raced** with id + version in `matchStart` |
| `abuse.test.ts` | Production limiter: **IP blocked after 10 wrong codes** (including valid codes afterwards, and direct joins); code alphabet, length, uniqueness; expiry; limiter unit |
| `verifySoloRun.test.ts` | Solo replay verification (Phase 1-2) |

### client
| File | Covers |
| ---- | ------ |
| `net.test.ts` | Clock offset from the lowest-RTT sample; countdown/lead; **input batching with increasing seq, launches flushed immediately**; checksum match vs mismatch → resync request; deferred checks; resync hand-over; **scheduled ability commands handed over on exactly their tick, once**; a late command triggers a resync, an identical already-applied one does not; replay after resync uses the authoritative schedule; ability request sequence numbers |
| `repository`, `progressStore`, `input` | Local saves, run recording/verification (**upgraded runs verify only with the upgrades they used**), **Workshop purchases** (atomic, double-submit buys one level, insufficient/max refused, failed save charges nothing), loadout saving (unlocks), input mapping |

## Browser (Playwright), `npm run e2e`

Builds `vite build --mode e2e` (`dist-e2e`, with `window.__BRICK_RIOT_E2E__` hooks;
production builds exclude them, which is checked) on :4174, and starts **the real game
server** on :2599 (`MATCH_SECONDS=90`, `COUNTDOWN_MS=2000`, `RECONNECT_SECONDS=8`,
`TEST_START_ENERGY=100` so ability tests need not grind energy; earning is unit-tested).
Since Phase 5 that server (`server/scripts/e2eServer.ts`) also starts a throwaway embedded
PostgreSQL, with the dev mail outbox and relaxed auth rate limits (test-only settings that
production refuses).

| Spec | Test | Projects |
| ---- | ---- | -------- |
| solo | menu (solo, multiplayer, workshop, Quick Match and leaderboards enabled; boards unavailable) | desktop, mobile |
| **accounts** | Register; **guest import shows 9,999 coins NOT imported** and the balance stays 0; verify through the emailed link (dev outbox); **server-verified solo clear** pays rewards; profile, records, equipment and the leaderboard come from the server; ranked tab says it is switched off | desktop |
| **accounts** | Password reset through the emailed link; token removed from the URL; old password refused, new one works | desktop |
| **accounts** | **Quick Match, two real accounts** (desktop + Pixel 7): honest "1 player searching" state with nobody else; paired, opponent and board reasons shown; both confirm; race; **SERVER VERIFIED** result; the match appears in both players' persistent history | multiplayer |
| solo | launch, pause, restart; keyboard paddle; deterministic game over; touch drag; high-DPI layout | desktop, mobile, hires |
| campaign | 12 levels and locks; real level 1 clear with reload persistence; corrupted save; late boards; phone layout | desktop, mobile |
| **multiplayer** | **Two real browser contexts (desktop + Pixel 7)**: A creates a room; B joins with the code typed in; **different boards** (Chevron vs Lattice) with the compatibility panel and explicit unranked acceptance; **synchronised countdown**; **A moves by keyboard, B by touch, each paddle independent**; B sees A's clear % from server state; A sees B "OUT OF BALLS" while continuing; **both show the identical result and reason, marked SERVER VERIFIED**; win/lose or draw consistent with the rules; prediction checksums compared more than 20 times per client; **rematch** with a changed board starts a fresh match | multiplayer |
| **multiplayer** | **Reload rejoins the running match** (seat held, opponent sees OFFLINE then online, rejoined client adopts the authoritative state), then **closing the browser forfeits after the grace period** (YOU WIN · Forfeit) | multiplayer |
| **multiplayer** | **Loadouts and abilities, two browsers**: loadouts and EPR visible to the opponent; budget enforced in the picker; equipment mode host-only; **loadout locks once ready**; opening-lockout refusal costs nothing; **B raises a Shield by tapping the phone button**; A's EMP (key 1) is **blocked**: both see feedback, shield consumed, A on cooldown; after the cooldown the next EMP **lands and B's prediction shows the debuff**, which then ends; checksum checks continue | multiplayer |
| desktop | **Workshop**: seeded coins, confirmed purchase, coins and level update, unaffordable next level disabled, reduce-effects setting; all persist across reload | desktop |
| multiplayer | Invalid code shows an error and does not join | multiplayer |

Notes:
- `workers: 1`: headless Chromium renders WebGL in software; games starve each other
  in parallel. Multiplayer runs in real time (the server clock cannot be sped up from
  the browser), so the first multiplayer test takes about 2.5 minutes.
- The main multiplayer test accepts either outcome the rules allow (A clears first →
  WIN/LOSE; A does not clear in time → time-out DRAW), and asserts that both clients
  agree and that the reason matches.

- Two software-rendered browsers starve one CPU: about 20% of inputs reach the server
  late in this environment, so prediction checksums mismatch and resync many times per
  match. This was measured to be the same with and without abilities (Phase 3 behaviour).
  The e2e tests therefore assert that checking continues, not zero mismatches. Exact-tick
  command delivery is covered by `net.test.ts`.

## Not covered by automation
- **Real devices**: none tested yet. Follow [REAL_DEVICE_TEST_PLAN.md](REAL_DEVICE_TEST_PLAN.md).
- Load testing with many concurrent rooms.
- Human judgement of board balance (the compatibility thresholds are provisional).

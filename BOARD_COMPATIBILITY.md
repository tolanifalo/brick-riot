# Board compatibility report (Phase 4)

**Status: BOT ESTIMATES ONLY.** Nothing in this report comes from human playtests. The
autoplayer never loses a ball and aims differently from people. These numbers support
unranked private races; ranked play stays blocked until human calibration replaces them
(`rankedRequiresHumanCalibration` is on, and every profile is `calibration: 'bot-estimate'`).

Reproduce with `npm run compat -w @brick-riot/shared` (about 15 s). It uses
`packages/shared/scripts/compatibility.test.ts`.

## Method

- 48 seeds per board (Phase 3 used 16), autoplayer v2.
- **Multiplayer config**: default loadout (EMP / Shield / Quick Relaunch), 1 s relaunch
  delay, the energy rules, and no upgrades.
- A second run per board uses **maximum capped upgrades** (the `casualUpgrades` room mode,
  power cap 20) to measure how much upgrades change each board.
- For each board: p10, quartiles, median, p90, mean, standard deviation, coefficient of
  variation (CV), IQR/median, and the share of runs that beat the 120 s timer.
- For each pair: **P(first)**, the chance that an independent run on board A clears before
  one on board B, counted over all 48 × 48 sample pairs. Unlike the median ratio, it
  reflects the whole distribution.

## Distributions (seconds; multiplayer config)

| Board | p10 | q1 | median | q3 | p90 | sd | CV | IQR/med | beats 120 s | capped upgrades median |
|---|---|---|---|---|---|---|---|---|---|---|
| classic-02 Twin Pillars | 51 | 71 | 81 | 100 | 113 | 24.8 | 0.30 | 0.36 | 94% | 80 (−1%) |
| classic-03 | 24 | 35 | 42 | 62 | 87 | 25.1 | 0.50 | 0.64 | 100% | 44 (+4%) |
| classic-05 | 32 | 43 | 54 | 84 | 104 | 26.0 | 0.43 | 0.76 | 100% | 58 (+8%) |
| classic-07 Fortress | 49 | 65 | 100 | 129 | 147 | 37.1 | 0.38 | 0.64 | 67% | 86 (−14%) |
| classic-08 Slipstream | 33 | 45 | 59 | 70 | 85 | 17.7 | 0.31 | 0.42 | 100% | 62 (+4%) |
| classic-10 Gatekeeper | 51 | 73 | 97 | 121 | 156 | 35.8 | 0.37 | 0.49 | 75% | 92 (−6%) |
| classic-11 (excluded) | 32 | 48 | 76 | 112 | 159 | 46.3 | 0.55 | 0.85 | 77% | 58 (−24%) |
| **classic-07-mp** Fortress Sprint v1 | 47 | 69 | 86 | 110 | 149 | 34.9 | 0.39 | 0.47 | 81% | 79 (−8%) |
| **classic-10-mp** Gatekeeper Sprint v1 | 41 | 54 | 82 | 109 | 127 | 32.7 | 0.41 | 0.68 | 90% | 73 (−10%) |

### Findings

1. **The 16-seed Phase 3 medians were noticeably off.** classic-10 went from 121 to 97 s,
   classic-02 from 93 to 81 s, and classic-05 from 62 to 54 s. A small sample was a bigger
   error source than the tolerance.
2. **Variance is high on every board** (CV 0.30–0.55). Even on the same board, luck
   decides a real share of bot races. The median ratio alone is too weak a fairness test.
3. **Upgrade sensitivity depends on the board.** Capped upgrades cut classic-11 by 24% and
   classic-07 by 14%, but barely change classic-02, 03, 05 or 08. Ball Power helps most on
   multi-hit armour. That is why upgrade rooms need explicit acceptance when equipment
   differs, and why upgrades are never used in ranked play.
4. **Timer pressure:** about a third of classic-07 runs and a quarter of classic-10 runs
   don't clear within 120 s.

## Pairwise first-to-clear estimates (selected)

| Pair | median ratio | P(first) | Verdict |
|---|---|---|---|
| classic-05 vs classic-08 | 1.09 | 0.49 | compatible |
| classic-07 vs classic-10 | 1.03 | 0.50 | compatible |
| classic-10 vs classic-07-mp | 1.13 | 0.46 | compatible (new) |
| classic-07-mp vs classic-10-mp | 1.05 | 0.44 | compatible (new) |
| classic-02 vs classic-10-mp | 1.01 | 0.48 | **not** compatible: difficulty gap 4 > 2 |
| classic-02 vs classic-07-mp | 1.06 | 0.55 | **not** compatible: difficulty gap 2.5 > 2 |
| classic-02 vs classic-07 | 1.23 | 0.62 | not compatible |
| classic-02 vs classic-10 | 1.20 | 0.62 | not compatible |
| classic-03 vs anything else | ≥ 1.29 | ≥ 0.64 | not compatible (only fair against itself) |

The designer-rating rule was **not** relaxed to admit classic-02 + classic-10-mp, even
though their times match. Gatekeeper's moving steel gates demand different skills, which
bot timing does not capture.

## Changes made

### 1. A stricter rule, not a looser tolerance

`evaluateCompatibility` keeps every Phase 3 rule:

- median ratio ≤ 1.15
- designer-rating gap ≤ 2
- variance and timer warnings

It **adds** a distribution rule: the estimated P(first) must be within 0.5 ± 0.10
(`maxFirstClearSkew`). Profiles now store the clear-time deciles (5%, 15%, … 95%) for this
estimate. The rule catches pairs the ratio misses, for example two very consistent boards
with medians 10% apart, where the faster board wins more than 90% of races (covered by a
unit test). There is also a new warning when a board beats the 120 s timer in fewer than
85% of test runs. No existing tolerance was raised.

### 2. Versioned multiplayer variants

Variants are justified by timer pressure on Fortress and Gatekeeper. Their medians sit at
the 120 s timer, so many races end in time-outs instead of a clear.

| Variant | Base | Change | Effect |
|---|---|---|---|
| `classic-07-mp` v1 "Fortress Sprint" | classic-07 v1 | Cap, shoulders and feet go from 3 hp to 2 hp; armoured side walls unchanged | median 100 → 86 s; beats timer 67% → 81% |
| `classic-10-mp` v1 "Gatekeeper Sprint" | classic-10 v1 | Inner armoured row becomes standard bricks; moving gates unchanged | median 97 → 82 s; beats timer 75% → 90% |

Rules for variants:

- Each has its own id and `version`, and match records store both. Changing a variant's
  layout means bumping its version.
- A variant unlocks exactly when its base board does. It has no campaign mastery or
  rewards and never appears in the campaign.
- **Campaign boards are untouched.** Solo pars, stars and the Phase 1 golden replays are
  unaffected.
- The base boards stay available, with explicit timer warnings.

Fortress Sprint was trimmed in two steps. A third step was not taken: it would remove the
armoured walls that define the board. Further changes need human playtest data.

### 3. Profile and eligibility updates

All eligible boards now use the 48-seed statistics. classic-11 stays excluded: it has the
highest variance (p90 161 s) and is the most upgrade-sensitive board. Compatible distinct
pairs are now 05+08, 07+10, 10+07-mp and 07-mp+10-mp. A unit test locks this list.

## Limits and next steps

- All data comes from one bot. Human playtests are required before any ranked use, and
  likely before re-tuning (human ball loss and aim differ a lot).
- P(first) assumes independent runs. In a real race, sabotage and the opponent's
  visible progress link the two players' runs.
- Ability effects were not part of these timings, apart from the multiplayer relaunch
  delay and energy rules. Sabotage costs the target roughly 1–5 s per accepted attack.
  That is small next to the spread, but it should be measured in human playtests.

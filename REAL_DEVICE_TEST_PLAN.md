# Real-device test plan (Phase 4)

**Status: NOT YET PERFORMED on real phones.** Automated runs use Chromium device
emulation only (desktop Chrome, Pixel 7 and a 430×932 @3x profile), with software WebGL.
Emulation does not show real touch latency, thermal throttling, GPU behaviour, mobile
network loss or iOS Safari quirks. Every item below is unverified until someone runs it on
real hardware and records the result in the table at the end.

## Devices (minimum set)

| # | Device class | Example | Browser |
|---|---|---|---|
| 1 | Low-end Android (≤ 4 GB RAM) | Moto G / Galaxy A1x | Chrome |
| 2 | Mid/high Android | Pixel 7 / Galaxy S2x | Chrome |
| 3 | iPhone (recent) | iPhone 13–16 | Safari |
| 4 | iPhone (older, small screen) | iPhone SE 2/3 | Safari |
| 5 | Tablet | iPad / Android tablet | Safari / Chrome |
| 6 | Desktop control | Windows / macOS | Chrome, Firefox, Safari |

## Setup

1. Phones must reach the PC over the LAN. Run `npm run start:server` and `npm run dev`
   (Vite already listens on the LAN), allow ports 5173 and 2567 through the firewall,
   and open `http://<PC LAN IP>:5173` on each phone. See README "Test with two phones on
   the same Wi-Fi".
2. **Do not expose the dev server to the internet.** Public testing needs HTTPS/WSS behind
   a reverse proxy, with `ALLOWED_ORIGINS` set and `ALLOW_DEV_ROOMS=0`.
3. To test abilities quickly, start the server with `TEST_START_ENERGY=100`. This is a dev
   build only; production refuses it. Also test once with normal energy.

## Checklist

### A. Touch controls and ability buttons

- [ ] Dragging anywhere on the play area moves the paddle to the finger, with no lag
  visible at 60 fps.
- [ ] A tap launches the ball and a drag does not.
- [ ] **While one finger drags the paddle, a second finger can tap the ability buttons.**
  The paddle must not jump to the button.
- [ ] Tapping an ability button never launches the ball and never moves the paddle.
- [ ] Ability buttons are at least 44 px tall and reachable with a thumb in portrait.
- [ ] Ability buttons show cost, key hint, cooldown sweep and greyed state, and are
  readable in sunlight.
- [ ] No double-tap zoom, text selection, long-press menu or pull-to-refresh during play.
- [ ] Rotating the device keeps the board, HUD and ability bar fully visible.
- [ ] Safe-area insets (notch, home bar) do not cover the ability bar.

### B. Ability feedback

- [ ] EMP on the target: the paddle glow flickers yellow and wide/magnet/laser stop, but
  movement, ball and launch are unaffected. "JAMMED" countdown chip.
- [ ] Shrink: the paddle visibly narrows, never below the minimum, and restores on time.
- [ ] Frost: an ice block appears in open space below the bricks. It cracks after 1 hit,
  shatters after 2 or expires after 5 s. It never traps the ball.
- [ ] Shield: a cyan ring around the paddle while active. On block: shockwave and
  "BLOCKED" on both phones.
- [ ] Cleanse removes an active effect with a white burst and "CLEANSED".
- [ ] Incoming warning ("INCOMING …") appears about 0.4 s before the effect.
- [ ] Refusals (not enough energy, cooldown, lockout, opponent serving) show a short
  message and cost nothing.
- [ ] Reduce effects (Workshop → Settings) and the OS reduced-motion setting both remove
  screen shake and most particles.

### C. Network and reconnection (real mobile networks)

- [ ] Wi-Fi to 4G/5G handover mid-match: the match continues, or the reconnect banner
  shows and the player rejoins within the grace period.
- [ ] Screen lock or app switch for under 8 s, then return: the player rejoins, and any
  active effect still shows correctly.
- [ ] High-latency network (> 200 ms): abilities still apply. Watch for visible
  corrections (paddle or ball snapping) and note how often they happen.
- [ ] Airplane mode for longer than the grace period gives a forfeit result on the
  opponent's phone.

### D. Performance

- [ ] Low-end Android keeps a stable frame rate during multiball + Frost + particle bursts.
  If not, does the game switch to low-quality mode?
- [ ] 10 minutes of continuous play: no growing lag, memory or heat problem. Note the
  battery drain.
- [ ] Opponent preview updates smoothly and does not stutter the main board.

### E. Workshop and persistence

- [ ] Buying an upgrade asks for confirmation. A double tap buys only one level.
- [ ] Coins and levels survive a full browser restart.
- [ ] Private or incognito mode shows the storage warning, and the game stays playable.

## Results log

| Date | Tester | Device / OS / browser | Section | Pass/Fail | Notes |
|---|---|---|---|---|---|
| (none yet) | | | | | |

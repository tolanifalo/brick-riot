import { ABILITY_DEFINITIONS, otherSeat, type AbilityId, type ActiveAbility, type DebuffKind, type Seat } from '@brick-riot/shared';
import { useEffect, useState } from 'react';
import { useMatch } from '../../net/matchStore';
import { parseCooldowns, parseDebuff, useHud } from '../../state/hudStore';

const name = (id: AbilityId): string => ABILITY_DEFINITIONS[id].label;

const SHORT: Record<ActiveAbility, string> = { emp: 'EMP', shrink: 'SHRINK', frost: 'FROST', shield: 'SHIELD', cleanse: 'CLEANSE' };
const DEBUFF_TEXT: Record<DebuffKind, string> = { emp: 'JAMMED', shrink: 'SHRUNK', frost: 'FROSTED' };

/** Keyboard bindings (also printed on the buttons). */
const KEYS = ['1', '2'] as const;

function AbilityButton({ ability, hotkey, energy, cooldown }: { ability: ActiveAbility; hotkey: string; energy: number; cooldown: number }) {
  const net = useMatch((s) => s.net);
  const def = ABILITY_DEFINITIONS[ability];
  const cost = def.energyCost;
  const ready = cooldown <= 0 && energy >= cost;
  const total = Math.max(1, def.cooldownSeconds);
  return (
    <button
      type="button"
      className={`ability-btn ${def.slot}${ready ? ' ready' : ''}`}
      data-testid={`ability-${ability}`}
      aria-label={`${name(ability)}, ${cost} energy, key ${hotkey}${cooldown > 0 ? `, ready in ${cooldown.toFixed(1)} seconds` : ''}`}
      aria-disabled={!ready}
      // Pointer-down (not click): instant on touch, and no focus steal, so
      // Space keeps launching the ball after a mouse press.
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (ready) net?.requestAbility(ability);
      }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && ready) {
          e.preventDefault();
          net?.requestAbility(ability);
        }
      }}
    >
      <span className="ability-key" aria-hidden="true">
        {hotkey}
      </span>
      <span className="ability-name">{SHORT[ability]}</span>
      <span className="ability-cost">{cost}</span>
      {cooldown > 0 && (
        <>
          <span className="ability-cd" style={{ transform: `scaleY(${Math.min(1, cooldown / total)})` }} aria-hidden="true" />
          <span className="ability-cd-num" aria-hidden="true">
            {Math.ceil(cooldown)}
          </span>
        </>
      )}
    </button>
  );
}

/** Own energy, ability buttons, effect status and feedback toasts. */
export function AbilityBar({ seat }: { seat: Seat }) {
  const start = useMatch((s) => s.start);
  const net = useMatch((s) => s.net);
  const result = useMatch((s) => s.result);
  const energy = useHud((s) => s.energy);
  const energyMax = useHud((s) => s.energyMax);
  const cooldownsRaw = useHud((s) => s.cooldowns);
  const debuffRaw = useHud((s) => s.debuff);
  const shield = useHud((s) => s.shield);
  const immune = useHud((s) => s.immune);
  const loadout = start?.loadouts[seat];

  useEffect(() => {
    if (!loadout || !net || result) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || (e.target instanceof Element && e.target.closest('input, textarea'))) return;
      const index = KEYS.indexOf(e.key as (typeof KEYS)[number]);
      if (index < 0) return;
      e.preventDefault();
      net.requestAbility(index === 0 ? loadout.offensive : loadout.defensive);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loadout, net, result]);

  if (!loadout) return null;
  const cooldowns = parseCooldowns(cooldownsRaw);
  const debuff = parseDebuff(debuffRaw);
  return (
    <div className="ability-bar" data-ui data-testid="ability-bar">
      <div className="energy-row">
        <div className="energy" role="meter" aria-label="Energy" aria-valuemin={0} aria-valuemax={energyMax} aria-valuenow={energy}>
          <div className="energy-fill" style={{ transform: `scaleX(${Math.min(1, energy / Math.max(1, energyMax))})` }} />
        </div>
        <span className="energy-num" data-testid="energy">
          {energy}
        </span>
      </div>
      <div className="ability-row">
        <AbilityButton ability={loadout.offensive} hotkey={KEYS[0]} energy={energy} cooldown={cooldowns[loadout.offensive] ?? 0} />
        <AbilityButton ability={loadout.defensive} hotkey={KEYS[1]} energy={energy} cooldown={cooldowns[loadout.defensive] ?? 0} />
        <div className="ability-status" data-testid="own-effects">
          {debuff && (
            <span className={`fx-chip bad${debuff.phase === 'pending' ? ' pending' : ''}`} data-testid="own-debuff">
              {debuff.phase === 'pending' ? `INCOMING ${SHORT[debuff.kind]}` : `${DEBUFF_TEXT[debuff.kind]} ${debuff.seconds.toFixed(1)}`}
            </span>
          )}
          {shield > 0 && (
            <span className="fx-chip shield" data-testid="own-shield">
              SHIELD {(shield / 10).toFixed(1)}
            </span>
          )}
          {immune && <span className="fx-chip info">IMMUNE</span>}
          <span className="fx-chip passive" title={name(loadout.passive)}>
            {name(loadout.passive).toUpperCase()}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Opponent's effects for the strip: shield, debuff, immunity, energy. */
export function OpponentEffects({ seat }: { seat: Seat }) {
  const progress = useMatch((s) => s.progress);
  const view = progress?.players.find((p) => p.seat === otherSeat(seat));
  if (!view) return null;
  return (
    <span className="opp-effects" data-testid="opponent-effects">
      <span className="opp-energy" aria-label={`Opponent energy ${view.energy}`}>
        EN {view.energy}
      </span>
      {view.debuff && <span className="fx-chip bad small">{DEBUFF_TEXT[view.debuff]}</span>}
      {view.shielded && <span className="fx-chip shield small">SHIELD</span>}
      {view.immune && <span className="fx-chip info small">IMMUNE</span>}
    </span>
  );
}

/** Short-lived ability feedback (incoming, blocked, refused). */
export function AbilityFeed() {
  const feed = useMatch((s) => s.feed);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  // Items newer than the last clock tick are always shown.
  const visible = feed.filter((f) => f.at > now - 3000);
  if (visible.length === 0) return null;
  return (
    <div className="ability-feed" aria-live="polite" data-testid="ability-feed">
      {visible.map((f) => (
        <p key={f.id} className={`feed-item ${f.tone}`}>
          {f.text}
        </p>
      ))}
    </div>
  );
}

import {
  ABILITY_DEFINITIONS,
  ABILITY_RULES,
  isAbilityUnlocked,
  loadoutPower,
  SLOT_OPTIONS,
  validateLoadout,
  type AbilityId,
  type Loadout,
  type LoadoutSlot,
} from '@brick-riot/shared';

const SLOT_TITLES: Record<LoadoutSlot, string> = { offensive: 'OFFENSE', defensive: 'DEFENSE', passive: 'PASSIVE' };
const SLOTS: readonly LoadoutSlot[] = ['offensive', 'defensive', 'passive'];

/**
 * Three-slot loadout chooser. Unlocks come from player level; the power
 * budget is always enforced. The server re-validates everything.
 */
export function LoadoutPicker({
  loadout,
  level,
  ignoreUnlocks = false,
  disabled = false,
  onChange,
}: {
  loadout: Loadout;
  level: number;
  ignoreUnlocks?: boolean;
  disabled?: boolean;
  onChange(next: Loadout): void;
}) {
  const power = loadoutPower(loadout);
  return (
    <div className="loadout" data-testid="loadout-picker">
      <p className="loadout-budget" data-testid="loadout-budget">
        LOADOUT POWER <strong>{power}</strong> / {ABILITY_RULES.loadoutBudget}
      </p>
      {SLOTS.map((slot) => (
        <fieldset key={slot} className="loadout-slot" disabled={disabled}>
          <legend>{SLOT_TITLES[slot]}</legend>
          <div className="loadout-options">
            {SLOT_OPTIONS[slot].map((id: AbilityId) => {
              const def = ABILITY_DEFINITIONS[id];
              const candidate = { ...loadout, [slot]: id } as Loadout;
              const unlocked = ignoreUnlocks || isAbilityUnlocked(id, level);
              const check = validateLoadout(candidate, level, { ignoreUnlocks });
              const selected = loadout[slot] === id;
              const reason = !unlocked ? `Unlocks at level ${def.unlockLevel}` : !check.ok && check.error === 'over_budget' ? 'Over budget' : null;
              return (
                <button
                  key={id}
                  type="button"
                  className={`loadout-option${selected ? ' selected' : ''}${reason ? ' unavailable' : ''}`}
                  aria-pressed={selected}
                  disabled={disabled || (!selected && !check.ok)}
                  onClick={() => check.ok && onChange(check.loadout)}
                  title={def.description}
                  data-testid={`loadout-${id}`}
                >
                  <span className="loadout-name">{def.label}</span>
                  <span className="loadout-meta">
                    {def.slot === 'passive' ? 'always on' : `${def.energyCost} EN · ${def.cooldownSeconds}s cd`} · PWR {def.power}
                  </span>
                  <span className="loadout-desc">{reason ?? def.description}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

/** One-line summary of a loadout (lobby slots, opponent info). */
export function loadoutSummary(loadout: Loadout): string {
  return [loadout.offensive, loadout.defensive, loadout.passive].map((id) => ABILITY_DEFINITIONS[id].label).join(' · ');
}

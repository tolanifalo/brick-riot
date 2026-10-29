import {
  levelForXp,
  maxLevel,
  nextLevelCost,
  rateEquipment,
  UPGRADE_IDS,
  UPGRADES,
  upgradeEffect,
  type UpgradeId,
} from '@brick-riot/shared';
import { useState } from 'react';
import { useProgress, type PurchaseOutcome } from '../progress/progressStore';
import { useApp } from '../state/appStore';
import { LoadoutPicker } from './LoadoutPicker';

const PURCHASE_ERRORS: Record<string, string> = {
  insufficient_coins: 'Not enough coins.',
  max_level: 'Already at max level.',
  stale_level: 'That purchase was already made.',
  unknown_upgrade: 'Unknown upgrade.',
  save_failed: 'The purchase could not be saved, so nothing was charged.',
};

function Pips({ level, max }: { level: number; max: number }) {
  return (
    <span className="pips" aria-label={`Level ${level} of ${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={i < level ? 'pip on' : 'pip'} />
      ))}
    </span>
  );
}

function UpgradeCard({ id, onBuy, flash }: { id: UpgradeId; onBuy(id: UpgradeId): void; flash: boolean }) {
  const progress = useProgress((s) => s.progress);
  const def = UPGRADES[id];
  const level = progress.upgrades[id];
  const max = maxLevel(id);
  const cost = nextLevelCost(id, level);
  const affordable = cost !== null && progress.coins >= cost;
  return (
    <li className={`upgrade${flash ? ' bought' : ''}`} data-testid={`upgrade-${id}`}>
      <div className="upgrade-head">
        <span className="upgrade-name">{def.label}</span>
        <Pips level={level} max={max} />
      </div>
      <p className="upgrade-desc">{def.description}</p>
      <p className="upgrade-effect">
        {level > 0 ? def.format(upgradeEffect(id, level)) : 'Not upgraded'}
        {cost !== null && (
          <>
            {' '}
            <span className="upgrade-arrow" aria-hidden="true">
              →
            </span>{' '}
            <strong>{def.format(upgradeEffect(id, level + 1))}</strong>
          </>
        )}
      </p>
      <button
        type="button"
        className={`btn small${affordable ? ' primary' : ''}`}
        disabled={!affordable}
        onClick={() => onBuy(id)}
        data-testid={`buy-${id}`}
      >
        {cost === null ? 'MAX LEVEL' : `UPGRADE · ${cost.toLocaleString('en-US')} C`}
      </button>
    </li>
  );
}

function ConfirmPurchase({ id, onDone }: { id: UpgradeId; onDone(result: PurchaseOutcome | null): void }) {
  const progress = useProgress((s) => s.progress);
  const purchase = useProgress((s) => s.purchase);
  const [busy, setBusy] = useState(false);
  const def = UPGRADES[id];
  const level = progress.upgrades[id];
  const cost = nextLevelCost(id, level) ?? 0;
  return (
    <div className="overlay blocking" data-ui>
      <section className="panel neutral" role="dialog" aria-label="Confirm upgrade">
        <h2 className="panel-title">UPGRADE?</h2>
        <p>
          <strong>{def.label}</strong> level {level} → {level + 1}: {def.format(upgradeEffect(id, level + 1))}
        </p>
        <p className="mp-small">
          {cost.toLocaleString('en-US')} coins · you have {progress.coins.toLocaleString('en-US')}, leaving{' '}
          {(progress.coins - cost).toLocaleString('en-US')}.
        </p>
        <div className="panel-actions">
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            autoFocus
            data-testid="confirm-buy"
            onClick={() => {
              // Guards against double taps: the button disables and the store
              // also rejects a second purchase of the same level.
              setBusy(true);
              void purchase(id, level).then(onDone);
            }}
          >
            BUY
          </button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => onDone(null)}>
            CANCEL
          </button>
        </div>
      </section>
    </div>
  );
}

export function WorkshopScreen() {
  const setScreen = useApp((s) => s.setScreen);
  const progress = useProgress((s) => s.progress);
  const saveLoadout = useProgress((s) => s.saveLoadout);
  const setReducedEffects = useProgress((s) => s.setReducedEffects);
  const [confirming, setConfirming] = useState<UpgradeId | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [flash, setFlash] = useState<UpgradeId | null>(null);
  const level = levelForXp(progress.xp).level;
  const soloPower = rateEquipment({ loadout: null, upgrades: progress.upgrades }, 'solo').power;

  return (
    <main className="workshop" data-testid="workshop">
      <header className="campaign-head" data-ui>
        <button type="button" className="back-btn" onClick={() => setScreen('menu')} data-testid="workshop-back">
          <span className="back-arrow" aria-hidden="true" />
          MENU
        </button>
        <h1>WORKSHOP</h1>
        <span className="coins" data-testid="workshop-coins">
          {progress.coins.toLocaleString('en-US')} C
        </span>
      </header>

      <section aria-labelledby="ws-upgrades">
        <h2 className="mp-subtitle" id="ws-upgrades">
          UPGRADES
        </h2>
        <p className="mp-small">
          Bought with coins earned in the campaign; returns shrink at higher levels. Upgrades apply to solo play
          (equipment power {soloPower}). In multiplayer they only apply in rooms with upgrades on, capped, and never in
          ranked.
        </p>
        {message && (
          <p className={message.ok ? 'ws-ok' : 'mp-error'} role="status" data-testid="workshop-message">
            {message.text}
          </p>
        )}
        <ul className="upgrade-grid">
          {UPGRADE_IDS.map((id) => (
            <UpgradeCard
              key={id}
              id={id}
              flash={flash === id}
              onBuy={(next) => {
                setMessage(null);
                setConfirming(next);
              }}
            />
          ))}
        </ul>
      </section>

      <section aria-labelledby="ws-loadout">
        <h2 className="mp-subtitle" id="ws-loadout">
          MULTIPLAYER LOADOUT
        </h2>
        <p className="mp-small">
          Your preferred loadout for new rooms (level {level}). Abilities unlock as you level up in the campaign;
          nothing is sold for money.
        </p>
        <LoadoutPicker loadout={progress.loadout} level={level} onChange={(l) => void saveLoadout(l)} />
      </section>

      <section aria-labelledby="ws-settings">
        <h2 className="mp-subtitle" id="ws-settings">
          SETTINGS
        </h2>
        <label className="dev-toggle">
          <input
            type="checkbox"
            checked={progress.settings.reducedEffects}
            onChange={(e) => void setReducedEffects(e.target.checked)}
            data-testid="reduced-effects"
          />
          <span>Reduce effects (fewer particles, no screen shake). Also follows your system reduced-motion setting.</span>
        </label>
      </section>

      {confirming && (
        <ConfirmPurchase
          id={confirming}
          onDone={(result) => {
            const id = confirming;
            setConfirming(null);
            if (!result) return;
            if (result.ok) {
              setMessage({ text: `${UPGRADES[id].label} upgraded to level ${result.level}.`, ok: true });
              setFlash(id);
              setTimeout(() => setFlash((f) => (f === id ? null : f)), 700);
            } else {
              setMessage({ text: PURCHASE_ERRORS[result.error] ?? 'Purchase failed.', ok: false });
            }
          }}
        />
      )}
    </main>
  );
}

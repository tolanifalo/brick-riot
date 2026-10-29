import {
  CASUAL_UPGRADE_POWER_CAP,
  getMatchBoard,
  levelForXp,
  MULTIPLAYER_BOARDS,
  selectableBoards,
  type LobbyPlayerView,
  type LobbyView,
  type MultiplayerBoardProfile,
} from '@brick-riot/shared';
import { useState } from 'react';
import { matchActions, useMatch } from '../../net/matchStore';
import { useProgress } from '../../progress/progressStore';
import { LoadoutPicker, loadoutSummary } from '../LoadoutPicker';

const REASONS: Record<string, string> = {
  locked: 'That is not unlocked yet.',
  over_budget: 'That loadout is over the power budget.',
  unready_first: 'Un-ready to change your loadout.',
  host_only: 'Only the host can change that.',
  not_multiplayer_eligible: 'That board is not available for multiplayer.',
  choose_board_first: 'Choose a board first.',
  accept_unranked_first: 'Accept the unranked mismatch first.',
};

const MECHANIC_LABELS: Record<string, string> = {
  indestructible: 'steel',
  powerup: 'power-ups',
  explosive: 'explosives',
  moving: 'moving',
};

function boardName(id: string | null): string {
  return id ? (getMatchBoard(id)?.name ?? id) : 'No board yet';
}

function PlayerSlot({ player, me }: { player: LobbyPlayerView | undefined; me: boolean }) {
  if (!player) {
    return (
      <li className="mp-slot empty" data-testid="slot-empty">
        <span className="slot-name">Waiting for opponent…</span>
        <span className="slot-board">Share the room code</span>
      </li>
    );
  }
  return (
    <li className={`mp-slot${player.ready ? ' ready' : ''}${me ? ' me' : ''}`} data-testid={`slot-${player.seat}`}>
      <span className="slot-name">
        {player.name}
        {me && <span className="tag">YOU</span>}
        {player.isHost && <span className="tag host">HOST</span>}
      </span>
      <span className="slot-board" data-testid={`slot-board-${player.seat}`}>
        {boardName(player.boardId)}
      </span>
      <span className="slot-loadout" data-testid={`slot-loadout-${player.seat}`}>
        {loadoutSummary(player.loadout)}
      </span>
      <span className="slot-epr" data-testid={`slot-epr-${player.seat}`} title="Equipment Power Rating (from loadout and applied upgrades; not XP)">
        EPR {player.equipment.power}
      </span>
      <span className="slot-state">
        {!player.connected ? 'RECONNECTING…' : player.ready ? 'READY' : 'NOT READY'}
      </span>
    </li>
  );
}

function EquipmentSection({ lobby, isHost }: { lobby: LobbyView; isHost: boolean }) {
  const eq = lobby.equipmentCompatibility;
  const editable = isHost && lobby.phase === 'lobby';
  return (
    <section className={`compat ${eq && !eq.even ? 'bad' : 'ok'}`} data-testid="equipment">
      <h3>EQUIPMENT</h3>
      <div className="seg" role="radiogroup" aria-label="Equipment mode">
        {(
          [
            ['casual', 'STANDARD', 'Loadouts only. Workshop upgrades are off.'],
            ['casualUpgrades', 'UPGRADES ON', `Workshop upgrades apply, capped at ${CASUAL_UPGRADE_POWER_CAP} power each.`],
          ] as const
        ).map(([mode, label, help]) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={lobby.equipmentMode === mode}
            className={`seg-btn${lobby.equipmentMode === mode ? ' on' : ''}`}
            disabled={!editable}
            title={help}
            onClick={() => matchActions.send('setEquipmentMode', { mode })}
            data-testid={`equipment-mode-${mode}`}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="mp-small">
        {lobby.equipmentMode === 'casual'
          ? 'Standard: abilities from loadouts only; upgrades do not apply.'
          : `Upgrades on: each player's Workshop upgrades apply up to ${CASUAL_UPGRADE_POWER_CAP} power.`}{' '}
        {!isHost && 'The host chooses.'} Upgrade levels come from each player&apos;s local save and are not verified,
        which is why they are never used in ranked play.
      </p>
      {eq && !eq.even && (
        <p className="compat-problem" data-testid="equipment-warning">
          Equipment differs by {eq.gap} power: this race is uneven.
        </p>
      )}
      {eq?.warnings.map((w) => (
        <p key={w} className="compat-warning">
          {w}
        </p>
      ))}
    </section>
  );
}

function BoardOption({
  profile,
  selected,
  locked,
  onPick,
}: {
  profile: MultiplayerBoardProfile;
  selected: boolean;
  locked: boolean;
  onPick(): void;
}) {
  const board = getMatchBoard(profile.boardId);
  return (
    <li>
      <button
        type="button"
        className={`mp-board${selected ? ' selected' : ''}${locked ? ' locked' : ''}`}
        disabled={locked}
        onClick={onPick}
        aria-pressed={selected}
        data-testid={`mp-board-${profile.boardId}`}
      >
        <span className="mp-board-name">{board?.name}</span>
        <span className="mp-board-meta">
          {profile.expectedCompletionSeconds !== null ? `~${profile.expectedCompletionSeconds}s` : '?'} ·{' '}
          {profile.band} · diff {profile.difficulty}
        </span>
        <span className="mp-board-mech">
          {locked
            ? 'Locked in campaign'
            : profile.mechanics.length > 0
              ? profile.mechanics.map((m) => MECHANIC_LABELS[m] ?? m).join(', ')
              : 'standard bricks'}
        </span>
      </button>
    </li>
  );
}

export function LobbyScreen() {
  const lobby = useMatch((s) => s.lobby);
  const seat = useMatch((s) => s.seat);
  const notice = useMatch((s) => s.notice);
  const progress = useProgress((s) => s.progress);
  const [copied, setCopied] = useState(false);
  if (!lobby) return null;

  const me = lobby.players.find((p) => p.seat === seat);
  const opponent = lobby.players.find((p) => p.seat !== seat);
  const claim = {
    clearedBoardIds: Object.values(progress.boards)
      .filter((b) => b.completions > 0)
      .map((b) => b.boardId),
    xp: progress.xp,
  };
  const allowed = new Set(selectableBoards(claim, lobby.devMode).map((p) => p.boardId));
  const level = levelForXp(progress.xp).level;
  const compat = lobby.compatibility;
  const mustAccept = lobby.needsUnrankedAcceptance;
  const countdown = lobby.phase !== 'lobby';

  return (
    <main className="mp-lobby" data-testid="mp-lobby">
      <header className="campaign-head" data-ui>
        <button
          type="button"
          className="back-btn"
          onClick={() => {
            if (me?.isHost && lobby.players.length === 1) matchActions.send('cancel');
            void matchActions.leave();
          }}
          data-testid="lobby-leave"
        >
          <span className="back-arrow" aria-hidden="true" />
          LEAVE
        </button>
        <h1>LOBBY</h1>
        {lobby.devMode && (
          <span className="tag dev" data-testid="dev-badge">
            DEV ROOM
          </span>
        )}
      </header>

      <section className="room-code" aria-label="Room code">
        <span className="room-code-label">ROOM CODE</span>
        <span className="room-code-value" data-testid="room-code">
          {lobby.roomCode}
        </span>
        <button
          type="button"
          className="btn ghost small"
          onClick={() => {
            void navigator.clipboard?.writeText(lobby.roomCode).then(() => setCopied(true), () => undefined);
          }}
        >
          {copied ? 'COPIED' : 'COPY'}
        </button>
      </section>

      <ul className="mp-slots">
        <PlayerSlot player={lobby.players.find((p) => p.seat === 'A')} me={seat === 'A'} />
        <PlayerSlot player={lobby.players.find((p) => p.seat === 'B')} me={seat === 'B'} />
      </ul>

      <h2 className="mp-subtitle">CHOOSE YOUR BOARD</h2>
      <p className="mp-small">
        You and your opponent may race on different boards. Only multiplayer-reviewed boards are listed
        {lobby.devMode ? '; dev room: unlocks are not checked.' : '; unlocked by your campaign progress.'}
      </p>
      <ul className="mp-board-grid">
        {MULTIPLAYER_BOARDS.map((p) => (
          <BoardOption
            key={p.boardId}
            profile={p}
            selected={me?.boardId === p.boardId}
            locked={!allowed.has(p.boardId)}
            onPick={() => matchActions.send('selectBoard', { boardId: p.boardId })}
          />
        ))}
      </ul>
      {allowed.size === 0 && (
        <p className="mp-small" data-testid="no-boards">
          Clear Opening Riot in the campaign to unlock your first multiplayer board.
        </p>
      )}

      {compat && (
        <section className={`compat ${compat.compatible ? 'ok' : 'bad'}`} data-testid="compatibility">
          <h3>{compat.compatible ? 'FAIR MATCH-UP' : 'UNEVEN MATCH-UP'}</h3>
          {compat.expectedTimeRatio !== null && (
            <p>Expected clear times differ by {Math.round((compat.expectedTimeRatio - 1) * 100)}%.</p>
          )}
          {compat.problems.map((p) => (
            <p key={p} className="compat-problem">
              {p}
            </p>
          ))}
          {compat.warnings.map((w) => (
            <p key={w} className="compat-warning">
              {w}
            </p>
          ))}
          <p className="mp-small">Unranked private match · balance {compat.calibration}.</p>
        </section>
      )}

      <h2 className="mp-subtitle">YOUR LOADOUT</h2>
      <p className="mp-small">
        Change it until you are ready; it locks when the countdown starts. Both players see each other&apos;s
        loadout. {me?.ready && 'Un-ready to change it.'}
      </p>
      {me && (
        <LoadoutPicker
          loadout={me.loadout}
          level={level}
          ignoreUnlocks={lobby.devMode}
          disabled={me.ready || countdown}
          onChange={(loadout) => {
            matchActions.send('setLoadout', { loadout });
            // Remember it as the preferred loadout (only if it is valid outside dev rooms).
            void useProgress.getState().saveLoadout(loadout);
          }}
        />
      )}

      <EquipmentSection lobby={lobby} isHost={!!me?.isHost} />

      {mustAccept && (
        <label className="dev-toggle accept" data-ui>
          <input
            type="checkbox"
            checked={me?.acceptsUnranked ?? false}
            onChange={(e) => matchActions.send('acceptUnranked', { accept: e.target.checked })}
            data-testid="accept-unranked"
          />
          <span>I accept an uneven, unranked race (boards and/or equipment).</span>
        </label>
      )}

      {notice && (
        <p className="mp-error" role="status" data-testid="lobby-notice">
          {REASONS[notice] ?? notice.replace(/_/g, ' ')}
        </p>
      )}

      <div className="lobby-footer" data-ui>
        <button
          type="button"
          className={me?.ready ? 'btn' : 'btn primary'}
          disabled={!me?.boardId || countdown || (mustAccept && !me?.acceptsUnranked)}
          onClick={() => matchActions.send('setReady', { ready: !me?.ready })}
          data-testid="ready-button"
        >
          {me?.ready ? 'NOT READY' : 'READY'}
        </button>
        <p className="mp-small" data-testid="lobby-status">
          {!opponent
            ? 'Waiting for an opponent to join.'
            : !opponent.boardId
              ? `${opponent.name} is choosing a board.`
              : opponent.ready && me?.ready
                ? 'Starting…'
                : opponent.ready
                  ? `${opponent.name} is ready.`
                  : `Waiting for ${opponent.name} to ready up.`}
        </p>
      </div>
    </main>
  );
}

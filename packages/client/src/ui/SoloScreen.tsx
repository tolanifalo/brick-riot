import { getLevel, levelNumber, type BoardDefinition, type RunOutcome } from '@brick-riot/shared';
import { useEffect, useRef, useState } from 'react';
import { GameBridge } from '../game/bridge';
import { createSoloGame } from '../game/createGame';
import { canStartBoard, useProgress } from '../progress/progressStore';
import { prefetchRunTicket, takeRunTicket } from '../progress/runTickets';
import { useApp } from '../state/appStore';
import { INITIAL_HUD, useHud } from '../state/hudStore';
import { ComboBadge, EffectChips, Hud } from './Hud';
import { StatusOverlay, type RunRecordState } from './StatusOverlay';

export function SoloScreen() {
  const boardId = useApp((s) => s.boardId);
  const setScreen = useApp((s) => s.setScreen);
  // Re-evaluate when progress (or the signed-in profile) changes.
  useProgress((s) => s.progress);
  const board = boardId ? getLevel(boardId) : undefined;
  const level = board ? (levelNumber(board.id) ?? 1) : 1;
  // Defence in depth: even if state were tampered with, a locked board never mounts.
  const allowed = !!board && canStartBoard(board.id);

  useEffect(() => {
    if (!allowed) setScreen('campaign');
  }, [allowed, setScreen]);

  if (!board || !allowed) return null;
  // Remount the game when the board changes (e.g. "Next level").
  return <SoloGame key={board.id} board={board} level={level} />;
}

function SoloGame({ board, level }: { board: BoardDefinition; level: number }) {
  const surfaceRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [bridge] = useState(() => new GameBridge());
  const [record, setRecord] = useState<RunRecordState>({ status: 'idle' });
  const setScreen = useApp((s) => s.setScreen);
  const signedIn = useProgress((s) => s.mode === 'account');
  // Signed in: fetch the first server-issued run before the game starts.
  const [ticketReady, setTicketReady] = useState(!signedIn);

  useEffect(() => {
    if (!signedIn || !board) return;
    let cancelled = false;
    const timeout = setTimeout(() => !cancelled && setTicketReady(true), 4000);
    void prefetchRunTicket(board.id).finally(() => {
      if (!cancelled) setTicketReady(true);
    });
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [signedIn, board]);

  useEffect(() => {
    const parent = stageRef.current;
    const surface = surfaceRef.current;
    if (!parent || !surface || !board || !ticketReady) return;
    useHud.setState({ ...INITIAL_HUD });
    let active = true;
    const unlisten = bridge.listen({
      // A restart begins a new run; clear the previous result.
      onRunStarted: () => setRecord({ status: 'idle' }),
      onRunFinished: (run) => {
        setRecord({ status: 'saving' });
        void useProgress
          .getState()
          .recordRun(run)
          .then((outcome: RunOutcome | null) => {
            if (active) setRecord(outcome ? { status: 'done', outcome } : { status: 'idle' });
          });
      },
    });
    // Upgrades are fixed for the whole session on this board (restarts included);
    // each run records the levels it used so its replay verifies.
    const { upgrades, settings } = useProgress.getState().progress;
    const game = createSoloGame({
      parent,
      inputSurface: surface,
      board,
      levelNumber: level,
      bridge,
      upgrades,
      reducedEffects: settings.reducedEffects,
      ...(signedIn ? { takeRunTicket: () => takeRunTicket(board.id) } : {}),
    });
    return () => {
      active = false;
      unlisten();
      game.destroy(true);
      useHud.setState({ ...INITIAL_HUD });
    };
  }, [bridge, board, level, ticketReady, signedIn]);

  if (!board) return null;
  return (
    <main className="solo" ref={surfaceRef}>
      <div className="solo-column">
        <Hud bridge={bridge} />
        <div className="stage">
          <div className="stage-canvas" ref={stageRef} data-testid="stage" />
          <EffectChips />
          <ComboBadge />
          <StatusOverlay
            bridge={bridge}
            level={level}
            record={record}
            onExit={() => setScreen('campaign')}
          />
        </div>
      </div>
      <aside className="controls-panel" data-ui>
        <h2>CONTROLS</h2>
        <dl>
          <dt>Move</dt>
          <dd>Mouse, ← → or A D</dd>
          <dt>Launch</dt>
          <dd>Click or Space</dd>
          <dt>Fire / release</dt>
          <dd>Click or Space (laser, magnet)</dd>
          <dt>Pause</dt>
          <dd>P or Esc</dd>
          <dt>Restart</dt>
          <dd>R</dd>
        </dl>
        <h2>BRICKS</h2>
        <ul className="legend">
          <li>
            <span className="swatch c-orange" /> Standard · 1 hit
          </li>
          <li>
            <span className="swatch c-red reinforced" /> Reinforced · 2-3 hits
          </li>
          <li>
            <span className="swatch c-magenta" /> Explosive · clears 3×3
          </li>
          <li>
            <span className="swatch c-violet" /> Power-up · drops a capsule
          </li>
          <li>
            <span className="swatch c-cyan" /> Moving · slides back and forth
          </li>
          <li>
            <span className="swatch c-steel" /> Steel · unbreakable, not required
          </li>
        </ul>
      </aside>
    </main>
  );
}

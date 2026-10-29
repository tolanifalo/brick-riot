import { compileBoard, getMatchBoard, SIM, type PreviewMessage } from '@brick-riot/shared';
import { useEffect, useMemo, useRef } from 'react';
import { CLASSIC_THEME } from '../../game/theme';
import { subscribePreview } from '../../net/matchStore';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/**
 * Live miniature of the opponent's board, drawn from the server's 10 Hz
 * preview stream straight onto a canvas (no React re-render per update).
 */
export function OpponentPreview({ boardId, width }: { boardId: string; width: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bricks = useMemo(() => {
    const board = getMatchBoard(boardId);
    return board ? compileBoard(board, SIM.worldWidth) : [];
  }, [boardId]);
  const height = Math.round((width * SIM.worldHeight) / SIM.worldWidth);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const k = (width / SIM.worldWidth) * dpr;

    const draw = (p: PreviewMessage | null) => {
      ctx.fillStyle = hex(CLASSIC_THEME.background);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const movers = new Map(p?.movers ?? []);
      bricks.forEach((b, i) => {
        const state = p ? p.bricks.charAt(i) : String(b.hp);
        if (state === '.' || state === '') return;
        const x = movers.get(i) ?? b.x;
        ctx.fillStyle = hex(CLASSIC_THEME.bricks[b.color]);
        ctx.fillRect(x * k, b.y * k, Math.max(1, b.width * k - dpr), Math.max(1, b.height * k - dpr));
      });
      if (!p) return;
      // Frost Bricks (sabotage on the opponent's board): pale ice with an outline.
      for (const [x, y, w, h] of p.frost ?? []) {
        ctx.fillStyle = '#e8fbff';
        ctx.fillRect(x * k, y * k, Math.max(1, w * k - dpr), Math.max(1, h * k - dpr));
        ctx.strokeStyle = '#0a3a52';
        ctx.lineWidth = dpr;
        ctx.strokeRect(x * k, y * k, Math.max(1, w * k - dpr), Math.max(1, h * k - dpr));
      }
      ctx.fillStyle = hex(CLASSIC_THEME.paddleCap);
      ctx.fillRect((p.paddleX - p.paddleWidth / 2) * k, 724 * k, p.paddleWidth * k, Math.max(2, 10 * k));
      ctx.fillStyle = '#ffffff';
      for (const [x, y] of p.balls) {
        ctx.beginPath();
        ctx.arc(x * k, y * k, Math.max(1.5 * dpr, 7 * k), 0, Math.PI * 2);
        ctx.fill();
      }
    };
    draw(null);
    return subscribePreview((p) => draw(p));
  }, [bricks, width, height]);

  return (
    <canvas
      ref={canvasRef}
      className="opponent-preview"
      style={{ width, height }}
      aria-label="Opponent board preview"
      data-testid="opponent-preview"
    />
  );
}

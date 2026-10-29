import type { TickInput } from '@brick-riot/shared';

export interface InputHandlers {
  onTogglePause(): void;
  onRestart(): void;
  /** Space/Enter when the run is over restarts instead of launching. */
  isOver(): boolean;
  onFocusLost(): void;
}

export interface Rect {
  left: number;
  width: number;
}

/** Maps a client X coordinate onto the playfield's world X. */
export function clientToWorldX(clientX: number, rect: Rect, worldWidth: number): number {
  if (rect.width <= 0) return worldWidth / 2;
  return ((clientX - rect.left) / rect.width) * worldWidth;
}

const TAP_MAX_DISTANCE = 14;
const TAP_MAX_MS = 350;

/**
 * Collects DOM input into per-tick TickInput samples.
 *
 * Touch: the paddle follows the finger horizontally anywhere on `surface`;
 * a short tap launches. Mouse: the paddle follows the cursor anywhere in the
 * window; click launches. Keyboard: arrows/A-D move, Space launches,
 * P/Esc pause, R restarts.
 */
export class InputController {
  private targetX: number | null = null;
  private left = false;
  private right = false;
  private launchQueued = false;
  private touchId: number | null = null;
  private touchStart = { x: 0, y: 0, t: 0 };

  constructor(
    private readonly surface: HTMLElement,
    private readonly canvasRect: () => Rect,
    private readonly worldWidth: number,
    private readonly handlers: InputHandlers,
  ) {}

  attach(): void {
    this.surface.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  detach(): void {
    this.surface.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerCancel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  /** Returns this tick's input and consumes any queued launch. */
  sample(): TickInput {
    const axis = (this.right ? 1 : 0) - (this.left ? 1 : 0);
    const input: TickInput = {
      targetX: axis !== 0 ? null : this.targetX,
      axis,
      launch: this.launchQueued,
    };
    this.launchQueued = false;
    return input;
  }

  clearLaunch(): void {
    this.launchQueued = false;
  }

  /** Stops the paddle chasing a stale pointer target (e.g. after restart). */
  resetTarget(): void {
    this.targetX = null;
  }

  private toWorld(clientX: number): number {
    return clientToWorldX(clientX, this.canvasRect(), this.worldWidth);
  }

  private isUiTarget(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('button, a, input, [data-ui]') !== null;
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.isUiTarget(e.target)) return;
    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return;
      this.targetX = this.toWorld(e.clientX);
      this.launchQueued = true;
      return;
    }
    if (this.touchId !== null) return;
    e.preventDefault();
    this.touchId = e.pointerId;
    this.touchStart = { x: e.clientX, y: e.clientY, t: performance.now() };
    this.targetX = this.toWorld(e.clientX);
    this.surface.setPointerCapture?.(e.pointerId);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') {
      this.targetX = this.toWorld(e.clientX);
    } else if (e.pointerId === this.touchId) {
      this.targetX = this.toWorld(e.clientX);
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.touchId) return;
    const dist = Math.hypot(e.clientX - this.touchStart.x, e.clientY - this.touchStart.y);
    if (dist < TAP_MAX_DISTANCE && performance.now() - this.touchStart.t < TAP_MAX_MS) {
      this.launchQueued = true;
    }
    this.touchId = null;
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerId === this.touchId) this.touchId = null;
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const onUi = this.isUiTarget(e.target);
    switch (e.code) {
      case 'ArrowLeft':
      case 'KeyA':
        this.left = true;
        this.targetX = null;
        e.preventDefault();
        break;
      case 'ArrowRight':
      case 'KeyD':
        this.right = true;
        this.targetX = null;
        e.preventDefault();
        break;
      case 'Space':
      case 'ArrowUp':
      case 'KeyW':
      case 'Enter':
        if (onUi) return;
        e.preventDefault();
        if (e.repeat) return;
        if (this.handlers.isOver()) this.handlers.onRestart();
        else this.launchQueued = true;
        break;
      case 'KeyP':
      case 'Escape':
        if (!e.repeat) this.handlers.onTogglePause();
        break;
      case 'KeyR':
        if (!e.repeat) this.handlers.onRestart();
        break;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') this.left = false;
    if (e.code === 'ArrowRight' || e.code === 'KeyD') this.right = false;
  };

  private readonly onBlur = (): void => {
    this.left = false;
    this.right = false;
    this.touchId = null;
    this.handlers.onFocusLost();
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) this.onBlur();
  };
}

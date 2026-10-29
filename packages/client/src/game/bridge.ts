import type { FinishedRun } from '../progress/progressStore';

/** Commands React UI can send to the running scene. */
export interface SceneCommands {
  restart(): void;
  setPaused(paused: boolean): void;
  togglePause(): void;
}

/** Notifications from the scene to React. */
export interface BridgeListeners {
  /** A new run began (first load or restart). */
  onRunStarted?(): void;
  /** Called once per finished run (won or lost). */
  onRunFinished?(run: FinishedRun): void;
}

/**
 * Thin handle between React and Phaser. Calls made before the scene has
 * finished booting are ignored rather than queued.
 */
export class GameBridge implements SceneCommands {
  private target: SceneCommands | null = null;
  private listeners: BridgeListeners = {};

  connect(target: SceneCommands): void {
    this.target = target;
  }

  /** Only detaches if `target` is still the connected scene (StrictMode remounts overlap). */
  disconnect(target: SceneCommands): void {
    if (this.target === target) this.target = null;
  }

  /** Registers listeners; returns an unsubscribe function. */
  listen(listeners: BridgeListeners): () => void {
    this.listeners = listeners;
    return () => {
      if (this.listeners === listeners) this.listeners = {};
    };
  }

  restart(): void {
    this.target?.restart();
  }

  setPaused(paused: boolean): void {
    this.target?.setPaused(paused);
  }

  togglePause(): void {
    this.target?.togglePause();
  }

  runStarted(): void {
    this.listeners.onRunStarted?.();
  }

  runFinished(run: FinishedRun): void {
    this.listeners.onRunFinished?.(run);
  }
}

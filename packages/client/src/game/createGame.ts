import { SIM } from '@brick-riot/shared';
import Phaser from 'phaser';
import type { MatchNet } from '../net/matchNet';
import { MatchScene } from './MatchScene';
import { SoloScene, type SoloSceneOptions } from './SoloScene';

export interface CreateSoloGameOptions extends Omit<SoloSceneOptions, 'resolution'> {
  parent: HTMLElement;
}

function bootGame(parent: HTMLElement, makeScene: (resolution: number) => Phaser.Scene): Phaser.Game {
  // Render at 2x on high-DPI screens; 1x elsewhere keeps fill-rate low on weak devices.
  const resolution = window.devicePixelRatio >= 1.5 ? 2 : 1;
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: SIM.worldWidth * resolution,
    height: SIM.worldHeight * resolution,
    backgroundColor: '#0a0d1c',
    banner: false,
    disableContextMenu: true,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    render: {
      antialias: true,
      powerPreference: 'high-performance',
    },
    // Input is handled by InputController on DOM events; audio arrives in Phase 7.
    input: { keyboard: false, mouse: false, touch: false, gamepad: false },
    audio: { noAudio: true },
    scene: makeScene(resolution),
  });
}

export function createSoloGame({ parent, ...opts }: CreateSoloGameOptions): Phaser.Game {
  return bootGame(parent, (resolution) => new SoloScene({ ...opts, resolution }));
}

export interface CreateMatchGameOptions extends Omit<SoloSceneOptions, 'resolution'> {
  parent: HTMLElement;
  net: MatchNet;
}

export function createMatchGame({ parent, ...opts }: CreateMatchGameOptions): Phaser.Game {
  return bootGame(parent, (resolution) => new MatchScene({ ...opts, resolution }));
}

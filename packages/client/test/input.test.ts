import { describe, expect, it } from 'vitest';
import { clientToWorldX } from '../src/game/input';
import { formatTime } from '../src/state/hudStore';

describe('clientToWorldX', () => {
  it('maps the canvas rect onto world width', () => {
    const rect = { left: 100, width: 240 };
    expect(clientToWorldX(100, rect, 480)).toBe(0);
    expect(clientToWorldX(220, rect, 480)).toBe(240);
    expect(clientToWorldX(340, rect, 480)).toBe(480);
  });

  it('returns values outside the field for pointers outside the canvas (the sim clamps them)', () => {
    expect(clientToWorldX(0, { left: 100, width: 240 }, 480)).toBeLessThan(0);
  });

  it('falls back to centre for a zero-width rect', () => {
    expect(clientToWorldX(50, { left: 0, width: 0 }, 480)).toBe(240);
  });
});

describe('formatTime', () => {
  it('formats minutes, seconds and tenths', () => {
    expect(formatTime(0)).toBe('0:00.0');
    expect(formatTime(65_430)).toBe('1:05.4');
  });
});

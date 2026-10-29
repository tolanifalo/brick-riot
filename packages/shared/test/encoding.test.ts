import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards against text-encoding corruption (e.g. UTF-8 re-saved as ANSI turns
 * "·" into "Â·", and shell escapes inject control characters). This happened
 * once in Phase 2 and shipped unnoticed; this test keeps it from recurring.
 */
const ROOT = join(__dirname, '..', '..', '..');
const SCAN = ['packages/shared/src', 'packages/shared/test', 'packages/client/src', 'packages/client/e2e', 'packages/client/test', 'packages/server/src', 'packages/server/test'];
const EXTENSIONS = /\.(ts|tsx|css|md|html|json)$/;
const MOJIBAKE = /Ã.|Â[^\s]|â€|â†|ðŸ/;
/** Control characters other than tab, newline and carriage return. */
function hasControl(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) return true;
  }
  return false;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return EXTENSIONS.test(name) ? [path] : [];
  });
}

describe('text encoding', () => {
  const targets = [
    ...SCAN.flatMap((d) => files(join(ROOT, d))),
    ...readdirSync(ROOT).filter((n) => n.endsWith('.md')).map((n) => join(ROOT, n)),
  ].filter((p) => !p.endsWith('encoding.test.ts'));

  it('scans a meaningful number of files', () => {
    expect(targets.length).toBeGreaterThan(50);
  });

  it('has no mojibake or stray control characters in source and docs', () => {
    const problems: string[] = [];
    for (const path of targets) {
      readFileSync(path, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (MOJIBAKE.test(line) || hasControl(line)) problems.push(`${relative(ROOT, path)}:${i + 1}: ${line.trim().slice(0, 80)}`);
        });
    }
    expect(problems).toEqual([]);
  });
});

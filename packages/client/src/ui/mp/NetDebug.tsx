import { useEffect, useState } from 'react';
import { useMatch } from '../../net/matchStore';

/** Development builds only, and only when asked for (?netdebug or localStorage "brickriot:netdebug" = "1"). */
export function netDebugEnabled(): boolean {
  if (!(import.meta.env.DEV || import.meta.env.MODE === 'e2e')) return false;
  try {
    return new URLSearchParams(window.location.search).has('netdebug') || window.localStorage.getItem('brickriot:netdebug') === '1';
  } catch {
    return false;
  }
}

/**
 * Network diagnostics overlay: prediction lead, late inputs reported by the
 * server, checksum mismatches, resyncs, correction size and frame stalls.
 * Shows timing only: no session ids, tokens or account data.
 */
export function NetDebug() {
  const net = useMatch((s) => s.net);
  const [snap, setSnap] = useState(() => net?.diagnostics() ?? null);
  useEffect(() => {
    const id = setInterval(() => setSnap(net?.diagnostics() ?? null), 500);
    return () => clearInterval(id);
  }, [net]);
  if (!snap) return null;
  return (
    <pre className="net-debug" data-testid="net-debug" aria-label="Network diagnostics">
      {[
        `rtt ${snap.rttMs}ms  lead ${snap.leadTicks}t (+${snap.extraLeadTicks})`,
        `late(server) ${snap.lateReported}  margin ${snap.lastMargin ?? '-'}t`,
        `checks ${snap.checks}  mismatch ${snap.mismatches}  resync ${snap.resyncs}`,
        `correction ${snap.lastCorrection} (max ${snap.maxCorrection})  stalls ${snap.frameStalls}`,
        `late cmds ${snap.lateCommands}`,
        snap.server ? `server gap ${snap.server.maxLoopGapMs}ms  step ${snap.server.lastStepTicks}t  late ${snap.server.lateInputs}/${snap.server.inputs}` : 'server diag off',
      ].join('\n')}
    </pre>
  );
}

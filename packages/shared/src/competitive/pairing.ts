import { getMultiplayerProfile } from '../multiplayer/boards';
import { evaluateCompatibility, type CompatibilityReport } from '../multiplayer/compatibility';
import type { MatchResultVerification, QueueEntry } from './types';

export interface PairingPolicy {
  /** Max MMR gap, widened by both players' rating deviation. */
  baseSkillGap: number;
  /** Max difference in equipment power bands. */
  maxEquipmentBandGap: number;
  /** Players below this level only meet players below `beginnerCeiling`. */
  beginnerLevel: number;
  beginnerCeiling: number;
  /** Seconds in queue after which the skill window widens... */
  widenAfterSeconds: number;
  /** ...by this much per extra second, up to `maxSkillGap`. */
  widenPerSecond: number;
  maxSkillGap: number;
  matchSeconds: number;
}

export const DEFAULT_PAIRING_POLICY: PairingPolicy = {
  baseSkillGap: 150,
  maxEquipmentBandGap: 1,
  beginnerLevel: 5,
  beginnerCeiling: 10,
  widenAfterSeconds: 20,
  widenPerSecond: 5,
  maxSkillGap: 400,
  matchSeconds: 120,
};

export interface CriterionCheck {
  ok: boolean;
  detail: string;
}

/**
 * Each priority is checked independently. A pair is acceptable only if every
 * criterion passes; criteria are never traded off against each other.
 */
export interface PairingEvaluation {
  acceptable: boolean;
  skill: CriterionCheck;
  boards: CriterionCheck & { report: CompatibilityReport | null };
  equipment: CriterionCheck;
  beginner: CriterionCheck;
}

export function evaluatePairing(a: QueueEntry, b: QueueEntry, now: number, policy = DEFAULT_PAIRING_POLICY): PairingEvaluation {
  // 1. Skill: the allowed gap grows with uncertainty and with waiting time.
  const waited = Math.min(now - a.enqueuedAt, now - b.enqueuedAt) / 1000;
  const widen = Math.max(0, waited - policy.widenAfterSeconds) * policy.widenPerSecond;
  const allowedGap = Math.min(
    policy.maxSkillGap,
    policy.baseSkillGap + (a.rating.deviation + b.rating.deviation) / 2 + widen,
  );
  const gap = Math.abs(a.rating.mmr - b.rating.mmr);
  const skill = { ok: gap <= allowedGap, detail: `MMR gap ${Math.round(gap)} / allowed ${Math.round(allowedGap)}` };

  // 2. Boards: both preferred boards must be compatible AND ranked-calibrated.
  let boards: PairingEvaluation['boards'] = { ok: false, detail: 'no board chosen', report: null };
  const pa = a.preferredBoardId ? getMultiplayerProfile(a.preferredBoardId) : undefined;
  const pb = b.preferredBoardId ? getMultiplayerProfile(b.preferredBoardId) : undefined;
  if (pa && pb && a.verifiedBoardIds.includes(pa.boardId) && b.verifiedBoardIds.includes(pb.boardId)) {
    const report = evaluateCompatibility(pa, pb, policy.matchSeconds);
    boards = {
      ok: report.rankedEligible,
      detail: report.rankedEligible ? 'compatible and calibrated' : [...report.problems, ...report.warnings].join(' '),
      report,
    };
  }

  // 3. Equipment strength.
  const bandGap = Math.abs(a.equipment.band - b.equipment.band);
  const equipment = { ok: bandGap <= policy.maxEquipmentBandGap, detail: `equipment band gap ${bandGap}` };

  // 4. Beginner protection.
  const newbie = (e: QueueEntry) => e.experience.level < policy.beginnerLevel;
  const veteran = (e: QueueEntry) => e.experience.level >= policy.beginnerCeiling;
  const clash = (newbie(a) && veteran(b)) || (newbie(b) && veteran(a));
  const beginner = { ok: !clash, detail: clash ? 'beginner would face an experienced player' : 'ok' };

  return { acceptable: skill.ok && boards.ok && equipment.ok && beginner.ok, skill, boards, equipment, beginner };
}

export function verifyForRating(
  matchId: string,
  serverAuthoritative: boolean,
  replayVerified: boolean,
  bothIdentitiesVerified: boolean,
): MatchResultVerification {
  return {
    matchId,
    serverAuthoritative,
    replayVerified,
    bothIdentitiesVerified,
    ratingEligible: serverAuthoritative && replayVerified && bothIdentitiesVerified,
  };
}

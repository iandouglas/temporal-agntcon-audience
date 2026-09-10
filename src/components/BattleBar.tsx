"use client";

import type { Tally } from "../lib/types";

interface Props {
  tally: Tally;
}

/**
 * The tug-of-war between the two teams for one service.
 *
 * Share is votes out of total, so a 0-0 tie sits at the middle and the very
 * first vote swings it to one end. The spark rides the boundary, which makes
 * the contested point the brightest thing on the card.
 */
export function BattleBar({ tally }: Props) {
  const total = tally.breaks + tally.fixes;
  // A tie reads as an even split rather than as a divide-by-zero.
  const breakShare = total === 0 ? 0.5 : tally.breaks / total;
  const breakPct = Math.round(breakShare * 100);
  const fixPct = 100 - breakPct;

  return (
    <div className="battle" data-on={tally.on}>
      <div className="battle-track">
        <div className="battle-side battle-side--break" style={{ width: `${breakShare * 100}%` }} />
        <div className="battle-side battle-side--fix" style={{ width: `${(1 - breakShare) * 100}%` }} />
        <div className="battle-spark" style={{ left: `${breakShare * 100}%` }} aria-hidden="true">
          <span className="spark-core" />
          <span className="spark-halo" />
        </div>
      </div>
      <div className="battle-legend">
        <span className="legend legend--break">{breakPct}%</span>
        <span className="legend-state" data-on={tally.on}>
          {tally.on ? "UP" : "DOWN"}
        </span>
        <span className="legend legend--fix">{fixPct}%</span>
      </div>
    </div>
  );
}

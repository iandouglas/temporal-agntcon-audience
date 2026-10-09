"use client";

import type { Tally } from "../lib/types";

interface Props {
  tally: Tally;
}

/**
 * The tug-of-war between the two teams for one service.
 *
 * Breakers hold the left, fixers the right, and each end shows both its share
 * and its raw click count -- the count is what makes a stiff bar legible, since
 * late in a heavily-voted round the percentage barely moves but the numbers
 * still climb. Share is votes out of total, so a 0-0 tie sits in the middle and
 * the very first vote swings it to one end.
 *
 * This direction is shared with the stage screen's tug bar. If one flips, flip
 * the other in the same change -- a projector running the opposite way to the
 * handset in someone's hand is worse than either direction on its own.
 */
export function BattleBar({ tally }: Props) {
  const total = tally.breaks + tally.fixes;
  // A tie reads as an even split rather than as a divide-by-zero.
  const fixShare = total === 0 ? 0.5 : tally.fixes / total;
  const fixPct = Math.round(fixShare * 100);
  const breakPct = 100 - fixPct;

  return (
    <div className="battle" data-on={tally.on}>
      <div className="battle-track">
        <div className="battle-side battle-side--break" style={{ width: `${(1 - fixShare) * 100}%` }} />
        <div className="battle-side battle-side--fix" style={{ width: `${fixShare * 100}%` }} />
        <div className="battle-spark" style={{ left: `${(1 - fixShare) * 100}%` }} aria-hidden="true">
          <span className="spark-core" />
          <span className="spark-halo" />
        </div>
      </div>
      <div className="battle-legend">
        {/* Percentages stay on the outer edges and the counts on the inside,
            so the two numbers a thumb is chasing sit furthest apart. */}
        <span className="legend legend--break">
          {breakPct}% <span className="legend-count">({tally.breaks} breaks)</span>
        </span>
        <span className="legend-state" data-on={tally.on}>
          {tally.on ? "UP" : "DOWN"}
        </span>
        <span className="legend legend--fix">
          <span className="legend-count">({tally.fixes} fixes)</span> {fixPct}%
        </span>
      </div>
    </div>
  );
}

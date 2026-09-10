"use client";

import type { PublicService, Role, Tally } from "../lib/types";
import { BattleBar } from "./BattleBar";

interface Props {
  service: PublicService;
  tally: Tally;
  role: Role;
  disabled: boolean;
  onVote: () => void;
}

/**
 * One service: its name, the tug-of-war bar, and the single button this
 * viewer's team gets. Breakers only ever see BREAK, fixers only ever see FIX --
 * you are on a side, and the button is the only move you have.
 */
export function ServiceCard({ service, tally, role, disabled, onVote }: Props) {
  const breaking = role === "breaker";

  return (
    <div className={`card${service.kind === "mcp" ? " card--mcp" : ""}`}>
      <p className="card-name">{service.name}</p>
      <BattleBar tally={tally} />
      <button
        type="button"
        className="vote"
        data-role={role}
        disabled={disabled}
        onClick={onVote}
        aria-label={`${breaking ? "Break" : "Fix"} ${service.name}`}
      >
        {breaking ? "BREAK" : "FIX"}
      </button>
    </div>
  );
}

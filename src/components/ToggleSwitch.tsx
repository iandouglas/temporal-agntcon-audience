"use client";

import type { PublicService } from "../lib/types";

interface Props {
  service: PublicService;
  on: boolean;
  onToggle: (value: boolean) => void;
}

/**
 * One labelled switch.
 *
 * `role="switch"` plus `aria-checked` gives screen readers the state; the OFF/ON
 * words are decorative for assistive tech (the accessible name carries the same
 * information) so they are hidden from it to avoid reading the label twice.
 */
export function ToggleSwitch({ service, on, onToggle }: Props) {
  return (
    <div className={`card${service.kind === "mcp" ? " card--mcp" : ""}`}>
      <p className="card-name">{service.name}</p>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={service.name}
        data-on={on}
        className="switch"
        onClick={() => onToggle(!on)}
      >
        <span className="lbl lbl--off" aria-hidden="true">
          OFF
        </span>
        <span className="track">
          <span className="knob" />
        </span>
        <span className="lbl lbl--on" aria-hidden="true">
          ON
        </span>
      </button>
    </div>
  );
}

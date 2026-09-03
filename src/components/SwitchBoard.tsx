"use client";

import { useSwitchboard } from "../hooks/useSwitchboard";
import type { PublicService } from "../lib/types";
import { ToggleSwitch } from "./ToggleSwitch";

interface Props {
  services: PublicService[];
  title: string;
  subtitle: string;
}

export function SwitchBoard({ services, title, subtitle }: Props) {
  const { state, ready, connected, armed, toggle } = useSwitchboard(services);
  const live = ready && connected;
  const interactive = live && armed;

  const status = !connected
    ? "reconnecting…"
    : !ready
      ? "syncing…"
      : armed
        ? "live"
        : "waiting for the demo to start";

  const mcp = services.filter((service) => service.kind === "mcp");
  const apis = services.filter((service) => service.kind === "api");

  return (
    <main className="board" data-ready={live} data-armed={armed}>
      <header className="head">
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </header>

      <section className="tier-mcp">
        {mcp.map((service) => (
          <ToggleSwitch
            key={service.id}
            service={service}
            on={state[service.id] ?? false}
            disabled={!interactive}
            onToggle={(value) => toggle(service.id, value)}
          />
        ))}
      </section>

      <div className="divider" role="presentation" />

      <section className="grid">
        {apis.map((service) => (
          <ToggleSwitch
            key={service.id}
            service={service}
            on={state[service.id] ?? false}
            disabled={!interactive}
            onToggle={(value) => toggle(service.id, value)}
          />
        ))}
      </section>

      <p className="foot" data-warn={!connected} aria-live="polite">
        {status}
      </p>
    </main>
  );
}

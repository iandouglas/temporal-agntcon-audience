"use client";

import { useSwitchboard } from "../hooks/useSwitchboard";
import type { PublicService } from "../lib/types";
import { ServiceCard } from "./ServiceCard";

interface Props {
  services: PublicService[];
  title: string;
  subtitle: string;
}

export function SwitchBoard({ services, title, subtitle }: Props) {
  const { tallies, names, role, ready, connected, armed, orders, vote } = useSwitchboard(services);
  const live = ready && connected;
  const interactive = live && armed;

  const status = !connected
    ? "reconnecting…"
    : !ready
      ? "syncing…"
      : armed
        ? "live"
        : "waiting for the demo to start";

  /* Drives the glow: only the pre-demo wait pulses. */
  const statusState = !connected ? "down" : !ready ? "syncing" : armed ? "live" : "waiting";

  /*
   * The top tier is the agent's own plumbing -- its worker process and its
   * link to the MCP server -- and the grid below is the four APIs behind it.
   * Filtering for "mcp" alone used to be the same thing; now that the worker
   * exists, a kind missing from both lists renders nowhere at all.
   */
  const path = services.filter((service) => service.kind === "worker" || service.kind === "mcp");
  const apis = services.filter((service) => service.kind === "api");

  return (
    <main className="board" data-ready={live} data-armed={armed} data-role={role}>
      <header className="head">
        <h1>{title}</h1>
        <p>{subtitle}</p>
        <p className="status" data-state={statusState} aria-live="polite">
          {status}
        </p>
        <p className="role-badge" data-role={role}>
          <strong>You are a {role}:</strong>{" "}
          <span className="role-hint">
            {role === "fixer" ? "help keep things online!" : "help take the systems offline!"}
          </span>
        </p>
      </header>

      {/*
        * The backlog, in everyone's hand rather than only on the projector.
        * The gap between the two numbers is the argument the demo is making,
        * so it is worth showing to the people creating it.
        *
        * Rendered only once real numbers have arrived: no stage screen
        * configured, or none reachable yet, and the row stays away entirely.
        * A permanent 0 / 0 reads as "nothing is happening" during the exact
        * beat where plenty is.
        */}
      {orders ? (
        <section className="orders" aria-live="polite">
          <div className="orders-cell">
            <span className="orders-n" data-busy={orders.queued > 0}>
              {orders.queued.toLocaleString()}
            </span>
            <span className="orders-k">queued</span>
          </div>
          <div className="orders-cell">
            <span className="orders-n">{orders.completed.toLocaleString()}</span>
            <span className="orders-k">fulfilled</span>
          </div>
        </section>
      ) : null}

      <section className="tier-mcp">
        {path.map((service) => (
          <ServiceCard
            key={service.id}
            service={{ ...service, name: names[service.id] ?? service.name }}
            tally={tallies[service.id] ?? { breaks: 0, fixes: 0, on: true }}
            role={role}
            disabled={!interactive}
            onVote={() => vote(service.id)}
          />
        ))}
      </section>

      <div className="divider" role="presentation" />

      <section className="grid">
        {apis.map((service) => (
          <ServiceCard
            key={service.id}
            service={{ ...service, name: names[service.id] ?? service.name }}
            tally={tallies[service.id] ?? { breaks: 0, fixes: 0, on: true }}
            role={role}
            disabled={!interactive}
            onVote={() => vote(service.id)}
          />
        ))}
      </section>

    </main>
  );
}

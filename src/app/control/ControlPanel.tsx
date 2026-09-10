"use client";

import { useEffect, useState } from "react";
import { useSwitchboard } from "../../hooks/useSwitchboard";
import { ToggleSwitch } from "../../components/ToggleSwitch";
import type { DispatchResult, PublicService } from "../../lib/types";

/** Not a real service -- it drives the audience gate, not an endpoint. */
const AUDIENCE_GATE: PublicService = {
  id: "__gate",
  name: "AUDIENCE CONTROLS",
  kind: "mcp",
};

interface Props {
  services: PublicService[];
  token: string;
}

function describe(result: DispatchResult | null | undefined): string {
  if (!result) return "no call yet";
  const when = new Date(result.at).toLocaleTimeString();
  if (result.error) return `/${result.path} → ${result.error} (${result.ms}ms) ${when}`;
  return `/${result.path} → ${result.status} (${result.ms}ms) ${when}`;
}

export function ControlPanel({ services, token }: Props) {
  const { state, names, connected, armed, stats, force, arm, resetCounters, setName } = useSwitchboard(
    services,
    { control: true, token },
  );

  // Local edit buffer, so typing is not fought by incoming name broadcasts.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const [id, name] of Object.entries(names)) {
        if (id !== editing && next[id] !== name) next[id] = name;
      }
      return next;
    });
  }, [names, editing]);

  function commitName(id: string): void {
    const value = (drafts[id] ?? "").trim();
    setEditing(null);
    if (value && value !== names[id]) setName(id, value);
  }
  const [reseeding, setReseeding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const totalTaps = Object.values(stats?.taps ?? {}).reduce((sum, n) => sum + n, 0);

  /**
   * The reset: drive every service to the same position and take the board with
   * it. Re-asserting a position a service already holds still fires its POST, so
   * this corrects drift rather than merely agreeing with it.
   */
  function setAll(value: boolean): void {
    for (const service of services) force(service.id, value);
  }

  async function reseed(): Promise<void> {
    if (!window.confirm("Wipe stored state and re-read /health on every service?")) return;
    setReseeding(true);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/reseed", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      setNotice(body.ok ? "re-seeded from /health" : `failed: ${body.error ?? res.status}`);
    } catch (err) {
      setNotice(`failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReseeding(false);
    }
  }

  return (
    <main className="control">
      <h1>Control</h1>
      <p className="control-sub">
        {connected ? "connected" : "reconnecting…"}
        {notice ? ` · ${notice}` : ""}
      </p>

      <div className="ctl-gate">
        <ToggleSwitch service={AUDIENCE_GATE} on={armed} onToggle={arm} />
        <p className="ctl-note ctl-note--tight">
          {armed
            ? "The floor is open — all five switches are live on every phone."
            : "The audience can see the board but cannot change anything. Blocked on the server, not just greyed out."}
        </p>
      </div>

      <div className="ctl-bulk">
        <button type="button" className="btn btn--bulk" onClick={() => setAll(true)}>
          ALL ON
        </button>
        <button type="button" className="btn btn--bulk" onClick={() => setAll(false)}>
          ALL OFF
        </button>
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="stat-k">Connected</div>
          <div className="stat-v">{stats?.conns ?? "—"}</div>
        </div>
        <div className="stat">
          <div className="stat-k">Total taps</div>
          <div className="stat-v">{stats ? totalTaps : "—"}</div>
        </div>
        <div className="stat">
          <div className="stat-k">Toggles on</div>
          <div className="stat-v">{Object.values(state).filter(Boolean).length}</div>
        </div>
        <div className="stat" data-bad={stats ? !stats.bus.healthy : false}>
          <div className="stat-k">Bus ({stats?.bus.kind ?? "—"})</div>
          <div className="stat-v">{stats ? (stats.bus.healthy ? "OK" : "DEGRADED") : "—"}</div>
        </div>
      </div>

      <button type="button" className="btn btn--counters" onClick={resetCounters}>
        RESET COUNTERS
      </button>

      {stats && !stats.bus.healthy ? (
        <p className="ctl-alert">
          Redis is unreachable. Switches still work and every phone connected to
          this replica still updates — but replicas will drift apart until it is
          back. {stats.bus.failures} failed write{stats.bus.failures === 1 ? "" : "s"}.
        </p>
      ) : null}

      {services.map((service) => {
        const on = state[service.id] ?? false;
        const last = stats?.dispatch?.[service.id];
        return (
          <div className="ctl-service" key={service.id}>
            <div className="ctl-name">
              <input
                className="ctl-rename"
                value={drafts[service.id] ?? names[service.id] ?? service.name}
                aria-label={`Rename ${names[service.id] ?? service.name}`}
                maxLength={40}
                onFocus={() => setEditing(service.id)}
                onChange={(e) => setDrafts((d) => ({ ...d, [service.id]: e.target.value }))}
                onBlur={() => commitName(service.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    setDrafts((d) => ({ ...d, [service.id]: names[service.id] ?? service.name }));
                    setEditing(null);
                    e.currentTarget.blur();
                  }
                }}
              />
              {service.kind === "mcp" ? <span className="ctl-tag">mcp</span> : null}
            </div>
            <div className="ctl-buttons">
              <button type="button" className="btn" data-active={!on} onClick={() => force(service.id, false)}>
                OFF
              </button>
              <button type="button" className="btn" data-active={on} onClick={() => force(service.id, true)}>
                ON
              </button>
            </div>
            <div className="ctl-meta" data-bad={Boolean(last && !last.ok)}>
              {stats?.taps?.[service.id] ?? 0} taps · {describe(last)}
            </div>
          </div>
        );
      })}

      <p className="ctl-note">
        Reseed adopts whatever the services currently report — it makes the board
        agree with them, it does not change them. To reset the demo, use ALL ON /
        ALL OFF above, which drives the services instead.
      </p>
      <button type="button" className="btn btn--wide btn--quiet" onClick={() => void reseed()} disabled={reseeding}>
        {reseeding ? "RE-SEEDING…" : "RESEED FROM /HEALTH"}
      </button>
    </main>
  );
}

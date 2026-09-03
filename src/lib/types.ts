/** A toggle's identity. `mcp` is the agent<->MCP connection; the rest are the APIs it calls. */
export type ToggleKind = "mcp" | "api";

/** Server-side view of a toggle. `baseUrl` MUST NOT be sent to the browser. */
export interface ServiceConfig {
  id: string;
  name: string;
  kind: ToggleKind;
  /** Base URL with any trailing slash stripped. Undefined when the env var is missing. */
  baseUrl?: string;
}

/** The subset of a service that is safe to render in the browser. */
export interface PublicService {
  id: string;
  name: string;
  kind: ToggleKind;
}

/** Current position of every toggle, keyed by service id. */
export type StateMap = Record<string, boolean>;

/** Outcome of one outbound POST to a service's /on or /off endpoint. */
export interface DispatchResult {
  id: string;
  path: "on" | "off";
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
  at: number;
}

/** Events replicated between replicas over the bus. */
export type BusEvent =
  | { t: "state"; id: string; v: boolean; ts: number }
  | { t: "armed"; v: boolean; ts: number }
  | { t: "full"; state: StateMap; ts: number }
  | { t: "dispatch"; r: DispatchResult }
  | { t: "taps"; delta: Record<string, number> }
  | { t: "conns"; replica: string; n: number; ts: number };

/** Health of the shared bus, surfaced to the operator. */
export interface BusStatus {
  kind: string;
  healthy: boolean;
  failures: number;
  lastError: string | null;
}

/** Browser -> server. */
export type ClientMessage =
  | { t: "toggle"; id: string; v: boolean }
  | { t: "force"; id: string; v: boolean }
  | { t: "arm"; v: boolean }
  | { t: "ping" };

/** Server -> browser. */
export type ServerMessage =
  | { t: "hello"; state: StateMap; armed: boolean; ts: number }
  | { t: "state"; id: string; v: boolean; ts: number }
  | { t: "armed"; v: boolean; ts: number }
  | { t: "full"; state: StateMap; ts: number }
  | {
      t: "stats";
      conns: number;
      taps: Record<string, number>;
      dispatch: Record<string, DispatchResult | null>;
      bus: BusStatus;
    }
  | { t: "pong" };

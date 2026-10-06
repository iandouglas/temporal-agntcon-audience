/**
 * A toggle's identity.
 *
 * `worker` is the agent's own process: the audience votes it down and the
 * worker kills itself after reading `/chaos`. Nothing is dispatched to it,
 * which is why it is a kind of its own rather than an `api` with no URL.
 */
export type ToggleKind = "mcp" | "api" | "worker";

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

/**
 * One switch as the admin REST endpoint reports it.
 *
 * Both fields on purpose. The stage screen reads `up` and ignores the
 * percentage; the agent worker's watchdog reads `percent` and ignores `up`.
 * `health()` guarantees they never contradict each other.
 */
export interface HealthValue {
  up: boolean;
  percent: number;
}

export type HealthMap = Record<string, HealthValue>;

/** Which side of the tug-of-war a viewer is on. Assigned once, kept in a cookie. */
export type Role = "breaker" | "fixer";

/**
 * The vote tally for one service.
 *
 * `on` is derived, never stored: the service is up while the fixers hold at
 * least half the vote. Fixer share >= 50% reduces to `fixes >= breaks`, so the
 * whole rule is one integer comparison and a 0-0 tie starts the service up.
 */
export interface Tally {
  breaks: number;
  fixes: number;
  on: boolean;
}

export type TallyMap = Record<string, Tally>;

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
  | { t: "names"; names: Record<string, string>; ts: number }
  | { t: "full"; state: StateMap; ts: number }
  | { t: "dispatch"; r: DispatchResult }
  | { t: "taps"; delta: Record<string, number>; ts: number }
  | { t: "votes"; replica: string; delta: Record<string, { breaks: number; fixes: number }>; ts: number }
  | { t: "reset-counters"; ts: number }
  | { t: "names"; names: Record<string, string>; ts: number }
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
  | { t: "vote"; id: string }
  | { t: "set-name"; id: string; name: string }
  | { t: "reset-counters" }
  | { t: "ping" };

/** Server -> browser. */
export type ServerMessage =
  | {
      t: "hello";
      state: StateMap;
      tallies: TallyMap;
      names: Record<string, string>;
      role: Role;
      armed: boolean;
      ts: number;
    }
  | { t: "tallies"; tallies: TallyMap; ts: number }
  | { t: "names"; names: Record<string, string>; ts: number }
  | { t: "state"; id: string; v: boolean; ts: number }
  | { t: "armed"; v: boolean; ts: number }
  | { t: "names"; names: Record<string, string>; ts: number }
  | { t: "full"; state: StateMap; ts: number }
  | {
      t: "stats";
      conns: number;
      taps: Record<string, number>;
      dispatch: Record<string, DispatchResult | null>;
      bus: BusStatus;
    }
  | { t: "pong" };

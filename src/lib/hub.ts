import { randomUUID } from "node:crypto";
import type { Bus } from "./bus";
import { createBus } from "./bus";
import { getServices, redisUrl, validateServices } from "./config";
import { dispatchToggle, probeAll } from "./dispatch";
import { TokenBucket } from "./ratelimit";
import type {
  BusEvent,
  BusStatus,
  DispatchResult,
  Role,
  Tally,
  TallyMap,
  ServerMessage,
  ServiceConfig,
  StateMap,
} from "./types";

/** How long a booting replica waits for whoever won the seed lock. */
const SEED_WAIT_MS = 15_000;
const SEED_POLL_MS = 400;
const SEED_LOCK_TTL_SECONDS = 30;

/** Tap counts are noisy; batch them rather than publishing per tap. */
const TAP_FLUSH_MS = 500;
const CONN_HEARTBEAT_MS = 3000;

export interface Client {
  /** True for the token-gated /control page, which receives stats as well as state. */
  control: boolean;
  /** Which team this viewer votes for. Operators get a role too; they never vote. */
  role: Role;
  bucket: TokenBucket;
  send(message: ServerMessage): void;
  close(): void;
}

/**
 * Owns the toggle state and every connected socket on this replica.
 *
 * State changes always travel out through the bus and come back in, even when
 * they originated here. That single path means every replica applies changes in
 * the same order and no code path can update local state without telling the
 * others.
 */
export class Hub {
  readonly replicaId = process.env.RAILWAY_REPLICA_ID?.slice(0, 8) ?? randomUUID().slice(0, 8);
  readonly services: ServiceConfig[] = getServices();

  private bus!: Bus;
  private state: StateMap = {};
  /**
   * Whether the audience may drive the switches. Defaults to locked: a phone
   * that scans the QR code early must not be able to touch anything before the
   * operator opens the floor.
   */
  private armed = false;
  private taps: Record<string, number> = {};
  private pendingTaps: Record<string, number> = {};
  private lastDispatch: Record<string, DispatchResult | null> = {};
  private peerConns = new Map<string, { n: number; ts: number }>();
  /**
   * When counters were last reset. Events stamped before this are dropped:
   * a dispatch result or tap delta already in flight when the operator pressed
   * reset would otherwise land afterwards and repopulate what was just cleared.
   */
  private countersResetAt = 0;
  private busFailures = 0;
  private lastBusError: string | null = null;
  private clients = new Set<Client>();

  /**
   * Vote tallies per service. Memory is the source of truth -- this runs as a
   * single replica -- and Redis is a write-behind copy so a restart recovers.
   */
  private tallies: TallyMap = {};
  private pendingVotes: Record<string, { breaks: number; fixes: number }> = {};
  /** Round-robin cursor, so the teams stay balanced instead of randomly lopsided. */
  private roleCursor = 0;

  /**
   * Display names, live-editable without a redeploy.
   *
   * Redis wins whenever it holds a name; the env var is only the seed for one
   * that has never been set. Editing would be pointless otherwise -- a restart
   * would quietly put the old name back.
   */
  private names: Record<string, string> = {};
  private timers: NodeJS.Timeout[] = [];

  private byId(id: string): ServiceConfig | undefined {
    return this.services.find((service) => service.id === id);
  }

  /**
   * Replicate an event through the bus, falling back to this replica alone.
   *
   * Redis is how replicas agree on ordering, but it is not allowed to be a
   * single point of failure during a live demo. If it is unreachable we still
   * serve our own clients, so the room keeps working -- replicas may diverge
   * until Redis returns, at which point `resyncAfterOutage` pushes local state
   * back out.
   */
  private async replicate(event: BusEvent, write?: () => Promise<void>): Promise<void> {
    try {
      if (write) await write();
      await this.bus.publish(event);
    } catch (err) {
      this.busFailures += 1;
      const message = err instanceof Error ? err.message : String(err);
      if (this.lastBusError !== message) {
        this.lastBusError = message;
        console.error(`[bus] degraded, serving local clients only: ${message}`);
      }
      this.applyBusEvent(event);
    }
  }

  /** True when the bus is healthy enough to keep replicas in step. */
  busHealthy(): boolean {
    return this.bus.connected;
  }

  busStatus(): BusStatus {
    return {
      kind: this.bus.kind,
      healthy: this.bus.connected,
      failures: this.busFailures,
      lastError: this.lastBusError,
    };
  }

  /**
   * Redis came back. Local state is the truth -- it absorbed every tap during
   * the outage, while the stored copy is frozen at the moment Redis died.
   */
  private async resyncAfterOutage(attempt = 1): Promise<void> {
    try {
      await this.bus.putState(this.state);
      await this.bus.setArmed(this.armed);
      await this.bus.publish({ t: "full", state: this.getState(), ts: Date.now() });
      await this.bus.publish({ t: "armed", v: this.armed, ts: Date.now() });
      this.lastBusError = null;
      console.log("[bus] recovered, pushed local state back to Redis");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < 3) {
        setTimeout(() => void this.resyncAfterOutage(attempt + 1), 1000 * attempt);
        return;
      }
      console.error(`[bus] resync failed after ${attempt} attempts: ${message}`);
    }
  }

  async start(): Promise<void> {
    for (const service of this.services) {
      this.state[service.id] = false;
      this.taps[service.id] = 0;
      this.lastDispatch[service.id] = null;
      this.tallies[service.id] = { breaks: 0, fixes: 0, on: true };
    }

    const problems = validateServices(this.services);
    for (const problem of problems) console.warn(`[config] ${problem}`);
    if (problems.length === 0) {
      console.log(`[config] all ${this.services.length} service URLs look well-formed`);
    }

    this.bus = await createBus(redisUrl());
    this.bus.subscribe((event) => this.applyBusEvent(event));
    this.bus.onReconnect(() => void this.resyncAfterOutage());
    await this.seed();

    this.timers.push(setInterval(() => void this.flushTaps(), TAP_FLUSH_MS));
    this.timers.push(setInterval(() => void this.announceConns(), CONN_HEARTBEAT_MS));
    this.timers.push(setInterval(() => this.broadcastStats(), 1000));
    // 10Hz is smoother than the eye needs and costs each phone ~10 frames a
    // second instead of one per vote from the whole room.
    this.timers.push(setInterval(() => this.broadcastTallies(), 100));
  }

  /**
   * Decide this replica's starting state.
   *
   * If the bus already holds state, the audience has been tapping and that state
   * is authoritative -- adopt it and do not touch /health, or a restarting
   * replica would drag every switch back to whatever the services report and
   * discard the crowd's work. Only a genuinely cold start seeds from /health.
   */
  private async seed(): Promise<void> {
    await this.seedArmed();
    await this.seedNames();

    const existing = await this.bus.getState().catch(() => null);
    if (existing) {
      this.mergeState(existing);
      console.log(`[seed] adopted existing state from ${this.bus.kind}:`, this.state);
      return;
    }

    const won = await this.bus.acquireSeedLock(SEED_LOCK_TTL_SECONDS).catch(() => true);
    if (!won) {
      const deadline = Date.now() + SEED_WAIT_MS;
      while (Date.now() < deadline) {
        await sleep(SEED_POLL_MS);
        const seeded = await this.bus.getState().catch(() => null);
        if (seeded) {
          this.mergeState(seeded);
          console.log("[seed] adopted state seeded by another replica:", this.state);
          return;
        }
      }
      console.warn("[seed] timed out waiting for the seeding replica -- seeding from /health anyway.");
    }

    console.log("[seed] cold start -- probing /health on every service");
    const probed = await probeAll(this.services);
    this.mergeState(probed);
    await this.replicate({ t: "full", state: { ...this.state }, ts: Date.now() }, async () => {
      await this.bus.putState(this.state);
    });
    await this.bus.releaseSeedLock().catch(() => undefined);
    console.log("[seed] seeded from /health:", this.state);
  }

  /**
   * Read the audience gate, defaulting to locked when it has never been set.
   * A restarting replica adopts whatever the operator last chose, so a redeploy
   * mid-demo does not silently lock the room out.
   */
  private async seedArmed(): Promise<void> {
    const stored = await this.bus.getArmed().catch(() => null);
    if (stored === null) {
      this.armed = false;
      await this.bus.setArmed(false).catch(() => undefined);
      console.log("[seed] audience controls default to LOCKED");
      return;
    }
    this.armed = stored;
    console.log(`[seed] audience controls are ${stored ? "UNLOCKED" : "LOCKED"}`);
  }

  /** Anything Redis already knows about wins over the env var. */
  private async seedNames(): Promise<void> {
    const stored = await this.bus.getNames().catch(() => ({}) as Record<string, string>);
    for (const service of this.services) {
      if (stored[service.id]) this.names[service.id] = stored[service.id];
    }
    const overridden = Object.keys(this.names).length;
    if (overridden > 0) console.log(`[names] ${overridden} name(s) loaded from ${this.bus.kind}`);
  }

  isArmed(): boolean {
    return this.armed;
  }

  /** Open or close the floor. Operator action only. */
  async setArmed(value: boolean): Promise<void> {
    this.armed = value;
    await this.replicate({ t: "armed", v: value, ts: Date.now() }, () => this.bus.setArmed(value));
    console.log(`[arm] audience controls ${value ? "UNLOCKED" : "LOCKED"}`);
  }

  /**
   * Zero the tap counts and last-call history on every replica.
   *
   * Counters are in memory only, so this is not persisted -- it exists so the
   * operator page shows the keynote's numbers rather than the rehearsal's.
   * Toggle positions are deliberately untouched.
   */
  async resetCounters(): Promise<void> {
    // Drop pending deltas first, or an in-flight flush re-adds them.
    this.pendingTaps = {};
    this.countersResetAt = Date.now();
    await this.replicate({ t: "reset-counters", ts: this.countersResetAt });
    console.log("[counters] reset");
  }

  /**
   * Back to a clean 0-0 on every service, which is a tie, which means up.
   *
   * The tally is the board's source of truth, so a reset cannot leave a bar
   * showing 50% while the service behind it is still down -- anything that is
   * down gets driven back up. This is also what un-sticks a bar that has gone
   * rigid after thousands of votes.
   */
  private applyCounterReset(): void {
    this.pendingTaps = {};
    this.pendingVotes = {};
    for (const service of this.services) {
      this.taps[service.id] = 0;
      this.lastDispatch[service.id] = null;
      this.tallies[service.id] = { breaks: 0, fixes: 0, on: true };

      if (this.state[service.id] !== true) {
        this.state[service.id] = true;
        void this.fireAndRecord(service, true);
        this.broadcast({ t: "state", id: service.id, v: true, ts: Date.now() });
        void this.replicate({ t: "state", id: service.id, v: true, ts: Date.now() }, () =>
          this.bus.setField(service.id, true),
        );
      }
    }
    this.broadcast({ t: "tallies", tallies: this.getTallies(), ts: Date.now() });
  }

  /** Wipe the stored state and re-seed from /health. Used by the operator reseed. */
  async reseed(): Promise<StateMap> {
    await this.bus.clearState().catch(() => undefined);
    await this.bus.releaseSeedLock().catch(() => undefined);
    const probed = await probeAll(this.services);
    for (const service of this.services) this.state[service.id] = probed[service.id] ?? false;
    await this.replicate({ t: "full", state: { ...this.state }, ts: Date.now() }, async () => {
      await this.bus.putState(this.state);
    });
    console.log("[reseed] re-seeded from /health:", this.state);
    return { ...this.state };
  }

  /** Align the opening tallies with whatever state we seeded from. */
  private syncTalliesToState(): void {
    for (const service of this.services) {
      const on = this.state[service.id] ?? true;
      const t = this.tallies[service.id] ?? { breaks: 0, fixes: 0, on };
      if (Hub.isOn(t) !== on) {
        // One phantom vote so the derived state matches reality at t=0.
        if (on) t.fixes = t.breaks;
        else t.breaks = t.fixes + 1;
      }
      t.on = on;
      this.tallies[service.id] = t;
    }
  }

  private mergeState(incoming: StateMap): void {
    for (const service of this.services) {
      this.state[service.id] = incoming[service.id] ?? this.state[service.id] ?? false;
    }
  }

  /** A 0-0 tie counts as fixers holding half the vote, so services start up. */
  private static isOn(t: { breaks: number; fixes: number }): boolean {
    return t.fixes >= t.breaks;
  }

  getNames(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const service of this.services) out[service.id] = this.names[service.id] ?? service.name;
    return out;
  }

  /** Rename a service for everyone, immediately, with no redeploy. */
  async setName(id: string, name: string): Promise<boolean> {
    const service = this.byId(id);
    const trimmed = name.trim();
    if (!service || trimmed === "" || trimmed.length > 40) return false;
    this.names[id] = trimmed;

    /*
     * Replicate rather than broadcast locally. A rename that only reaches the
     * replica which handled the request leaves every phone on the other
     * replicas showing the old name until they restart -- which is exactly what
     * happened the first time this shipped.
     */
    await this.replicate({ t: "names", names: this.getNames(), ts: Date.now() }, () =>
      this.bus.setName(id, trimmed),
    );
    return true;
  }

  getTallies(): TallyMap {
    const out: TallyMap = {};
    for (const service of this.services) {
      const t = this.tallies[service.id] ?? { breaks: 0, fixes: 0, on: true };
      out[service.id] = { breaks: t.breaks, fixes: t.fixes, on: t.on };
    }
    return out;
  }

  /** Hands out breaker/fixer alternately. Callers persist it in a cookie. */
  nextRole(): Role {
    const role: Role = this.roleCursor % 2 === 0 ? "breaker" : "fixer";
    this.roleCursor += 1;
    return role;
  }

  /**
   * One audience vote.
   *
   * The tally always moves. The outbound POST fires only when the derived state
   * actually flips, which is what keeps a room full of tapping thumbs from
   * turning into hundreds of calls a second.
   */
  async vote(id: string, role: Role, options: { bucket?: TokenBucket } = {}): Promise<void> {
    const service = this.byId(id);
    if (!service) return;
    if (!this.armed) return;
    if (options.bucket && !options.bucket.take()) return;

    const current = this.tallies[id] ?? { breaks: 0, fixes: 0, on: true };
    const next: Tally = {
      breaks: current.breaks + (role === "breaker" ? 1 : 0),
      fixes: current.fixes + (role === "fixer" ? 1 : 0),
      on: true,
    };
    next.on = Hub.isOn(next);
    this.tallies[id] = next;

    const bucket = (this.pendingVotes[id] ??= { breaks: 0, fixes: 0 });
    if (role === "breaker") bucket.breaks += 1;
    else bucket.fixes += 1;

    this.pendingTaps[id] = (this.pendingTaps[id] ?? 0) + 1;

    if (next.on !== current.on) {
      // The vote crossed the line. This is the only path that calls a service.
      this.state[id] = next.on;
      void this.fireAndRecord(service, next.on);
      this.broadcast({ t: "state", id, v: next.on, ts: Date.now() });
      await this.replicate({ t: "state", id, v: next.on, ts: Date.now() }, () =>
        this.bus.setField(id, next.on),
      );
    }
  }

  /** Throttled tally frame. One snapshot beats hundreds of deltas. */
  private broadcastTallies(): void {
    if (Object.keys(this.pendingVotes).length === 0) return;
    this.pendingVotes = {};
    this.broadcast({ t: "tallies", tallies: this.getTallies(), ts: Date.now() });
  }

  getState(): StateMap {
    return { ...this.state };
  }

  /**
   * Handle a tap.
   *
   * The state change and the outbound POST are deliberately independent: the
   * switch moves for everyone regardless of whether the backend answers, and the
   * rate limiter suppresses only the POST. A throttled client still sees, and
   * still shares, a responsive UI.
   */
  async toggle(id: string, value: boolean, options: { operator: boolean; bucket?: TokenBucket }): Promise<void> {
    const service = this.byId(id);
    if (!service) return;

    // The gate is enforced here, not just in the UI. A greyed-out switch stops
    // an honest phone; this stops a console.
    if (!options.operator && !this.armed) return;

    this.pendingTaps[id] = (this.pendingTaps[id] ?? 0) + 1;

    const allowed = options.operator || (options.bucket?.take() ?? true);
    if (allowed) {
      void this.fireAndRecord(service, value);
    }

    this.state[id] = value;

    /*
     * An operator force has to move the bar too, or the board shows UP while
     * the service is down. Nudge the tally to the smallest arrangement that
     * derives the forced value, which keeps the vote totals meaningful instead
     * of wiping them: a tie reads as up, one break ahead reads as down.
     */
    if (options.operator) {
      const t = this.tallies[id] ?? { breaks: 0, fixes: 0, on: value };
      if (value) t.fixes = Math.max(t.fixes, t.breaks);
      else t.breaks = Math.max(t.breaks, t.fixes + 1);
      t.on = value;
      this.tallies[id] = t;
      this.broadcast({ t: "tallies", tallies: this.getTallies(), ts: Date.now() });
    }

    await this.replicate({ t: "state", id, v: value, ts: Date.now() }, () =>
      this.bus.setField(id, value),
    );
  }

  private async fireAndRecord(service: ServiceConfig, value: boolean): Promise<void> {
    const result = await dispatchToggle(service, value);
    if (!result) return;
    this.lastDispatch[service.id] = result;
    await this.replicate({ t: "dispatch", r: result });
  }

  private applyBusEvent(event: BusEvent): void {
    switch (event.t) {
      case "state":
        this.state[event.id] = event.v;
        this.broadcast({ t: "state", id: event.id, v: event.v, ts: event.ts });
        break;
      case "armed":
        this.armed = event.v;
        this.broadcast({ t: "armed", v: event.v, ts: event.ts });
        break;
      case "full":
        this.mergeState(event.state);
        this.broadcast({ t: "full", state: this.getState(), ts: event.ts });
        break;
      case "dispatch":
        if (event.r.at >= this.countersResetAt) this.lastDispatch[event.r.id] = event.r;
        break;
      case "taps":
        if (event.ts >= this.countersResetAt) {
          for (const [id, delta] of Object.entries(event.delta)) {
            this.taps[id] = (this.taps[id] ?? 0) + delta;
          }
        }
        break;
      case "names":
        this.names = { ...event.names };
        this.broadcast({ t: "names", names: this.getNames(), ts: event.ts });
        break;
      case "reset-counters":
        this.countersResetAt = Math.max(this.countersResetAt, event.ts);
        this.applyCounterReset();
        break;
      case "conns":
        this.peerConns.set(event.replica, { n: event.n, ts: event.ts });
        break;
    }
  }

  private async flushTaps(): Promise<void> {
    const delta = this.pendingTaps;
    if (Object.keys(delta).length === 0) return;
    this.pendingTaps = {};
    await this.replicate({ t: "taps", delta, ts: Date.now() });
  }

  private async announceConns(): Promise<void> {
    await this.replicate({
      t: "conns",
      replica: this.replicaId,
      n: this.clients.size,
      ts: Date.now(),
    });
  }

  /** Sum of live sockets across replicas, ignoring replicas that stopped reporting. */
  totalConns(): number {
    const cutoff = Date.now() - CONN_HEARTBEAT_MS * 4;
    let total = this.clients.size;
    for (const [replica, entry] of this.peerConns) {
      if (replica === this.replicaId) continue;
      if (entry.ts < cutoff) continue;
      total += entry.n;
    }
    return total;
  }

  addClient(client: Client): void {
    this.clients.add(client);
    client.send({
      t: "hello",
      state: this.getState(),
      tallies: this.getTallies(),
      names: this.getNames(),
      role: client.role,
      armed: this.armed,
      ts: Date.now(),
    });
    if (client.control) this.sendStats(client);
    void this.announceConns();
  }

  removeClient(client: Client): void {
    this.clients.delete(client);
    void this.announceConns();
  }

  private broadcast(message: ServerMessage): void {
    for (const client of this.clients) client.send(message);
  }

  private broadcastStats(): void {
    for (const client of this.clients) {
      if (client.control) this.sendStats(client);
    }
  }

  private sendStats(client: Client): void {
    client.send({
      t: "stats",
      conns: this.totalConns(),
      taps: { ...this.taps },
      dispatch: { ...this.lastDispatch },
      bus: this.busStatus(),
    });
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const client of this.clients) client.close();
    this.clients.clear();
    await this.bus.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

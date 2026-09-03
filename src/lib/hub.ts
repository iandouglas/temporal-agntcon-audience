import { randomUUID } from "node:crypto";
import type { Bus } from "./bus";
import { createBus } from "./bus";
import { getServices, redisUrl } from "./config";
import { dispatchToggle, probeAll } from "./dispatch";
import { TokenBucket } from "./ratelimit";
import type {
  BusEvent,
  DispatchResult,
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
  private taps: Record<string, number> = {};
  private pendingTaps: Record<string, number> = {};
  private lastDispatch: Record<string, DispatchResult | null> = {};
  private peerConns = new Map<string, { n: number; ts: number }>();
  private clients = new Set<Client>();
  private timers: NodeJS.Timeout[] = [];

  private byId(id: string): ServiceConfig | undefined {
    return this.services.find((service) => service.id === id);
  }

  async start(): Promise<void> {
    for (const service of this.services) {
      this.state[service.id] = false;
      this.taps[service.id] = 0;
      this.lastDispatch[service.id] = null;
      if (!service.baseUrl) {
        console.warn(`[config] ${service.id} ("${service.name}") has no URL configured -- its switch will toggle but call nothing.`);
      }
    }

    this.bus = await createBus(redisUrl());
    this.bus.subscribe((event) => this.applyBusEvent(event));
    await this.seed();

    this.timers.push(setInterval(() => void this.flushTaps(), TAP_FLUSH_MS));
    this.timers.push(setInterval(() => void this.announceConns(), CONN_HEARTBEAT_MS));
    this.timers.push(setInterval(() => this.broadcastStats(), 1000));
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
    const existing = await this.bus.getState();
    if (existing) {
      this.mergeState(existing);
      console.log(`[seed] adopted existing state from ${this.bus.kind}:`, this.state);
      return;
    }

    const won = await this.bus.acquireSeedLock(SEED_LOCK_TTL_SECONDS);
    if (!won) {
      const deadline = Date.now() + SEED_WAIT_MS;
      while (Date.now() < deadline) {
        await sleep(SEED_POLL_MS);
        const seeded = await this.bus.getState();
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
    await this.bus.putState(this.state);
    await this.bus.publish({ t: "full", state: { ...this.state }, ts: Date.now() });
    await this.bus.releaseSeedLock();
    console.log("[seed] seeded from /health:", this.state);
  }

  /** Wipe the stored state and re-seed from /health. Used by the operator reseed. */
  async reseed(): Promise<StateMap> {
    await this.bus.clearState();
    await this.bus.releaseSeedLock();
    const probed = await probeAll(this.services);
    for (const service of this.services) this.state[service.id] = probed[service.id] ?? false;
    await this.bus.putState(this.state);
    await this.bus.publish({ t: "full", state: { ...this.state }, ts: Date.now() });
    console.log("[reseed] re-seeded from /health:", this.state);
    return { ...this.state };
  }

  private mergeState(incoming: StateMap): void {
    for (const service of this.services) {
      this.state[service.id] = incoming[service.id] ?? this.state[service.id] ?? false;
    }
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
  async toggle(id: string, value: boolean, options: { rateLimited: boolean; bucket?: TokenBucket }): Promise<void> {
    const service = this.byId(id);
    if (!service) return;

    this.pendingTaps[id] = (this.pendingTaps[id] ?? 0) + 1;

    const allowed = !options.rateLimited || (options.bucket?.take() ?? true);
    if (allowed) {
      void this.fireAndRecord(service, value);
    }

    this.state[id] = value;
    await this.bus.setField(id, value);
    await this.bus.publish({ t: "state", id, v: value, ts: Date.now() });
  }

  private async fireAndRecord(service: ServiceConfig, value: boolean): Promise<void> {
    const result = await dispatchToggle(service, value);
    if (!result) return;
    this.lastDispatch[service.id] = result;
    await this.bus.publish({ t: "dispatch", r: result });
  }

  private applyBusEvent(event: BusEvent): void {
    switch (event.t) {
      case "state":
        this.state[event.id] = event.v;
        this.broadcast({ t: "state", id: event.id, v: event.v, ts: event.ts });
        break;
      case "full":
        this.mergeState(event.state);
        this.broadcast({ t: "full", state: this.getState(), ts: event.ts });
        break;
      case "dispatch":
        this.lastDispatch[event.r.id] = event.r;
        break;
      case "taps":
        for (const [id, delta] of Object.entries(event.delta)) {
          this.taps[id] = (this.taps[id] ?? 0) + delta;
        }
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
    await this.bus.publish({ t: "taps", delta });
  }

  private async announceConns(): Promise<void> {
    await this.bus.publish({
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
    client.send({ t: "hello", state: this.getState(), ts: Date.now() });
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

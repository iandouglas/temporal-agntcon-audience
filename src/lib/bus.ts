import type { BusEvent, StateMap } from "./types";

/**
 * Shared state and cross-replica fanout.
 *
 * Redis is the serialization point: a tap writes state and publishes, and every
 * replica -- including the one that handled the tap -- applies the event when it
 * comes back around. Because Redis delivers to all subscribers in publish order,
 * replicas cannot disagree about which tap landed last.
 *
 * Without REDIS_URL we fall back to an in-process bus. That is correct for local
 * development and for a single replica, and it keeps the site up if Redis is
 * unreachable at boot -- it only breaks the guarantee that multiple replicas
 * stay in sync, which is logged loudly.
 */

const STATE_KEY = "switchboard:state";
const ARMED_KEY = "switchboard:armed";
const NAMES_KEY = "switchboard:names";
const VOTES_KEY = "switchboard:votes";
const SEED_LOCK_KEY = "switchboard:seedlock";
const CHANNEL = "switchboard:events";

export interface Bus {
  readonly kind: "redis" | "memory";
  readonly connected: boolean;
  connect(): Promise<void>;
  /** Returns null when no state has ever been written -- the signal to seed from /health. */
  getState(): Promise<StateMap | null>;
  putState(state: StateMap): Promise<void>;
  setField(id: string, value: boolean): Promise<void>;
  clearState(): Promise<void>;
  /** Whether the audience may drive the switches. Null means never set. */
  getArmed(): Promise<boolean | null>;
  setArmed(value: boolean): Promise<void>;
  /** Display names, keyed by service id. Empty when none has been set. */
  getNames(): Promise<Record<string, string>>;
  setName(id: string, name: string): Promise<void>;
  /** Vote counts, flat "<id>:breaks" / "<id>:fixes" keys. */
  getVotes(): Promise<Record<string, string>>;
  putVotes(flat: Record<string, string>): Promise<void>;
  acquireSeedLock(ttlSeconds: number): Promise<boolean>;
  releaseSeedLock(): Promise<void>;
  publish(event: BusEvent): Promise<void>;
  subscribe(handler: (event: BusEvent) => void): void;
  /** Fired when the bus recovers after an outage, so callers can re-sync. */
  onReconnect(handler: () => void): void;
  close(): Promise<void>;
}

function decode(hash: Record<string, string>): StateMap {
  const state: StateMap = {};
  for (const [id, raw] of Object.entries(hash)) state[id] = raw === "1";
  return state;
}

function encode(state: StateMap): Record<string, string> {
  const hash: Record<string, string> = {};
  for (const [id, value] of Object.entries(state)) hash[id] = value ? "1" : "0";
  return hash;
}

class MemoryBus implements Bus {
  readonly kind = "memory" as const;
  readonly connected = true;
  private state: StateMap | null = null;
  private armed: boolean | null = null;
  private names: Record<string, string> = {};
  private votes: Record<string, string> = {};
  private lock = false;
  private handlers: Array<(event: BusEvent) => void> = [];

  async connect(): Promise<void> {}

  async getState(): Promise<StateMap | null> {
    return this.state ? { ...this.state } : null;
  }

  async putState(state: StateMap): Promise<void> {
    this.state = { ...state };
  }

  async setField(id: string, value: boolean): Promise<void> {
    this.state = { ...(this.state ?? {}), [id]: value };
  }

  async clearState(): Promise<void> {
    this.state = null;
  }

  async getArmed(): Promise<boolean | null> {
    return this.armed;
  }

  async setArmed(value: boolean): Promise<void> {
    this.armed = value;
  }

  async getNames(): Promise<Record<string, string>> {
    return { ...this.names };
  }

  async setName(id: string, name: string): Promise<void> {
    this.names[id] = name;
  }

  async getVotes(): Promise<Record<string, string>> {
    return { ...this.votes };
  }

  async putVotes(flat: Record<string, string>): Promise<void> {
    this.votes = { ...this.votes, ...flat };
  }

  async acquireSeedLock(): Promise<boolean> {
    if (this.lock) return false;
    this.lock = true;
    return true;
  }

  async releaseSeedLock(): Promise<void> {
    this.lock = false;
  }

  async publish(event: BusEvent): Promise<void> {
    // Deliver asynchronously so callers observe the same ordering they would
    // with a real Redis round trip.
    queueMicrotask(() => {
      for (const handler of this.handlers) handler(event);
    });
  }

  subscribe(handler: (event: BusEvent) => void): void {
    this.handlers.push(handler);
  }

  onReconnect(): void {
    // An in-process bus never drops.
  }

  async close(): Promise<void> {
    this.handlers = [];
  }
}

type RedisLike = {
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, hash: Record<string, string>): Promise<number>;
  del(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, ...args: unknown[]): Promise<string | null>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<unknown>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  quit(): Promise<unknown>;
  duplicate(): RedisLike;
  status: string;
};

class RedisBus implements Bus {
  readonly kind = "redis" as const;
  private client!: RedisLike;
  private subscriber!: RedisLike;
  private handlers: Array<(event: BusEvent) => void> = [];
  private reconnectHandlers: Array<() => void> = [];
  private ready = { client: false, subscriber: false };
  private wasDown = false;

  constructor(private readonly url: string) {}

  get connected(): boolean {
    return this.ready.client && this.ready.subscriber;
  }

  async connect(): Promise<void> {
    const { default: Redis } = await import("ioredis");
    const options = {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      // Fail commands immediately while disconnected instead of queueing them.
      // A tap must not sit waiting on Redis: the caller has a local fallback and
      // the room needs the switch to move now.
      enableOfflineQueue: false,
      retryStrategy: (times: number) => Math.min(times * 200, 3000),
      // Railway's private networking is IPv6-only.
      family: this.url.includes(".railway.internal") ? 6 : undefined,
    };

    this.client = new Redis(this.url, options) as unknown as RedisLike;
    this.subscriber = this.client.duplicate();

    for (const [label, conn] of [
      ["client", this.client],
      ["subscriber", this.subscriber],
    ] as const) {
      conn.on("error", ((err: Error) => {
        if (this.ready[label]) console.error(`[redis:${label}] lost connection: ${err.message}`);
        this.ready[label] = false;
        this.wasDown = true;
      }) as never);
      conn.on("ready", (() => {
        this.ready[label] = true;
        // Both connections must be back before we re-sync: the resync writes
        // over the command connection, and firing on the subscriber alone lands
        // on a socket that is not writeable yet.
        if (this.wasDown && this.connected) {
          this.wasDown = false;
          console.log("[redis] reconnected");
          for (const handler of this.reconnectHandlers) handler();
        }
      }) as never);
    }

    // With the offline queue disabled, a command issued before the socket is
    // ready fails outright -- so wait for both connections rather than letting
    // the very first subscribe() drop us to the in-process fallback.
    await Promise.all([waitForReady(this.client, "client"), waitForReady(this.subscriber, "subscriber")]);
    this.ready.client = true;
    this.ready.subscriber = true;

    this.subscriber.on("message", ((_channel: string, message: string) => {
      let event: BusEvent;
      try {
        event = JSON.parse(message) as BusEvent;
      } catch {
        return;
      }
      for (const handler of this.handlers) handler(event);
    }) as never);

    await this.subscriber.subscribe(CHANNEL);
  }

  async getState(): Promise<StateMap | null> {
    const hash = await this.client.hgetall(STATE_KEY);
    if (!hash || Object.keys(hash).length === 0) return null;
    return decode(hash);
  }

  async putState(state: StateMap): Promise<void> {
    const hash = encode(state);
    if (Object.keys(hash).length === 0) return;
    await this.client.hset(STATE_KEY, hash);
  }

  async setField(id: string, value: boolean): Promise<void> {
    await this.client.hset(STATE_KEY, { [id]: value ? "1" : "0" });
  }

  async clearState(): Promise<void> {
    await this.client.del(STATE_KEY);
  }

  async getArmed(): Promise<boolean | null> {
    const raw = await this.client.get(ARMED_KEY);
    if (raw === null || raw === undefined) return null;
    return raw === "1";
  }

  async setArmed(value: boolean): Promise<void> {
    await this.client.set(ARMED_KEY, value ? "1" : "0");
  }

  async getNames(): Promise<Record<string, string>> {
    const hash = await this.client.hgetall(NAMES_KEY);
    return hash ?? {};
  }

  async setName(id: string, name: string): Promise<void> {
    await this.client.hset(NAMES_KEY, { [id]: name });
  }

  async getVotes(): Promise<Record<string, string>> {
    const hash = await this.client.hgetall(VOTES_KEY);
    return hash ?? {};
  }

  async putVotes(flat: Record<string, string>): Promise<void> {
    if (Object.keys(flat).length === 0) return;
    await this.client.hset(VOTES_KEY, flat);
  }

  async acquireSeedLock(ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(SEED_LOCK_KEY, process.pid.toString(), "EX", ttlSeconds, "NX");
    return result === "OK";
  }

  async releaseSeedLock(): Promise<void> {
    await this.client.del(SEED_LOCK_KEY);
  }

  async publish(event: BusEvent): Promise<void> {
    await this.client.publish(CHANNEL, JSON.stringify(event));
  }

  subscribe(handler: (event: BusEvent) => void): void {
    this.handlers.push(handler);
  }

  onReconnect(handler: () => void): void {
    this.reconnectHandlers.push(handler);
  }

  async close(): Promise<void> {
    this.handlers = [];
    this.reconnectHandlers = [];
    await Promise.allSettled([this.client.quit(), this.subscriber.quit()]);
  }
}

const READY_TIMEOUT_MS = 10_000;

function waitForReady(conn: RedisLike, label: string): Promise<void> {
  if (conn.status === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} did not become ready within ${READY_TIMEOUT_MS}ms`));
    }, READY_TIMEOUT_MS);

    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    function cleanup(): void {
      clearTimeout(timer);
      (conn as unknown as { off(e: string, l: unknown): void }).off("ready", onReady);
      (conn as unknown as { off(e: string, l: unknown): void }).off("error", onError);
    }

    conn.on("ready", onReady as never);
    conn.on("error", onError as never);
  });
}

export async function createBus(url: string | undefined): Promise<Bus> {
  if (!url) {
    console.warn(
      "[bus] REDIS_URL is not set -- using an in-process bus. Fine for local dev and a single replica; replicas will NOT stay in sync.",
    );
    const bus = new MemoryBus();
    await bus.connect();
    return bus;
  }

  const bus = new RedisBus(url);
  try {
    await bus.connect();
    console.log("[bus] connected to Redis");
    return bus;
  } catch (err) {
    console.error(
      `[bus] Redis connection failed (${err instanceof Error ? err.message : String(err)}) -- falling back to an in-process bus so the site still serves.`,
    );
    const fallback = new MemoryBus();
    await fallback.connect();
    return fallback;
  }
}

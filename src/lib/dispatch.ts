import { Agent, request } from "undici";
import type { DispatchResult, ServiceConfig } from "./types";

/**
 * Outbound HTTP to the private service URLs.
 *
 * Every audience tap produces its own POST -- there is no coalescing, by design,
 * because the live crowd load is part of the demo. What we do bound is the number
 * of those requests in flight at once, so a surge cannot exhaust sockets in this
 * process. Overflow beyond the queue is shed rather than queued forever; a tap
 * from four seconds ago is not worth delivering.
 *
 * The services live on Railway's private network, so these are sub-millisecond
 * internal hops. Two consequences shape the settings below: connections must be
 * kept alive and reused (at a few hundred taps a second, a fresh TCP handshake
 * per tap is the whole cost), and timeouts can be aggressive -- an internal call
 * that has not answered in two seconds is not going to.
 *
 * Railway's private DNS is IPv6-only, hence `autoSelectFamily`.
 */

const MAX_CONCURRENCY = 128;
const MAX_QUEUE = 2000;
const POST_TIMEOUT_MS = 2000;
const HEALTH_TIMEOUT_MS = 3000;

const agent = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 300_000,
  connections: 64, // per origin
  pipelining: 1,
  connect: {
    autoSelectFamily: true,
    timeout: 2000,
  },
});

class BoundedPool {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxQueue: number,
  ) {}

  get depth(): number {
    return this.waiting.length;
  }

  get inFlight(): number {
    return this.active;
  }

  /** Resolves with `null` when the job was shed because the queue was full. */
  run<T>(job: () => Promise<T>): Promise<T | null> {
    if (this.active < this.maxConcurrency) return this.exec(job);
    if (this.waiting.length >= this.maxQueue) return Promise.resolve(null);
    return new Promise<T | null>((resolve) => {
      this.waiting.push(() => resolve(this.exec(job)));
    });
  }

  private async exec<T>(job: () => Promise<T>): Promise<T> {
    this.active += 1;
    try {
      return await job();
    } finally {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next) next();
    }
  }
}

const pool = new BoundedPool(MAX_CONCURRENCY, MAX_QUEUE);

export function poolStats(): { inFlight: number; queued: number } {
  return { inFlight: pool.inFlight, queued: pool.depth };
}

/**
 * POST `{baseUrl}/on` or `{baseUrl}/off`. Empty body, no auth, no retry --
 * one tap, one call. Returns null if the service has no URL configured or the
 * request was shed under load.
 */
export async function dispatchToggle(
  service: ServiceConfig,
  value: boolean,
): Promise<DispatchResult | null> {
  const path = value ? "on" : "off";
  if (!service.baseUrl) return null;

  const url = `${service.baseUrl}/${path}`;
  return pool.run(async () => {
    const started = Date.now();
    try {
      const res = await request(url, {
        method: "POST",
        dispatcher: agent,
        headersTimeout: POST_TIMEOUT_MS,
        bodyTimeout: POST_TIMEOUT_MS,
      });
      // Draining is mandatory: an unread body holds the connection open and
      // keep-alive reuse silently stops working.
      await res.body.dump();
      return {
        id: service.id,
        path,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        ms: Date.now() - started,
        at: Date.now(),
      } satisfies DispatchResult;
    } catch (err) {
      return {
        id: service.id,
        path,
        ok: false,
        status: null,
        ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      } satisfies DispatchResult;
    }
  });
}

/**
 * Interpret a `/health` response as a boolean.
 *
 * Deliberately permissive: the four services and the MCP server may well be
 * written by different people in different languages, and "returns a boolean of
 * its own state" covers a wide range of literal payloads. Returns null when the
 * response cannot be read as a state at all.
 */
export function parseHealth(raw: string): boolean | null {
  const text = raw.trim();
  if (text === "") return null;

  try {
    return coerce(JSON.parse(text) as unknown);
  } catch {
    return coerceScalar(text);
  }
}

const STATE_KEYS = [
  "on",
  "state",
  "status",
  "enabled",
  "healthy",
  "health",
  "value",
  "active",
  "up",
  "running",
  "toggle",
];

function coerce(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return coerceScalar(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!STATE_KEYS.includes(key.toLowerCase())) continue;
      const nested = coerce(record[key]);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function coerceScalar(text: string): boolean | null {
  const value = text.trim().toLowerCase().replace(/^"|"$/g, "");
  if (["true", "on", "1", "yes", "up", "enabled", "active", "healthy", "ok", "running"].includes(value)) return true;
  if (["false", "off", "0", "no", "down", "disabled", "inactive", "unhealthy", "stopped"].includes(value)) return false;
  return null;
}

/** GET `{baseUrl}/health`. Returns null on any failure, so the caller can fall back. */
export async function probeHealth(service: ServiceConfig): Promise<boolean | null> {
  if (!service.baseUrl) return null;
  const url = `${service.baseUrl}/health`;
  try {
    const res = await request(url, {
      method: "GET",
      dispatcher: agent,
      headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.8" },
      headersTimeout: HEALTH_TIMEOUT_MS,
      bodyTimeout: HEALTH_TIMEOUT_MS,
    });
    const text = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      console.warn(`[health] ${service.id} ${url} -> HTTP ${res.statusCode}`);
      return null;
    }
    return parseHealth(text);
  } catch (err) {
    console.warn(`[health] ${service.id} ${url} -> ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Probe every service in parallel. Services that fail are simply absent from the result. */
export async function probeAll(services: ServiceConfig[]): Promise<Record<string, boolean>> {
  const entries = await Promise.all(
    services.map(async (service) => [service.id, await probeHealth(service)] as const),
  );
  const seeded: Record<string, boolean> = {};
  for (const [id, value] of entries) {
    if (value !== null) seeded[id] = value;
  }
  return seeded;
}

export async function closeDispatcher(): Promise<void> {
  await agent.close();
}

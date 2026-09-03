/**
 * Test harness: stub services, a Redis instance, and one or more app replicas.
 *
 * Everything binds to 127.0.0.1 on high ports and is torn down by `Rig.stop()`.
 * Redis is optional -- if `redis-server` is not on PATH, `startRedis()` returns
 * null and the caller skips the tests that need it, so the suite still runs
 * usefully on a machine without it.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** How a stub's /health reports itself, mirroring the shapes real services use. */
export type HealthShape = "bool" | "obj" | "word" | "nested";

export interface Stub {
  port: number;
  /** Every /on and /off this stub received, in order. */
  hits: Array<"on" | "off">;
  get on(): boolean;
  get calls(): number;
  /** Change state behind the app's back, the way a real service drifting would. */
  drift(value: boolean): void;
  close(): Promise<void>;
}

export async function startStub(port: number, shape: HealthShape, initial: boolean): Promise<Stub> {
  let on = initial;
  const hits: Array<"on" | "off"> = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/health") {
      const body =
        shape === "bool" ? String(on)
        : shape === "obj" ? JSON.stringify({ on })
        : shape === "word" ? (on ? "ON" : "OFF")
        : JSON.stringify({ state: on ? "enabled" : "disabled" });
      res.writeHead(200, { "content-type": "application/json" }).end(body);
      return;
    }
    if (req.method === "POST" && (url.pathname === "/on" || url.pathname === "/off")) {
      on = url.pathname === "/on";
      hits.push(on ? "on" : "off");
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(port, "127.0.0.1");
  await once(server, "listening");

  return {
    port,
    hits,
    get on() { return on; },
    get calls() { return hits.length; },
    drift(value: boolean) { on = value; },
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

export interface RedisHandle {
  port: number;
  url: string;
  /** Kill the server without saving, simulating an outage. */
  kill(): void;
  start(): void;
  stop(): void;
  /** Drop all keys, so a suite starts from a genuinely cold state. */
  flush(): void;
}

/** Whether `redis-server` is installed, so suites can skip rather than fail. */
export function hasRedisServer(): boolean {
  return spawnSyncQuiet("redis-server", ["--version"]);
}

export function startRedis(port: number): RedisHandle | null {
  const start = (): boolean => {
    const result = spawn("redis-server", [
      "--port", String(port), "--save", "", "--appendonly", "no", "--daemonize", "yes",
    ], { stdio: "ignore" });
    return result.pid !== undefined;
  };

  try {
    const probe = spawnSyncQuiet("redis-server", ["--version"]);
    if (!probe) return null;
  } catch {
    return null;
  }

  start();
  return {
    port,
    url: `redis://127.0.0.1:${port}`,
    kill() { spawnSyncQuiet("redis-cli", ["-p", String(port), "shutdown", "nosave"]); },
    start() { start(); },
    stop() { spawnSyncQuiet("redis-cli", ["-p", String(port), "shutdown", "nosave"]); },
    flush() { spawnSyncQuiet("redis-cli", ["-p", String(port), "flushall"]); },
  };
}

function spawnSyncQuiet(cmd: string, args: string[]): boolean {
  const res = spawnSync(cmd, args, { stdio: "ignore" });
  return res.error === undefined && res.status !== null;
}

export interface Replica {
  port: number;
  base: string;
  proc: ChildProcess;
  log: () => string;
  stop: () => Promise<void>;
}

export interface ReplicaOptions {
  port: number;
  redisUrl?: string;
  stubPorts: { mcp: number; services: number[] };
  adminToken: string;
  extraEnv?: Record<string, string>;
}

export async function startReplica(options: ReplicaOptions): Promise<Replica> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(options.port),
    admin_token: options.adminToken,
    mcp_name: "AGENT MCP",
    mcp_url: `http://127.0.0.1:${options.stubPorts.mcp}`,
    ...options.extraEnv,
  };
  if (options.redisUrl) env.REDIS_URL = options.redisUrl;
  else delete env.REDIS_URL;

  options.stubPorts.services.forEach((port, index) => {
    env[`service_${index + 1}_name`] = `SERVICE ${index + 1}`;
    env[`service_${index + 1}_url`] = `http://127.0.0.1:${port}`;
  });

  const proc = spawn("node", ["dist/server/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout?.on("data", (d: Buffer) => { log += d.toString(); });
  proc.stderr?.on("data", (d: Buffer) => { log += d.toString(); });

  const base = `http://127.0.0.1:${options.port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  if (Date.now() >= deadline) throw new Error(`replica ${options.port} never became healthy:\n${log}`);

  return {
    port: options.port,
    base,
    proc,
    log: () => log,
    async stop() {
      if (proc.exitCode === null) {
        proc.kill("SIGKILL");
        await once(proc, "exit").catch(() => undefined);
      }
    },
  };
}

/** A WebSocket that records every message it receives. */
export interface Client extends WebSocket {
  messages: Array<Record<string, unknown>>;
}

export async function connect(base: string, query = ""): Promise<Client> {
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws${query}`) as Client;
  ws.messages = [];
  ws.on("message", (data) => ws.messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
  await once(ws, "open");
  return ws;
}

export async function connectControl(base: string, token: string): Promise<Client> {
  return connect(base, `?role=control&token=${encodeURIComponent(token)}`);
}

/**
 * Wait until `predicate` holds, or throw. `detail` is evaluated on failure so a
 * timeout reports what was actually observed rather than just "timed out".
 */
export async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; detail?: () => string } = {},
): Promise<void> {
  const { timeoutMs = 8000, detail } = options;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  const observed = detail ? `\n  last observed: ${detail()}` : "";
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}${observed}`);
}

export interface AdminState {
  ok: boolean;
  replica: string;
  conns: number;
  armed: boolean;
  bus: { kind: string; healthy: boolean; failures: number; lastError: string | null };
  state: Record<string, boolean>;
  pool: { inFlight: number; queued: number };
  services: Array<{ id: string; name: string; kind: string; configured: boolean }>;
}

export async function adminState(base: string, token: string): Promise<AdminState> {
  const res = await fetch(`${base}/api/admin/state`, { headers: { authorization: `Bearer ${token}` } });
  return (await res.json()) as AdminState;
}

export interface Stats {
  conns: number;
  taps: Record<string, number>;
  dispatch: Record<string, { ok: boolean; status: number | null; ms: number } | null>;
  bus: { kind: string; healthy: boolean; failures: number; lastError: string | null };
}

/** Most recent stats frame a control client has received, if any. */
export function lastStats(client: Client): Stats | undefined {
  return client.messages.filter((m) => m.t === "stats").at(-1) as Stats | undefined;
}

/** The `hello` frame a client received on connect. */
export function hello(client: Client): { state: Record<string, boolean>; armed: boolean } | undefined {
  return client.messages.find((m) => m.t === "hello") as
    | { state: Record<string, boolean>; armed: boolean }
    | undefined;
}

export function sawState(client: Client, id: string, value: boolean): boolean {
  return client.messages.some((m) => m.t === "state" && m.id === id && m.v === value);
}

export function sawArmed(client: Client, value: boolean): boolean {
  return client.messages.some((m) => m.t === "armed" && m.v === value);
}

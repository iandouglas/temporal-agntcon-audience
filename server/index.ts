import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import next from "next";
import { WebSocketServer, type WebSocket } from "ws";
import { adminToken, tokensMatch } from "../src/lib/config";
import { closeDispatcher, poolStats } from "../src/lib/dispatch";
import { Hub, type Client } from "../src/lib/hub";
import { TokenBucket } from "../src/lib/ratelimit";
import type { ClientMessage, Role, ServerMessage } from "../src/lib/types";

/**
 * Custom Node server so we can own the HTTP upgrade path.
 *
 * Next.js handles every page and its own routes; we intercept only `/ws` for the
 * audience socket and `/api/admin/*` for the operator actions. The admin routes
 * live here rather than in a Next route handler because Next bundles route
 * handlers into a separate module registry -- a `Hub` imported there would be a
 * different instance from the one holding the sockets.
 */

/*
 * Production unless something explicitly asks for development.
 *
 * This used to read `NODE_ENV !== "production"`, which meant an unset NODE_ENV
 * silently started the dev server. On Railway that is not a small mistake: Next
 * compiles per request, and with several replicas each one produces different
 * chunk hashes, so a browser served HTML by one replica 404s on chunks from
 * another, hydration never runs, and the board sits on "reconnecting..." while
 * the server looks perfectly healthy.
 *
 * The npm dev script sets NODE_ENV=development, so the safe default is the one
 * a deployment gets by doing nothing.
 */
const dev = process.env.NODE_ENV === "development";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

/*
 * Bind every interface, dual-stack ("::" accepts IPv4 too unless ipv6Only is
 * set). Railway's private network is IPv6 and its proxy reaches the container
 * from outside, so anything narrower is unreachable one way or the other.
 *
 * Never read HOSTNAME here. Docker -- and therefore Railway -- sets it to the
 * container id, and binding to that produced a 502 from a process whose logs
 * said "listening" and looked entirely healthy.
 */
const bindHost = process.env.BIND_HOST ?? "::";

/** Cookie that pins a viewer to a team across reloads. */
const ROLE_COOKIE = "mep_role";

const MAX_MESSAGE_BYTES = 1024;
const PING_INTERVAL_MS = 25_000;

async function main(): Promise<void> {
  const hub = new Hub();
  await hub.start();

  const app = next({ dev, port });
  const handle = app.getRequestHandler();
  await app.prepare();
  // Must come after prepare(): Next builds its upgrade handler from the
  // prepared server instance.
  const upgradeHandler = app.getUpgradeHandler();

  const server = createServer((req, res) => {
    void route(req, res, hub, handle);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on("upgrade", (req, socket, head) => {
    const { pathname, searchParams } = parseUrl(req);

    if (pathname === "/ws") {
      const control = searchParams.get("role") === "control";
      if (control && !tokensMatch(searchParams.get("token"))) {
        reject(socket, 401, "Unauthorized");
        return;
      }
      // The page set this cookie moments ago; fall back for a socket that
      // somehow arrives first.
      const role = roleFromCookie(req) ?? hub.nextRole();
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws, hub, control, role));
      return;
    }

    // Everything else (notably Next's dev HMR socket) belongs to Next.
    void upgradeHandler(req, socket, head);
  });

  server.listen(port, bindHost, () => {
    console.log(`[server] listening on [${bindHost}]:${port} (${dev ? "development" : "production"})`);
    console.log(`[server] replica ${hub.replicaId}, ${hub.services.length} toggles: ${hub.services.map((s) => s.id).join(", ")}`);
    if (!adminToken()) {
      console.warn("[server] admin_token is not set -- /control and the reseed endpoint are disabled.");
    }
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[server] ${signal} received, shutting down`);
    wss.close();
    await hub.stop();
    await closeDispatcher();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

type NextHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  hub: Hub,
  handle: NextHandler,
): Promise<void> {
  const { pathname } = parseUrl(req);

  if (pathname === "/healthz") {
    json(res, 200, {
      ok: true,
      replica: hub.replicaId,
      conns: hub.totalConns(),
      armed: hub.isArmed(),
      names: hub.getNames(),
      bus: hub.busStatus(),
      pool: poolStats(),
    });
    return;
  }

  if (pathname.startsWith("/api/admin/")) {
    await admin(req, res, hub, pathname);
    return;
  }

  /*
   * Hand out a team on the first page view and pin it in a cookie, so a reload
   * keeps you on the same side. Set before Next writes the response: values
   * from setHeader survive its writeHead call. Assignment is round-robin
   * rather than random, which keeps the two teams even.
   */
  if (req.method === "GET" && pathname === "/" && !roleFromCookie(req)) {
    const role = hub.nextRole();
    res.setHeader("Set-Cookie", `${ROLE_COOKIE}=${role}; Path=/; Max-Age=86400; SameSite=Lax`);
  }

  await handle(req, res);
}

async function admin(
  req: IncomingMessage,
  res: ServerResponse,
  hub: Hub,
  pathname: string,
): Promise<void> {
  const token = bearer(req) ?? parseUrl(req).searchParams.get("token");
  if (!tokensMatch(token)) {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  if (pathname === "/api/admin/reseed" && req.method === "POST") {
    const state = await hub.reseed();
    json(res, 200, { ok: true, state });
    return;
  }

  if (pathname === "/api/admin/name" && req.method === "POST") {
    const id = parseUrl(req).searchParams.get("id") ?? "";
    const name = parseUrl(req).searchParams.get("name") ?? "";
    const ok = await hub.setName(id, name);
    json(res, ok ? 200 : 400, ok ? { ok: true, names: hub.getNames() } : { error: "unknown id or bad name" });
    return;
  }

  if (pathname === "/api/admin/reset-counters" && req.method === "POST") {
    await hub.resetCounters();
    json(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/admin/state" && req.method === "GET") {
    json(res, 200, {
      ok: true,
      replica: hub.replicaId,
      conns: hub.totalConns(),
      armed: hub.isArmed(),
      names: hub.getNames(),
      bus: hub.busStatus(),
      state: hub.getState(),
      pool: poolStats(),
      services: hub.services.map((s) => ({ id: s.id, name: s.name, kind: s.kind, configured: Boolean(s.baseUrl) })),
    });
    return;
  }

  json(res, 404, { error: "not found" });
}

function attach(ws: WebSocket, hub: Hub, control: boolean, role: Role): void {
  const client: Client = {
    control,
    role,
    bucket: new TokenBucket(5, 10),
    send(message: ServerMessage) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    },
    close() {
      ws.close(1001, "server shutting down");
    },
  };

  let alive = true;
  ws.on("pong", () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, PING_INTERVAL_MS);

  hub.addClient(client);

  ws.on("message", (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }

    if (message.t === "ping") {
      client.send({ t: "pong" });
      return;
    }

    if (message.t === "vote" && typeof message.id === "string") {
      void hub.vote(message.id, client.role, { bucket: client.bucket });
      return;
    }

    if (message.t === "toggle" && typeof message.id === "string" && typeof message.v === "boolean") {
      void hub.toggle(message.id, message.v, { operator: false, bucket: client.bucket });
      return;
    }

    // Opening and closing the floor is an operator action.
    if (message.t === "arm" && control && typeof message.v === "boolean") {
      void hub.setArmed(message.v);
      return;
    }

    if (
      message.t === "set-name" &&
      control &&
      typeof message.id === "string" &&
      typeof message.name === "string"
    ) {
      void hub.setName(message.id, message.name);
      return;
    }

    if (message.t === "reset-counters" && control) {
      void hub.resetCounters();
      return;
    }

    // Operator forces bypass the rate limit: there is exactly one of them and
    // they are the escape hatch when something looks wrong on stage.
    if (message.t === "force" && control && typeof message.id === "string" && typeof message.v === "boolean") {
      void hub.toggle(message.id, message.v, { operator: true });
    }
  });

  const cleanup = (): void => {
    clearInterval(heartbeat);
    hub.removeClient(client);
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

function roleFromCookie(req: IncomingMessage): Role | null {
  const cookie = req.headers.cookie ?? "";
  const match = new RegExp(`(?:^|;\\s*)${ROLE_COOKIE}=(breaker|fixer)`).exec(cookie);
  return match ? (match[1] as Role) : null;
}

function parseUrl(req: IncomingMessage): { pathname: string; searchParams: URLSearchParams } {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/*
 * Last-resort net. During a live demo, staying up and degraded beats exiting:
 * a crashed process takes every phone in the room down with it, while a logged
 * error usually costs one tap. Anything reaching here is a bug worth chasing
 * afterwards, so it is logged loudly rather than swallowed.
 */
process.on("unhandledRejection", (reason: unknown) => {
  console.error("[server] unhandled rejection (continuing):", reason);
});
process.on("uncaughtException", (err: unknown) => {
  console.error("[server] uncaught exception (continuing):", err);
});

main().catch((err: unknown) => {
  console.error("[server] fatal during startup:", err);
  process.exit(1);
});

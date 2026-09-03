import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import next from "next";
import { WebSocketServer, type WebSocket } from "ws";
import { adminToken, tokensMatch } from "../src/lib/config";
import { closeDispatcher, poolStats } from "../src/lib/dispatch";
import { Hub, type Client } from "../src/lib/hub";
import { TokenBucket } from "../src/lib/ratelimit";
import type { ClientMessage, ServerMessage } from "../src/lib/types";

/**
 * Custom Node server so we can own the HTTP upgrade path.
 *
 * Next.js handles every page and its own routes; we intercept only `/ws` for the
 * audience socket and `/api/admin/*` for the operator actions. The admin routes
 * live here rather than in a Next route handler because Next bundles route
 * handlers into a separate module registry -- a `Hub` imported there would be a
 * different instance from the one holding the sockets.
 */

const dev = process.env.NODE_ENV !== "production";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const hostname = process.env.HOSTNAME ?? "0.0.0.0";

const MAX_MESSAGE_BYTES = 1024;
const PING_INTERVAL_MS = 25_000;

async function main(): Promise<void> {
  const hub = new Hub();
  await hub.start();

  const app = next({ dev, hostname, port });
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
      const role = searchParams.get("role");
      const control = role === "control";
      if (control && !tokensMatch(searchParams.get("token"))) {
        reject(socket, 401, "Unauthorized");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws, hub, control));
      return;
    }

    // Everything else (notably Next's dev HMR socket) belongs to Next.
    void upgradeHandler(req, socket, head);
  });

  server.listen(port, hostname, () => {
    console.log(`[server] listening on http://${hostname}:${port} (${dev ? "development" : "production"})`);
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
      bus: hub.busStatus(),
      pool: poolStats(),
    });
    return;
  }

  if (pathname.startsWith("/api/admin/")) {
    await admin(req, res, hub, pathname);
    return;
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
      bus: hub.busStatus(),
      state: hub.getState(),
      pool: poolStats(),
      services: hub.services.map((s) => ({ id: s.id, name: s.name, kind: s.kind, configured: Boolean(s.baseUrl) })),
    });
    return;
  }

  json(res, 404, { error: "not found" });
}

function attach(ws: WebSocket, hub: Hub, control: boolean): void {
  const client: Client = {
    control,
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

    if (message.t === "toggle" && typeof message.id === "string" && typeof message.v === "boolean") {
      void hub.toggle(message.id, message.v, { operator: false, bucket: client.bucket });
      return;
    }

    // Opening and closing the floor is an operator action.
    if (message.t === "arm" && control && typeof message.v === "boolean") {
      void hub.setArmed(message.v);
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

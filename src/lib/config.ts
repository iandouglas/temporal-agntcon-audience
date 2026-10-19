import { timingSafeEqual } from "node:crypto";
import type { PublicService, ServiceConfig } from "./types";

/** Highest `service_N_*` index we look for. The demo uses 4; the extra headroom is free. */
const MAX_API_SERVICES = 8;

/**
 * Read an env var case-insensitively.
 *
 * The demo's variables are specified in lowercase (`service_1_url`), but hosting
 * dashboards and shells have a habit of upper-casing things. Checking both ways
 * costs nothing and removes a whole class of 5pm-before-the-keynote bugs.
 */
export function env(name: string): string | undefined {
  const direct = process.env[name];
  if (direct !== undefined && direct.trim() !== "") return direct.trim();

  const wanted = name.toLowerCase();
  for (const key of Object.keys(process.env)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = process.env[key];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function normalizeBase(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "");
}

let cached: ServiceConfig[] | null = null;

/**
 * Build the toggle list from the environment.
 *
 * The MCP connection is always first. The four API services always appear even
 * if their env vars are missing -- a switch that is present but inert is far
 * easier to diagnose on stage than a switch that silently vanished.
 */
export function getServices(): ServiceConfig[] {
  if (cached) return cached;

  const services: ServiceConfig[] = [];

  /*
   * The agent's own worker process, first because it is first in the call
   * path: agent -> MCP -> APIs. It is the only switch that kills a real
   * process rather than flipping a flag, so it is also the one worth having
   * at the top of the phone.
   *
   * It has no URL by design. Nothing is POSTed to it -- the worker polls
   * `/chaos` and exits on its own when the breakers get ahead. Set
   * `agent_worker=0` to drop the card entirely, for a rehearsal where nobody
   * is running a worker.
   */
  if (env("agent_worker") !== "0") {
    services.push({
      id: "agent_worker",
      name: env("agent_worker_name") ?? "AGENT WORKER",
      kind: "worker",
    });
  }

  /*
   * The MCP server does not speak /on and /off. Its control plane is
   * POST /admin/control {"target":"global","enabled":bool}, behind an admin
   * bearer, on its INTERNAL listener only -- deliberately, so that a leaked
   * token alone cannot reach the chaos levers from the conference floor.
   *
   * So `mcp_url` points at that internal listener (`:8081`, no public domain)
   * and `mcp_admin_token` carries the token. With no token set we fall back to
   * the /on + /off dialect, which is what `dev/mcp-switch-shim.mjs` serves
   * locally.
   */
  services.push({
    id: "mcp",
    name: env("mcp_name") ?? "AGENT ↔ MCP SERVER",
    kind: "mcp",
    baseUrl: normalizeBase(env("mcp_url")),
    adminToken: env("mcp_admin_token"),
  });

  const highest = Math.max(4, highestConfiguredApiIndex());
  for (let i = 1; i <= highest; i += 1) {
    services.push({
      id: `service_${i}`,
      name: env(`service_${i}_name`) ?? `SERVICE ${i}`,
      kind: "api",
      baseUrl: normalizeBase(env(`service_${i}_url`)),
    });
  }

  cached = services;
  return services;
}

function highestConfiguredApiIndex(): number {
  let highest = 0;
  for (let i = 1; i <= MAX_API_SERVICES; i += 1) {
    if (env(`service_${i}_url`) || env(`service_${i}_name`)) highest = i;
  }
  return highest;
}

/** Strips `baseUrl`. This is the only shape that may cross to the browser. */
export function toPublic(services: ServiceConfig[]): PublicService[] {
  return services.map(({ id, name, kind }) => ({ id, name, kind }));
}

export function getPublicServices(): PublicService[] {
  return toPublic(getServices());
}

export function pageTitle(): string {
  return env("page_title") ?? "SERVICE CONTROL";
}

export function pageSubtitle(): string {
  return env("page_subtitle") ?? "tap a switch · everyone sees it";
}

export function adminToken(): string | undefined {
  return env("admin_token");
}

/**
 * The stage screen's origin, for the queued/fulfilled counters.
 *
 * It is the only service holding a Temporal client, so it is the only thing
 * that knows these numbers. Unset means the counters are not rendered at all,
 * which is the right default: a board showing a permanent 0 / 0 is worse than
 * a board that does not mention orders.
 */
export function stageUrl(): string | undefined {
  return normalizeBase(env("stage_url"));
}

export function redisUrl(): string | undefined {
  return env("REDIS_URL") ?? env("REDIS_PRIVATE_URL") ?? env("redis_url");
}

/**
 * Check every configured URL at boot rather than discovering a typo one tap at
 * a time. Returns human-readable problems; the caller logs them and carries on,
 * since a broken URL should not stop the rest of the board from working.
 */
export function validateServices(services: ServiceConfig[]): string[] {
  const problems: string[] = [];
  for (const service of services) {
    // The worker has nothing to call: it reads /chaos and exits on its own.
    // Warning about a URL it is never meant to have would train the operator
    // to ignore this list, which is the opposite of the point.
    if (service.kind === "worker") continue;

    const envName = service.id === "mcp" ? "mcp_url" : `${service.id}_url`;
    if (!service.baseUrl) {
      problems.push(`${envName} is not set — "${service.name}" will toggle but call nothing.`);
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(service.baseUrl);
    } catch {
      problems.push(`${envName}="${service.baseUrl}" is not a valid URL. It needs a scheme, e.g. http://host:8080`);
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      // A bare "host:8080" parses as a URL whose scheme is "host:", so the
      // missing-scheme typo lands here rather than in the catch above.
      problems.push(
        `${envName}="${service.baseUrl}" is missing an http:// or https:// scheme (read as "${parsed.protocol}")`,
      );
      continue;
    }
    if (parsed.hostname.endsWith(".railway.internal") && !parsed.port) {
      problems.push(
        `${envName}="${service.baseUrl}" is a Railway private address with no port. Internal URLs need one, e.g. http://${parsed.hostname}:8080`,
      );
    }
    if (parsed.search || parsed.hash) {
      problems.push(`${envName}="${service.baseUrl}" has a query string or fragment; it should be a bare base URL.`);
    }
  }
  return problems;
}

/** Reset the memoized service list. Only used by tests and the reseed path. */
export function resetConfigCache(): void {
  cached = null;
}

/**
 * Constant-time token comparison, so the admin token cannot be recovered a
 * character at a time by timing repeated requests.
 */
export function tokensMatch(candidate: string | null | undefined): boolean {
  const expected = adminToken();
  if (!expected || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

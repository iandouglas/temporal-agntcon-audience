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

  const services: ServiceConfig[] = [
    {
      id: "mcp",
      name: env("mcp_name") ?? "AGENT ↔ MCP SERVER",
      kind: "mcp",
      baseUrl: normalizeBase(env("mcp_url")),
    },
  ];

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

export function redisUrl(): string | undefined {
  return env("REDIS_URL") ?? env("REDIS_PRIVATE_URL") ?? env("redis_url");
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

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { parseAdminState, parseHealth } from "../src/lib/dispatch";
import { TokenBucket } from "../src/lib/ratelimit";
import {
  getPublicServices,
  getServices,
  resetConfigCache,
  toPublic,
  validateServices,
} from "../src/lib/config";
import { createBus } from "../src/lib/bus";

describe("parseHealth", () => {
  it("reads bare booleans", () => {
    assert.equal(parseHealth("true"), true);
    assert.equal(parseHealth("false"), false);
    assert.equal(parseHealth("  true  "), true);
  });

  it("reads bare words, in any case", () => {
    for (const on of ["on", "ON", "On", "yes", "up", "enabled", "active", "healthy", "ok", "running"]) {
      assert.equal(parseHealth(on), true, `${on} should be true`);
    }
    for (const off of ["off", "OFF", "no", "down", "disabled", "inactive", "unhealthy", "stopped"]) {
      assert.equal(parseHealth(off), false, `${off} should be false`);
    }
  });

  it("reads numbers", () => {
    assert.equal(parseHealth("1"), true);
    assert.equal(parseHealth("0"), false);
  });

  it("reads quoted JSON strings", () => {
    assert.equal(parseHealth('"on"'), true);
    assert.equal(parseHealth('"off"'), false);
  });

  it("reads objects under any of the recognised keys", () => {
    assert.equal(parseHealth('{"on":true}'), true);
    assert.equal(parseHealth('{"state":"enabled"}'), true);
    assert.equal(parseHealth('{"state":"disabled"}'), false);
    assert.equal(parseHealth('{"enabled":false}'), false);
    assert.equal(parseHealth('{"healthy":1}'), true);
    assert.equal(parseHealth('{"running":0}'), false);
    assert.equal(parseHealth('{"status":"up"}'), true);
  });

  it("ignores unrelated keys and reports it cannot tell", () => {
    assert.equal(parseHealth('{"uptime":123,"region":"us-east"}'), null);
    assert.equal(parseHealth(""), null);
    assert.equal(parseHealth("   "), null);
    assert.equal(parseHealth("maybe"), null);
    assert.equal(parseHealth("<html>not json</html>"), null);
  });

  it("does not treat an unparseable body as OFF", () => {
    // The distinction matters: null lets the caller fall back to a default,
    // whereas false would assert the service is off.
    assert.notEqual(parseHealth("garbage"), false);
  });
});

describe("TokenBucket", () => {
  it("allows a burst up to capacity, then refuses", () => {
    const bucket = new TokenBucket(5, 10);
    const allowed = Array.from({ length: 100 }, () => bucket.take()).filter(Boolean).length;
    assert.equal(allowed, 10);
  });

  it("refills over time at the configured rate", async () => {
    const bucket = new TokenBucket(10, 10);
    while (bucket.take()) { /* drain */ }
    await new Promise((r) => setTimeout(r, 350));
    // ~10/sec for ~0.35s is ~3 tokens; allow slack for timer jitter.
    const refilled = Array.from({ length: 20 }, () => bucket.take()).filter(Boolean).length;
    assert.ok(refilled >= 1 && refilled <= 6, `refilled ${refilled}`);
  });

  it("never exceeds capacity no matter how long it idles", async () => {
    // A slow refill on purpose: at a high rate a single millisecond elapsing
    // during the burst loop grants another token, which made this flaky.
    const bucket = new TokenBucket(1, 4);
    await new Promise((r) => setTimeout(r, 250));
    const allowed = Array.from({ length: 50 }, () => bucket.take()).filter(Boolean).length;
    assert.equal(allowed, 4, "idling must not bank more than the capacity");
  });

  it("lets a human tapping pace through untouched", async () => {
    const bucket = new TokenBucket(5, 10);
    let refused = 0;
    for (let i = 0; i < 12; i += 1) {
      if (!bucket.take()) refused += 1;
      await new Promise((r) => setTimeout(r, 250)); // 4 taps/sec
    }
    assert.equal(refused, 0);
  });
});

describe("config", () => {
  const KEYS = [
    "mcp_url", "mcp_name", "MCP_URL",
    "service_1_url", "service_1_name", "SERVICE_1_URL",
    "service_2_url", "service_2_name",
    "service_3_url", "service_3_name",
    "service_4_url", "service_4_name",
    "page_title", "page_subtitle", "admin_token",
  ];

  beforeEach(() => {
    for (const key of KEYS) delete process.env[key];
    resetConfigCache();
  });

  after(() => {
    for (const key of KEYS) delete process.env[key];
    resetConfigCache();
  });

  it("orders the switches down the call path: worker, MCP, then four APIs", () => {
    const services = getServices();
    assert.equal(services.length, 6);
    assert.deepEqual(services.map((s) => s.id), [
      "agent_worker", "mcp", "service_1", "service_2", "service_3", "service_4",
    ]);
    assert.deepEqual(services.map((s) => s.kind), [
      "worker", "mcp", "api", "api", "api", "api",
    ]);
  });

  it("gives the worker no URL, because nothing is ever POSTed to it", () => {
    const worker = getServices().find((s) => s.id === "agent_worker");
    assert.equal(worker?.baseUrl, undefined);
    // ...and it must not be reported as a misconfiguration, or the operator
    // learns to ignore the boot warnings that do matter.
    assert.ok(!validateServices(getServices()).some((p) => p.includes("agent_worker")));
  });

  it("can be dropped for a rehearsal with no worker running", () => {
    process.env.agent_worker = "0";
    resetConfigCache();
    const services = getServices();
    assert.ok(!services.some((s) => s.id === "agent_worker"));
    assert.equal(services[0].id, "mcp");
    delete process.env.agent_worker;
    resetConfigCache();
  });

  it("keeps a switch even when its URL is missing", () => {
    process.env.service_2_name = "SEARCH";
    resetConfigCache();
    const services = getServices();
    const search = services.find((s) => s.id === "service_2");
    assert.equal(search?.name, "SEARCH");
    assert.equal(search?.baseUrl, undefined);
  });

  it("reads variables case-insensitively", () => {
    process.env.SERVICE_1_URL = "http://example.test:8080";
    resetConfigCache();
    assert.equal(getServices().find((s) => s.id === "service_1")?.baseUrl, "http://example.test:8080");
  });

  it("strips trailing slashes so paths do not double up", () => {
    process.env.mcp_url = "http://example.test:8080///";
    resetConfigCache();
    assert.equal(getServices().find((s) => s.id === "mcp")?.baseUrl, "http://example.test:8080");
  });

  it("never exposes a base URL to the browser", () => {
    process.env.mcp_url = "http://secret.internal:9000";
    process.env.service_1_url = "http://also-secret.internal:9000";
    process.env.mcp_admin_token = "secret-admin-token";
    resetConfigCache();
    const published = JSON.stringify(getPublicServices());
    assert.ok(!published.includes("secret"), published);
    assert.ok(!published.includes("baseUrl"), published);
    assert.ok(!published.includes("adminToken"), published);
    for (const service of toPublic(getServices())) {
      assert.deepEqual(Object.keys(service).sort(), ["id", "kind", "name"]);
    }
    delete process.env.mcp_admin_token;
    resetConfigCache();
  });

  describe("validateServices", () => {
    const base = { id: "service_1", name: "S1", kind: "api" as const };

    it("accepts a well-formed URL", () => {
      assert.deepEqual(validateServices([{ ...base, baseUrl: "http://svc.railway.internal:8080" }]), []);
      assert.deepEqual(validateServices([{ ...base, baseUrl: "https://svc.example.com" }]), []);
    });

    it("flags a missing URL", () => {
      const problems = validateServices([{ ...base, baseUrl: undefined }]);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /service_1_url is not set/);
    });

    it("flags a URL with no scheme", () => {
      const problems = validateServices([{ ...base, baseUrl: "svc.railway.internal:8080" }]);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /missing an http:\/\/ or https:\/\/ scheme/);
    });

    it("flags a Railway private address with no port, the classic mistake", () => {
      const problems = validateServices([{ ...base, baseUrl: "http://svc.railway.internal" }]);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /private address with no port/);
    });

    it("flags a non-http scheme", () => {
      const problems = validateServices([{ ...base, baseUrl: "ftp://svc.example.com" }]);
      assert.ok(problems.some((p) => /scheme/.test(p)), problems.join("; "));
    });

    it("flags a query string on what should be a base URL", () => {
      const problems = validateServices([{ ...base, baseUrl: "http://svc.example.com/?token=x" }]);
      assert.ok(problems.some((p) => /query string/.test(p)));
    });

    it("names the mcp variable correctly", () => {
      const problems = validateServices([{ id: "mcp", name: "MCP", kind: "mcp", baseUrl: undefined }]);
      assert.match(problems[0], /^mcp_url/);
    });
  });
});

describe("in-process bus fallback", () => {
  it("reports no state until something is written, which is the cold-start signal", async () => {
    const bus = await createBus(undefined);
    assert.equal(await bus.getState(), null);
    await bus.putState({ mcp: true, service_1: false });
    assert.deepEqual(await bus.getState(), { mcp: true, service_1: false });
    await bus.close();
  });

  it("reports no gate until one is set, so the caller can default to locked", async () => {
    const bus = await createBus(undefined);
    assert.equal(await bus.getArmed(), null);
    await bus.setArmed(true);
    assert.equal(await bus.getArmed(), true);
    await bus.setArmed(false);
    assert.equal(await bus.getArmed(), false);
    await bus.close();
  });

  it("delivers published events to subscribers", async () => {
    const bus = await createBus(undefined);
    const seen: string[] = [];
    bus.subscribe((event) => seen.push(event.t));
    await bus.publish({ t: "state", id: "mcp", v: true, ts: 1 });
    await bus.publish({ t: "armed", v: true, ts: 2 });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, ["state", "armed"]);
    await bus.close();
  });

  it("hands the seed lock to exactly one caller", async () => {
    const bus = await createBus(undefined);
    assert.equal(await bus.acquireSeedLock(30), true);
    assert.equal(await bus.acquireSeedLock(30), false);
    await bus.releaseSeedLock();
    assert.equal(await bus.acquireSeedLock(30), true);
    await bus.close();
  });
});

/*
 * The MCP server speaks its own control dialect, on purpose: its chaos levers
 * are gated on an admin bearer AND on arriving at the internal listener, so
 * that a leaked token alone cannot reach them from the conference floor. The
 * board is the one caller that has to know about that.
 */
describe("the MCP server's control dialect", () => {
  it("reads the master switch out of /admin/state", () => {
    assert.equal(parseAdminState('{"global":true,"services":[]}'), true);
    assert.equal(parseAdminState('{"global":false,"services":[]}'), false);
  });

  it("does not guess when the shape is not what we expect", () => {
    // Better a cold start that falls back than one that seeds every switch
    // from a payload we misread.
    assert.equal(parseAdminState('{"services":[]}'), null);
    assert.equal(parseAdminState('{"global":"yes"}'), null);
    assert.equal(parseAdminState("not json"), null);
  });

  it("keeps `global` out of the generic health parser", () => {
    // `global` is a word plenty of unrelated payloads carry. Widening the
    // shared parser to catch it here would make it guess wrong elsewhere.
    assert.equal(parseHealth('{"global":false}'), null);
  });

  it("carries the token only when one is configured", () => {
    process.env.mcp_url = "http://mcp.internal:8081";
    process.env.mcp_admin_token = "tok";
    resetConfigCache();
    assert.equal(getServices().find((s) => s.id === "mcp")?.adminToken, "tok");

    delete process.env.mcp_admin_token;
    resetConfigCache();
    // No token means the /on + /off dialect, which is what the dev shim serves.
    assert.equal(getServices().find((s) => s.id === "mcp")?.adminToken, undefined);
  });
});

/*
 * Queued/fulfilled counts, read from the stage screen.
 *
 * Against a real local server rather than a mocked undici: what breaks here is
 * the shape of somebody else's JSON, and a mock would agree with whatever this
 * code expects rather than with what the stage screen actually sends.
 */
describe("fetchOrderCounts", () => {
  const servers: import("node:http").Server[] = [];

  async function stageScreen(body: string, status = 200): Promise<number> {
    const { createServer } = await import("node:http");
    const { once } = await import("node:events");
    const server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" }).end(body);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return (server.address() as { port: number }).port;
  }

  const snapshot = (queued: number, completed: number): string =>
    JSON.stringify({
      seq: 1,
      orders_in_flight: queued,
      scoreboard: { orders_completed: completed, worker_deaths: 0 },
      board: { components: [] },
    });

  beforeEach(() => {
    delete process.env.stage_url;
  });

  after(() => {
    for (const server of servers) server.close();
    delete process.env.stage_url;
  });

  it("returns null when no stage screen is configured", async () => {
    const { fetchOrderCounts } = await import("../src/lib/orders");
    assert.equal(await fetchOrderCounts(), null);
  });

  it("reads both numbers out of a real snapshot", async () => {
    const port = await stageScreen(snapshot(47, 1179));
    process.env.stage_url = `http://127.0.0.1:${port}`;

    const { fetchOrderCounts } = await import("../src/lib/orders");
    assert.deepEqual(await fetchOrderCounts(), { queued: 47, completed: 1179 });
  });

  it("keeps a legitimate zero", async () => {
    // Guards the obvious bug: treating 0 as missing and returning null, which
    // would make the counters vanish the moment a batch drains.
    const port = await stageScreen(snapshot(0, 0));
    process.env.stage_url = `http://127.0.0.1:${port}`;

    const { fetchOrderCounts } = await import("../src/lib/orders");
    assert.deepEqual(await fetchOrderCounts(), { queued: 0, completed: 0 });
  });

  it("returns null rather than NaN when a field is missing", async () => {
    // Showing NaN on a few hundred phones is worse than showing nothing.
    const port = await stageScreen(JSON.stringify({ seq: 1, scoreboard: {} }));
    process.env.stage_url = `http://127.0.0.1:${port}`;

    const { fetchOrderCounts } = await import("../src/lib/orders");
    assert.equal(await fetchOrderCounts(), null);
  });

  it("returns null on a non-200 even when the body still parses", async () => {
    // The body is a perfectly good snapshot; only the status says otherwise.
    // An error page or a stale cached response that happens to parse is the
    // case the status check exists for -- with a body that does NOT parse the
    // NaN guard catches it anyway and this proves nothing.
    const port = await stageScreen(snapshot(12, 340), 503);
    process.env.stage_url = `http://127.0.0.1:${port}`;

    const { fetchOrderCounts } = await import("../src/lib/orders");
    assert.equal(await fetchOrderCounts(), null);
  });

  it("returns null, without throwing, when the stage screen is not there", async () => {
    // The board has to keep working on a laptop with no stage screen running.
    process.env.stage_url = "http://127.0.0.1:1";

    const { fetchOrderCounts } = await import("../src/lib/orders");
    assert.equal(await fetchOrderCounts(), null);
  });

  it("returns null on a body that is not JSON", async () => {
    const port = await stageScreen("<html>bad gateway</html>");
    process.env.stage_url = `http://127.0.0.1:${port}`;

    const { fetchOrderCounts } = await import("../src/lib/orders");
    assert.equal(await fetchOrderCounts(), null);
  });
});

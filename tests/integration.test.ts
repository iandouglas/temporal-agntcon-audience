/**
 * End-to-end tests against a real server process, real WebSockets and real
 * backend services.
 *
 * Requires `npm run build` first (the `pretest` script does this). Tests that
 * need Redis are skipped with a message if `redis-server` is not installed,
 * so the suite still runs usefully without it.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  adminState, connect, connectControl, hello, lastStats, sawArmed, sawState,
  sleep, startReplica, startRedis, startStub, waitFor,
  type Client, type Replica, type RedisHandle, type Stub,
} from "./helpers";

const TOKEN = "test-token";
const STUB_PORTS = { mcp: 4901, services: [4902, 4903, 4904, 4905] };
const REDIS_PORT = 4906;
const PORT_A = 4907;
const PORT_B = 4908;

let stubs: Record<string, Stub>;
let redis: RedisHandle | null;
let a: Replica;

/** The five stubs, each with a different /health shape and starting position. */
async function startStubs(): Promise<Record<string, Stub>> {
  return {
    mcp: await startStub(STUB_PORTS.mcp, "bool", true),
    service_1: await startStub(STUB_PORTS.services[0], "obj", false),
    service_2: await startStub(STUB_PORTS.services[1], "word", true),
    service_3: await startStub(STUB_PORTS.services[2], "nested", false),
    service_4: await startStub(STUB_PORTS.services[3], "bool", false),
  };
}

before(async () => {
  stubs = await startStubs();
  redis = startRedis(REDIS_PORT);
  if (redis) await sleep(600);
  a = await startReplica({ port: PORT_A, redisUrl: redis?.url, stubPorts: STUB_PORTS, adminToken: TOKEN });
});

after(async () => {
  await a?.stop();
  for (const stub of Object.values(stubs ?? {})) await stub.close();
  redis?.stop();
});

describe("boot", () => {
  it("seeds from /health, reading every response shape correctly", async () => {
    const { state } = await adminState(a.base, TOKEN);
    assert.deepEqual(state, {
      mcp: true,        // "true"
      service_1: false, // {"on":false}
      service_2: true,  // "ON"
      service_3: false, // {"state":"disabled"}
      service_4: false, // "false"
    });
  });

  it("validates the configured URLs", () => {
    assert.match(a.log(), /all 5 service URLs look well-formed/);
  });

  it("still binds a reachable address when HOSTNAME is a container id", async () => {
    // Docker and Railway set HOSTNAME to the container id. An earlier version
    // used it as the bind address, which produced a 502 from a process whose
    // logs said "listening" -- the platform proxy could not reach it.
    const ports = { mcp: 4941, services: [4942, 4943, 4944, 4945] };
    const extraStubs = [
      await startStub(ports.mcp, "bool", true),
      await startStub(ports.services[0], "obj", false),
      await startStub(ports.services[1], "word", true),
      await startStub(ports.services[2], "nested", false),
      await startStub(ports.services[3], "bool", false),
    ];
    const replica = await startReplica({
      port: 4946,
      stubPorts: ports,
      adminToken: TOKEN,
      extraEnv: { HOSTNAME: "8f5959c7f7ba" },
    });

    const body = (await (await fetch(`${replica.base}/healthz`)).json()) as { ok: boolean };
    assert.equal(body.ok, true, "the server must be reachable regardless of HOSTNAME");
    assert.ok(!replica.log().includes("8f5959c7f7ba"), "must not bind to the container id");

    await replica.stop();
    for (const stub of extraStubs) await stub.close();
  });

  it("serves a health endpoint for the platform", async () => {
    const body = (await (await fetch(`${a.base}/healthz`)).json()) as { ok: boolean; bus: { kind: string } };
    assert.equal(body.ok, true);
    assert.equal(body.bus.kind, redis ? "redis" : "memory");
  });
});

describe("secrets", () => {
  it("never sends a service URL to the browser", async () => {
    const html = await (await fetch(a.base)).text();
    for (const port of [STUB_PORTS.mcp, ...STUB_PORTS.services]) {
      assert.ok(!html.includes(String(port)), `port ${port} leaked into the page`);
    }
    assert.ok(!html.includes("127.0.0.1"));
    assert.ok(!html.includes("baseUrl"));
  });

  it("does send the service names, so the page can label the switches", async () => {
    const html = await (await fetch(a.base)).text();
    assert.ok(html.includes("SERVICE 1"));
    assert.ok(html.includes("AGENT MCP"));
  });

  it("rejects admin requests without the token", async () => {
    assert.equal((await fetch(`${a.base}/api/admin/state`)).status, 401);
    assert.equal((await fetch(`${a.base}/api/admin/reseed`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${a.base}/api/admin/reset-counters`, { method: "POST" })).status, 401);
  });

  it("rejects admin requests with a wrong token", async () => {
    const res = await fetch(`${a.base}/api/admin/state`, { headers: { authorization: "Bearer nope" } });
    assert.equal(res.status, 401);
  });

  it("refuses a control socket without the token", async () => {
    await assert.rejects(() => connect(a.base, "?role=control&token=wrong"));
  });
});

describe("the audience gate", () => {
  let audience: Client;
  let control: Client;

  before(async () => {
    audience = await connect(a.base);
    control = await connectControl(a.base, TOKEN);
    await sleep(300);
  });

  after(() => {
    audience.close();
    control.close();
  });

  it("starts locked on a cold boot", () => {
    assert.equal(hello(audience)?.armed, false);
  });

  it("blocks a client that ignores the disabled UI", async () => {
    const before = stubs.service_1.calls;
    const stateBefore = (await adminState(a.base, TOKEN)).state;
    for (let i = 0; i < 20; i += 1) {
      audience.send(JSON.stringify({ t: "toggle", id: "service_1", v: true }));
    }
    await sleep(600);
    assert.equal(stubs.service_1.calls, before, "a locked gate must not reach the service");
    assert.deepEqual((await adminState(a.base, TOKEN)).state, stateBefore);
  });

  it("will not let an audience socket open the floor", async () => {
    audience.send(JSON.stringify({ t: "arm", v: true }));
    await sleep(400);
    assert.equal((await adminState(a.base, TOKEN)).armed, false);
  });

  it("opens for everyone when the operator says so", async () => {
    audience.messages.length = 0;
    control.send(JSON.stringify({ t: "arm", v: true }));
    await waitFor("audience told the floor is open", () => sawArmed(audience, true));
    assert.equal((await adminState(a.base, TOKEN)).armed, true);
  });

  it("lets taps through once open", async () => {
    const before = stubs.service_1.calls;
    audience.send(JSON.stringify({ t: "toggle", id: "service_1", v: true }));
    await waitFor("service called", () => stubs.service_1.calls === before + 1);
    assert.equal(stubs.service_1.on, true);
  });

  it("closes again on demand", async () => {
    audience.messages.length = 0;
    control.send(JSON.stringify({ t: "arm", v: false }));
    await waitFor("audience told the floor is closed", () => sawArmed(audience, false));

    const before = stubs.service_1.calls;
    for (let i = 0; i < 10; i += 1) audience.send(JSON.stringify({ t: "toggle", id: "service_1", v: false }));
    await sleep(600);
    assert.equal(stubs.service_1.calls, before);
  });

  it("still lets the operator drive services with the floor closed", async () => {
    const before = stubs.service_2.calls;
    control.send(JSON.stringify({ t: "force", id: "service_2", v: false }));
    await waitFor("forced call", () => stubs.service_2.calls === before + 1);
    assert.equal(stubs.service_2.on, false);
  });
});

describe("taps and dispatch", () => {
  let audience: Client;
  let other: Client;
  let control: Client;

  before(async () => {
    control = await connectControl(a.base, TOKEN);
    await sleep(200);
    control.send(JSON.stringify({ t: "arm", v: true }));
    await sleep(400);
    audience = await connect(a.base);
    other = await connect(a.base);
    await sleep(300);
  });

  after(() => {
    audience.close();
    other.close();
    control.close();
  });

  it("shows one phone's tap on every other phone", async () => {
    other.messages.length = 0;
    audience.send(JSON.stringify({ t: "toggle", id: "service_3", v: true }));
    await waitFor("broadcast", () => sawState(other, "service_3", true));
  });

  it("sends exactly one POST per tap, to the right endpoint", async () => {
    stubs.service_4.hits.length = 0;
    audience.send(JSON.stringify({ t: "toggle", id: "service_4", v: true }));
    await waitFor("on", () => stubs.service_4.hits.length === 1);
    audience.send(JSON.stringify({ t: "toggle", id: "service_4", v: false }));
    await waitFor("off", () => stubs.service_4.hits.length === 2);
    assert.deepEqual(stubs.service_4.hits, ["on", "off"]);
  });

  it("re-asserts a position the service already holds, which is what makes the bulk reset work", async () => {
    stubs.service_4.hits.length = 0;
    assert.equal(stubs.service_4.on, false);
    control.send(JSON.stringify({ t: "force", id: "service_4", v: false }));
    await waitFor("redundant off still dispatched", () => stubs.service_4.hits.length === 1);
    assert.deepEqual(stubs.service_4.hits, ["off"]);
  });

  it("corrects a service that drifted, rather than adopting the drift", async () => {
    control.send(JSON.stringify({ t: "force", id: "service_4", v: true }));
    await waitFor("on", () => stubs.service_4.on === true);
    stubs.service_4.drift(false); // the service restarts and comes back off
    control.send(JSON.stringify({ t: "force", id: "service_4", v: true }));
    await waitFor("driven back on", () => stubs.service_4.on === true);
  });

  it("caps one socket without silencing the board", async () => {
    const before = stubs.service_2.calls;
    for (let i = 0; i < 100; i += 1) {
      audience.send(JSON.stringify({ t: "toggle", id: "service_2", v: i % 2 === 0 }));
    }
    await sleep(1200);
    const allowed = stubs.service_2.calls - before;
    assert.ok(allowed >= 8 && allowed <= 20, `${allowed} of 100 POSTs allowed`);

    // The state still moved, and the taps were still counted.
    await waitFor("taps counted", () => (lastStats(control)?.taps.service_2 ?? 0) >= 100);
  });

  it("refuses force from an audience socket", async () => {
    const before = stubs.service_3.calls;
    audience.send(JSON.stringify({ t: "force", id: "service_3", v: false }));
    await sleep(400);
    assert.equal(stubs.service_3.calls, before);
  });

  it("ignores nonsense without falling over", async () => {
    audience.send("not json at all");
    audience.send(JSON.stringify({ t: "toggle", id: "no_such_service", v: true }));
    audience.send(JSON.stringify({ t: "toggle", id: 42, v: "yes" }));
    audience.send(JSON.stringify({ t: "unknown" }));
    await sleep(400);
    assert.equal(((await (await fetch(`${a.base}/healthz`)).json()) as { ok: boolean }).ok, true);
  });
});

describe("operator counters", () => {
  let control: Client;
  let audience: Client;

  before(async () => {
    control = await connectControl(a.base, TOKEN);
    await sleep(200);
    control.send(JSON.stringify({ t: "arm", v: true }));
    await sleep(300);
    audience = await connect(a.base);
    await sleep(300);

    // Start from zero. Earlier suites leave taps and last-call entries behind,
    // and asserting against those would let a test pass on a stale value while
    // its own POST is still in flight.
    control.send(JSON.stringify({ t: "reset-counters" }));
    await waitFor(
      "counters clean before this suite",
      () => {
        const stats = lastStats(control);
        return Boolean(stats)
          && Object.values(stats!.taps).every((n) => n === 0)
          && Object.values(stats!.dispatch).every((d) => d === null);
      },
      { detail: () => JSON.stringify(lastStats(control)) },
    );
  });

  after(() => {
    control.close();
    audience.close();
  });

  it("counts taps and records the last call per service", async () => {
    audience.send(JSON.stringify({ t: "toggle", id: "service_1", v: true }));
    await waitFor(
      "tap counted and call recorded",
      () => {
        const stats = lastStats(control);
        return Boolean(stats && stats.taps.service_1 > 0 && stats.dispatch.service_1);
      },
      { detail: () => JSON.stringify(lastStats(control)) },
    );
  });

  it("resets every counter on request", async () => {
    control.messages.length = 0;
    control.send(JSON.stringify({ t: "reset-counters" }));
    await waitFor(
      "counters cleared",
      () => {
        const stats = lastStats(control);
        if (!stats) return false;
        return Object.values(stats.taps).every((n) => n === 0)
          && Object.values(stats.dispatch).every((d) => d === null);
      },
      { detail: () => JSON.stringify({ taps: lastStats(control)?.taps, dispatch: lastStats(control)?.dispatch }) },
    );
  });

  it("leaves the switch positions alone when resetting counters", async () => {
    const before = (await adminState(a.base, TOKEN)).state;
    control.send(JSON.stringify({ t: "reset-counters" }));
    await sleep(500);
    assert.deepEqual((await adminState(a.base, TOKEN)).state, before);
  });

  it("resets over HTTP too, for a phone with curl", async () => {
    audience.send(JSON.stringify({ t: "toggle", id: "service_1", v: false }));
    await waitFor(
      "tap counted and its call recorded",
      () => {
        const stats = lastStats(control);
        return Boolean(stats && stats.taps.service_1 > 0 && stats.dispatch.service_1);
      },
      { detail: () => JSON.stringify(lastStats(control)) },
    );
    const res = await fetch(`${a.base}/api/admin/reset-counters`, {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    await waitFor(
      "cleared via HTTP",
      () => Object.values(lastStats(control)?.taps ?? { x: 1 }).every((n) => n === 0),
      { detail: () => JSON.stringify(lastStats(control)?.taps) },
    );
  });

  it("refuses a counter reset from an audience socket", async () => {
    audience.send(JSON.stringify({ t: "toggle", id: "service_1", v: true }));
    await waitFor(
      "tap counted",
      () => (lastStats(control)?.taps.service_1 ?? 0) > 0,
      { detail: () => JSON.stringify(lastStats(control)?.taps) },
    );
    audience.send(JSON.stringify({ t: "reset-counters" }));
    await sleep(600);
    assert.ok((lastStats(control)?.taps.service_1 ?? 0) > 0, "an audience socket must not clear the counters");
  });
});

describe("reseed", () => {
  it("adopts what the services report, without changing them", async () => {
    const control = await connectControl(a.base, TOKEN);
    await sleep(200);

    stubs.service_1.drift(true);
    stubs.service_2.drift(false);
    stubs.service_3.drift(true);
    const callsBefore = stubs.service_1.calls;

    const res = await fetch(`${a.base}/api/admin/reseed`, {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await res.json()) as { ok: boolean; state: Record<string, boolean> };
    assert.equal(body.ok, true);
    assert.equal(body.state.service_1, true);
    assert.equal(body.state.service_2, false);
    assert.equal(body.state.service_3, true);
    assert.equal(stubs.service_1.calls, callsBefore, "reseed must not drive the services");
    control.close();
  });
});

/**
 * Behaviour that only appears with a real Redis: two replicas agreeing, state
 * surviving a restart, and the site staying up when Redis does not.
 *
 * Skipped entirely when `redis-server` is not installed.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";
import { once } from "node:events";
import {
  adminState, connect, connectControl, hasRedisServer, hello, lastStats, sawArmed, sawState,
  sleep, startRedis, startReplica, startStub, waitFor,
  type Client, type RedisHandle, type Replica, type Stub,
} from "./helpers";

const TOKEN = "repl-token";
const STUB_PORTS = { mcp: 4911, services: [4912, 4913, 4914, 4915] };
const REDIS_PORT = 4916;
const PORT_A = 4917;
const PORT_B = 4918;
const CROWD = Number(process.env.TEST_CROWD ?? 300);

const redisAvailable = hasRedisServer();
const skip = redisAvailable ? false : "redis-server is not installed";

describe("replication", { skip }, () => {
  let stubs: Record<string, Stub>;
  let redis: RedisHandle;
  let a: Replica;
  let b: Replica;

  // Started together, so the seed lock is genuinely contended rather than one
  // replica simply finding state the other already wrote.
  const startBoth = async (): Promise<void> => {
    [a, b] = await Promise.all([
      startReplica({ port: PORT_A, redisUrl: redis.url, stubPorts: STUB_PORTS, adminToken: TOKEN }),
      startReplica({ port: PORT_B, redisUrl: redis.url, stubPorts: STUB_PORTS, adminToken: TOKEN }),
    ]);
  };

  before(async () => {
    stubs = {
      mcp: await startStub(STUB_PORTS.mcp, "bool", true),
      service_1: await startStub(STUB_PORTS.services[0], "obj", false),
      service_2: await startStub(STUB_PORTS.services[1], "word", true),
      service_3: await startStub(STUB_PORTS.services[2], "nested", false),
      service_4: await startStub(STUB_PORTS.services[3], "bool", false),
    };
    redis = startRedis(REDIS_PORT)!;
    await sleep(700);
    redis.flush(); // a previous run may have left state behind
    await startBoth();
  });

  after(async () => {
    await a?.stop();
    await b?.stop();
    for (const stub of Object.values(stubs ?? {})) await stub.close();
    redis?.stop();
  });

  describe("two replicas", () => {
    let ca: Client;
    let cb: Client;
    let control: Client;

    before(async () => {
      control = await connectControl(a.base, TOKEN);
      await sleep(300);
      control.send(JSON.stringify({ t: "arm", v: true }));
      await sleep(500);
      ca = await connect(a.base);
      cb = await connect(b.base);
      await sleep(400);
    });

    after(() => {
      ca.close(); cb.close(); control.close();
    });

    it("elects exactly one seeder on a simultaneous cold boot", () => {
      const logs = [a.log(), b.log()];
      const seeders = logs.filter((l) => l.includes("cold start -- probing /health")).length;
      const adopters = logs.filter((l) => /adopted (existing state from redis|state seeded by another replica)/.test(l)).length;
      assert.equal(seeders, 1, `exactly one replica should probe /health\nA:\n${a.log()}\nB:\n${b.log()}`);
      assert.equal(adopters, 1, "the other should adopt what it wrote");
    });

    it("serves the same state from both replicas", () => {
      assert.deepEqual(hello(ca)?.state, hello(cb)?.state);
    });

    it("propagates the gate to clients on the other replica", () => {
      assert.equal(hello(cb)?.armed, true);
    });

    it("shows a tap on replica A to a phone on replica B", async () => {
      cb.messages.length = 0;
      ca.send(JSON.stringify({ t: "toggle", id: "service_3", v: true }));
      await waitFor("B saw A's tap", () => sawState(cb, "service_3", true));
      assert.equal(stubs.service_3.on, true);
    });

    it("shows a tap on replica B to a phone on replica A", async () => {
      ca.messages.length = 0;
      cb.send(JSON.stringify({ t: "toggle", id: "service_3", v: false }));
      await waitFor("A saw B's tap", () => sawState(ca, "service_3", false));
      assert.equal(stubs.service_3.on, false);
    });

    it("closes the floor everywhere at once", async () => {
      ca.messages.length = 0; cb.messages.length = 0;
      control.send(JSON.stringify({ t: "arm", v: false }));
      await waitFor("both told", () => sawArmed(ca, false) && sawArmed(cb, false));

      const before = stubs.service_1.calls;
      cb.send(JSON.stringify({ t: "toggle", id: "service_1", v: true }));
      await sleep(600);
      assert.equal(stubs.service_1.calls, before, "the gate must hold on the replica the operator is not on");

      control.send(JSON.stringify({ t: "arm", v: true }));
      await waitFor("reopened", () => sawArmed(cb, true));
    });

    it("aggregates connected counts across replicas", async () => {
      await waitFor(
        "counts include both replicas",
        () => (lastStats(control)?.conns ?? 0) >= 3,
        { timeoutMs: 10_000, detail: () => `conns=${lastStats(control)?.conns}` },
      );
    });

    it("aggregates tap counts across replicas", async () => {
      // Measured against a baseline rather than after a reset: resetting and
      // immediately tapping races the reset reaching the second replica, and a
      // tap counted there just before it lands is dropped. Counters are display
      // only, so that race is tolerable in production but makes a bad assertion.
      await waitFor("stats available", () => Boolean(lastStats(control)));
      const start = lastStats(control)!.taps.service_4 ?? 0;

      ca.send(JSON.stringify({ t: "toggle", id: "service_4", v: true }));
      cb.send(JSON.stringify({ t: "toggle", id: "service_4", v: false }));

      await waitFor(
        "one tap from each replica counted exactly once",
        () => (lastStats(control)?.taps.service_4 ?? 0) === start + 2,
        { detail: () => `started at ${start}, now ${JSON.stringify(lastStats(control)?.taps)}` },
      );
    });

    it("resets counters on every replica, not just the operator's", async () => {
      const controlB = await connectControl(b.base, TOKEN);
      await sleep(1200);
      control.send(JSON.stringify({ t: "reset-counters" }));
      await waitFor(
        "replica B's view cleared too",
        () => Object.values(lastStats(controlB)?.taps ?? { x: 1 }).every((n) => n === 0),
        { detail: () => JSON.stringify(lastStats(controlB)?.taps) },
      );
      controlB.close();
    });
  });

  describe("a crowd", () => {
    it(`carries ${CROWD} sockets split across both replicas and delivers every tap`, async () => {
      const control = await connectControl(a.base, TOKEN);
      await sleep(300);
      control.send(JSON.stringify({ t: "arm", v: true }));
      await sleep(400);

      const sockets: WebSocket[] = [];
      await Promise.all(
        Array.from({ length: CROWD }, (_, i) => {
          const ws = new WebSocket(`ws://127.0.0.1:${i % 2 ? PORT_B : PORT_A}/ws`);
          return once(ws, "open").then(() => { sockets.push(ws); }).catch(() => undefined);
        }),
      );
      assert.equal(sockets.length, CROWD, "every socket should connect");

      const ids = ["mcp", "service_1", "service_2", "service_3", "service_4"];
      const before = Object.fromEntries(Object.entries(stubs).map(([k, s]) => [k, s.calls]));

      // One tap each, spread over a few seconds, the way a room actually behaves.
      await Promise.all(sockets.map((ws, i) =>
        sleep(Math.random() * 3000).then(() =>
          ws.send(JSON.stringify({ t: "toggle", id: ids[i % ids.length], v: i % 2 === 0 })))));

      await waitFor(
        "every tap dispatched",
        () => Object.entries(stubs).reduce((sum, [k, s]) => sum + (s.calls - before[k]), 0) === CROWD,
        {
          timeoutMs: 20_000,
          detail: () => `${Object.entries(stubs).reduce((sum, [k, s]) => sum + (s.calls - before[k]), 0)}/${CROWD}`,
        },
      );

      for (const base of [a.base, b.base]) {
        const health = (await (await fetch(`${base}/healthz`)).json()) as {
          pool: { inFlight: number; queued: number }; bus: { healthy: boolean };
        };
        assert.equal(health.pool.queued, 0, "nothing should still be queued");
        assert.equal(health.pool.inFlight, 0, "nothing should still be in flight");
        assert.equal(health.bus.healthy, true);
      }

      for (const ws of sockets) ws.close();
      control.close();
    });
  });

  describe("a restart mid-demo", () => {
    it("comes back with the crowd's state and the operator's gate, without re-reading /health", async () => {
      const control = await connectControl(a.base, TOKEN);
      await sleep(300);
      control.send(JSON.stringify({ t: "arm", v: true }));
      control.send(JSON.stringify({ t: "force", id: "service_2", v: true }));
      control.send(JSON.stringify({ t: "force", id: "service_3", v: false }));
      await sleep(700);
      const before = await adminState(a.base, TOKEN);
      control.close();

      // The services report something different from what the crowd chose, so
      // adopting Redis rather than /health is observable.
      stubs.service_2.drift(false);
      const healthCallsBefore = stubs.service_2.calls;

      await a.stop();
      a = await startReplica({ port: PORT_A, redisUrl: redis.url, stubPorts: STUB_PORTS, adminToken: TOKEN });

      const after = await adminState(a.base, TOKEN);
      assert.deepEqual(after.state, before.state, "state must survive the restart");
      assert.equal(after.armed, true, "a redeploy must not lock the room out");
      assert.match(a.log(), /adopted existing state from redis/);
      assert.ok(!a.log().includes("cold start"), "a warm start must not re-probe /health");
      assert.equal(stubs.service_2.calls, healthCallsBefore, "restart must not drive the services");
    });
  });

  describe("a Redis outage mid-demo", () => {
    it("keeps the room working, reports itself degraded, and re-syncs on recovery", async () => {
      const control = await connectControl(a.base, TOKEN);
      await sleep(300);
      control.send(JSON.stringify({ t: "arm", v: true }));
      await sleep(400);
      const tapper = await connect(a.base);
      const watcher = await connect(a.base);
      await sleep(400);

      redis.kill();
      await waitFor(
        "bus reported degraded",
        async () => !(await adminState(a.base, TOKEN)).bus.healthy,
        { timeoutMs: 15_000 },
      );

      // The demo must keep working on this replica.
      watcher.messages.length = 0;
      const before = stubs.service_1.calls;
      tapper.send(JSON.stringify({ t: "toggle", id: "service_1", v: true }));
      await waitFor("service still called", () => stubs.service_1.calls === before + 1);
      await waitFor("other phone still updated", () => sawState(watcher, "service_1", true));

      // And the gate must still hold.
      control.send(JSON.stringify({ t: "arm", v: false }));
      await waitFor("floor closed", () => sawArmed(tapper, false));
      const locked = stubs.service_1.calls;
      tapper.send(JSON.stringify({ t: "toggle", id: "service_1", v: false }));
      await sleep(600);
      assert.equal(stubs.service_1.calls, locked, "the gate must hold without Redis");
      control.send(JSON.stringify({ t: "arm", v: true }));
      await sleep(300);

      assert.ok(!a.log().includes("unhandledRejection"), "an outage must not raise unhandled rejections");

      redis.start();
      await waitFor(
        "bus recovered",
        async () => (await adminState(a.base, TOKEN)).bus.healthy,
        { timeoutMs: 25_000 },
      );
      await waitFor(
        "local state pushed back into Redis",
        () => a.log().includes("pushed local state back to Redis"),
        { timeoutMs: 15_000 },
      );

      // Normal operation resumes.
      const resumed = stubs.service_1.calls;
      tapper.send(JSON.stringify({ t: "toggle", id: "service_1", v: false }));
      await waitFor("taps work again", () => stubs.service_1.calls === resumed + 1);

      tapper.close(); watcher.close(); control.close();
    });
  });
});

describe("without Redis", () => {
  it("still runs a single replica correctly, on the in-process bus", async () => {
    const ports = { mcp: 4921, services: [4922, 4923, 4924, 4925] };
    const stubs = [
      await startStub(ports.mcp, "bool", true),
      await startStub(ports.services[0], "obj", false),
      await startStub(ports.services[1], "word", true),
      await startStub(ports.services[2], "nested", false),
      await startStub(ports.services[3], "bool", false),
    ];
    const replica = await startReplica({ port: 4926, stubPorts: ports, adminToken: TOKEN });

    assert.match(replica.log(), /REDIS_URL is not set/);
    const state = await adminState(replica.base, TOKEN);
    assert.equal(state.bus.kind, "memory");
    assert.equal(state.state.mcp, true);
    assert.equal(state.armed, false, "still locked by default without Redis");

    const control = await connectControl(replica.base, TOKEN);
    await sleep(300);
    control.send(JSON.stringify({ t: "arm", v: true }));
    await sleep(400);
    const audience = await connect(replica.base);
    await sleep(300);
    const before = stubs[1].calls;
    audience.send(JSON.stringify({ t: "toggle", id: "service_1", v: true }));
    await waitFor("dispatched", () => stubs[1].calls === before + 1);

    audience.close(); control.close();
    await replica.stop();
    for (const stub of stubs) await stub.close();
  });
});

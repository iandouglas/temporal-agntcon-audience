/**
 * Browser tests for the surface the audience actually touches.
 *
 * Playwright is deliberately NOT a dependency of this project: the `playwright`
 * package downloads several hundred megabytes of browsers on install, which
 * would land in every Railway build for no benefit. These tests skip unless it
 * is installed locally:
 *
 *     npm i --no-save playwright && npx playwright install webkit
 *     npm run test:ui
 *
 * WebKit is used because the audience is overwhelmingly on iOS Safari, and it is
 * the engine most likely to disagree about dvh units and -webkit-text-stroke.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, describe, it } from "node:test";
import type { Browser, Page } from "playwright";
import { connectControl, sleep, startReplica, startStub, type Client, type Replica, type Stub } from "./helpers";

const require = createRequire(import.meta.url);
let playwrightAvailable = true;
try {
  require.resolve("playwright");
} catch {
  playwrightAvailable = false;
}

const TOKEN = "ui-token";
const STUB_PORTS = { mcp: 4931, services: [4932, 4933, 4934, 4935] };
const PORT = 4936;

const VIEWPORTS = [
  { name: "iPhone SE", width: 375, height: 667, dpr: 2 },
  { name: "iPhone 14 Pro", width: 393, height: 852, dpr: 3 },
  { name: "Pixel 7", width: 412, height: 915, dpr: 2.6 },
  { name: "phone landscape", width: 844, height: 390, dpr: 3 },
  { name: "iPad", width: 820, height: 1180, dpr: 2 },
];

describe("browser", { skip: playwrightAvailable ? false : "playwright is not installed (see this file's header)" }, () => {
  let browser: Browser;
  let stubs: Stub[];
  let app: Replica;
  let control: Client;

  before(async () => {
    const { webkit } = (await import("playwright")) as typeof import("playwright");
    browser = await webkit.launch();
    stubs = [
      await startStub(STUB_PORTS.mcp, "bool", true),
      await startStub(STUB_PORTS.services[0], "obj", false),
      await startStub(STUB_PORTS.services[1], "word", true),
      await startStub(STUB_PORTS.services[2], "nested", false),
      await startStub(STUB_PORTS.services[3], "bool", false),
    ];
    app = await startReplica({ port: PORT, stubPorts: STUB_PORTS, adminToken: TOKEN });
    control = await connectControl(app.base, TOKEN);
    await sleep(300);
  });

  after(async () => {
    control?.close();
    await browser?.close();
    await app?.stop();
    for (const stub of stubs ?? []) await stub.close();
  });

  const arm = async (value: boolean): Promise<void> => {
    control.send(JSON.stringify({ t: "arm", v: value }));
    await sleep(500);
  };

  const openBoard = async (
    viewport: { width: number; height: number; dpr: number },
    role: "breaker" | "fixer" = "breaker",
  ): Promise<Page> => {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.dpr,
      isMobile: true,
      hasTouch: true,
    });
    await context.addCookies([{ name: "mep_role", value: role, url: app.base }]);
    const page = await context.newPage();
    await page.goto(app.base, { waitUntil: "networkidle" });
    await page.waitForSelector('.board[data-ready="true"]');
    await page.waitForTimeout(400);
    return page;
  };

  describe("layout", () => {
    before(async () => { await arm(true); });

    for (const viewport of VIEWPORTS) {
      it(`fits all six switches on ${viewport.name} with no scrolling`, async () => {
        const page = await openBoard(viewport);
        const report = await page.evaluate(() => {
          const cards = [...document.querySelectorAll(".card")];
          const boxes = cards.map((el) => el.getBoundingClientRect());
          return {
            count: cards.length,
            namesClipped: cards.filter((c) => {
              const n = c.querySelector(".card-name");
              return n ? n.scrollHeight > n.clientHeight + 1 : true;
            }).length,
            allVisible: boxes.every((b) => b.top >= 0 && b.bottom <= window.innerHeight),
            lastBottom: Math.max(...boxes.map((b) => b.bottom)),
            viewportHeight: window.innerHeight,
            scrollHeight: document.documentElement.scrollHeight,
            scrollWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
          };
        });

        assert.equal(report.count, 6, "all six cards should render");
        assert.equal(report.namesClipped, 0, "no service name may be clipped");
        assert.ok(report.allVisible, `last switch ends at ${report.lastBottom} of ${report.viewportHeight}`);
        assert.ok(report.scrollHeight <= report.viewportHeight + 1,
          `page scrolls vertically: ${report.scrollHeight} > ${report.viewportHeight}`);
        assert.ok(report.scrollWidth <= report.viewportWidth + 1,
          `page scrolls horizontally: ${report.scrollWidth} > ${report.viewportWidth}`);

        const badge = await page.$eval(".role-badge", (el) => ({
          width: Math.ceil(el.getBoundingClientRect().width),
          overflows: el.scrollWidth > el.clientWidth + 1,
          text: el.textContent?.replace(/\s+/g, " ").trim(),
          transform: getComputedStyle(el.querySelector("strong")!).textTransform,
        }));
        assert.ok(!badge.overflows, `role badge is cut off: "${badge.text}"`);
        // textContent cannot see text-transform, so assert the rendered casing
        // directly: `capitalize` once title-cased this into "You Are A Breaker".
        assert.equal(badge.transform, "none", `role badge is being re-cased to ${badge.transform}`);
        assert.ok(badge.width <= report.viewportWidth,
          `role badge (${badge.width}px) is wider than the viewport (${report.viewportWidth}px)`);
        await page.context().close();
      });
    }

    it("puts the worker and the MCP switch above the four APIs", async () => {
      const page = await openBoard(VIEWPORTS[1]);
      const tops = await page.$$eval(".card", (els) =>
        els.map((el) => ({
          name: el.querySelector(".card-name")?.textContent?.trim(),
          top: el.getBoundingClientRect().top,
        })));
      assert.equal(tops.length, 6);
      const mcp = tops.find((t) => t.name === "AGENT MCP")!;
      const worker = tops.find((t) => t.name === "AGENT WORKER")!;
      const apis = tops.filter((t) => t !== mcp && t !== worker);
      assert.ok(apis.every((t) => t.top > mcp.top), "the MCP card must sit above every API card");
      assert.ok(apis.every((t) => t.top > worker.top), "the worker card must sit above every API card");
      // They share the top tier, stacked in portrait and side by side once
      // there is width, so the worker is never below the MCP card.
      assert.ok(worker.top <= mcp.top, "the worker card must not sit below the MCP card");
      await page.context().close();
    });
  });

  describe("the tug of war", () => {
    before(async () => { await arm(true); });

    it("gives the two teams clearly different colours", async () => {
      const breakerPage = await openBoard(VIEWPORTS[1], "breaker");
      const fixerPage = await openBoard(VIEWPORTS[1], "fixer");

      const read = (page: Page) =>
        page.$eval(".vote", (el) => ({
          label: el.textContent?.trim(),
          role: (el as HTMLElement).dataset.role,
          background: getComputedStyle(el).backgroundImage,
        }));

      const b = await read(breakerPage);
      const f = await read(fixerPage);
      assert.equal(b.label, "BREAK");
      assert.equal(f.label, "FIX");
      assert.equal(b.role, "breaker");
      assert.equal(f.role, "fixer");
      assert.notEqual(b.background, f.background, "the two teams must not look alike");

      // Red for breakers, blue for fixers -- deliberately not red/green.
      assert.match(b.background, /212, 61, 61|rgb\(212/);
      assert.match(f.background, /61, 127, 212|rgb\(61/);

      // The badge now tells you what your team is for, not just its name.
      assert.match((await breakerPage.textContent(".role-badge"))!.replace(/\s+/g, " ").trim(),
        /^You are a breaker: help take the systems offline!$/);
      assert.match((await fixerPage.textContent(".role-badge"))!.replace(/\s+/g, " ").trim(),
        /^You are a fixer: help keep things online!$/);
      await breakerPage.context().close();
      await fixerPage.context().close();
    });

    it("starts each bar where the switch it describes actually sits", async () => {
      /*
       * An unvoted switch is a 0-0 tie, which is 50% and reads UP. But the
       * stubs report SERVICE 1, 3 and 4 as down at boot, and a bar sitting at
       * the tipping point above a card reading DOWN is the inconsistency this
       * suite exists to catch -- it is what the projector would draw.
       */
      const page = await openBoard(VIEWPORTS[1], "breaker");
      const bars = await page.$$eval(".card", (cards) =>
        cards.map((c) => ({
          name: c.querySelector(".card-name")?.textContent?.trim(),
          br: c.querySelector(".legend--break")?.textContent?.trim(),
          fx: c.querySelector(".legend--fix")?.textContent?.trim(),
          state: c.querySelector(".legend-state")?.textContent?.trim(),
        })));
      assert.equal(bars.length, 6);

      const up = ["AGENT WORKER", "AGENT MCP", "SERVICE 2"];
      for (const bar of bars) {
        if (up.includes(bar.name!)) {
          // Untouched and healthy: "50% (0 fixes)" / "(0 breaks) 50%".
          assert.match(bar.fx!, /^50%\s+\(0 fixes\)$/, `${bar.name}: ${bar.fx}`);
          assert.match(bar.br!, /^\(0 breaks\)\s+50%$/, `${bar.name}: ${bar.br}`);
          assert.equal(bar.state, "UP", bar.name);
        } else {
          // Seeded down from /health, so the bar has to say so too.
          assert.equal(bar.state, "DOWN", bar.name);
          assert.match(bar.fx!, /^0%\s+\(0 fixes\)$/, `${bar.name}: ${bar.fx}`);
        }
      }
      await page.context().close();
    });

    it("moves the bar and the spark when a vote lands, and calls the service on the flip", async () => {
      // SERVICE 2, because it is the only API stub that reports healthy at
      // boot -- the beat under test is a tie being broken, which needs a
      // switch that starts tied.
      const page = await openBoard(VIEWPORTS[1], "breaker");
      stubs[2].hits.length = 0;

      const readTaco = () =>
        page.evaluate(() => {
          const card = [...document.querySelectorAll(".card")].find(
            (c) => c.querySelector(".card-name")?.textContent?.trim() === "SERVICE 2",
          )!;
          return {
            br: card.querySelector(".legend--break")?.textContent?.trim(),
            fx: card.querySelector(".legend--fix")?.textContent?.trim(),
            state: card.querySelector(".legend-state")?.textContent?.trim(),
            breakWidth: (card.querySelector(".battle-side--break") as HTMLElement).style.width,
            spark: (card.querySelector(".battle-spark") as HTMLElement).style.left,
          };
        });

      const vote = () =>
        page.evaluate(() => {
          const card = [...document.querySelectorAll(".card")].find(
            (c) => c.querySelector(".card-name")?.textContent?.trim() === "SERVICE 2",
          )!;
          (card.querySelector(".vote") as HTMLButtonElement).click();
        });

      const tied = await readTaco();
      assert.match(tied.fx!, /^50%\s+\(0 fixes\)$/);
      assert.match(tied.br!, /^\(0 breaks\)\s+50%$/);
      assert.equal(tied.state, "UP");
      assert.equal(tied.breakWidth, "50%");
      assert.equal(tied.spark, "50%");

      await vote();
      await page.waitForFunction(() => {
        const card = [...document.querySelectorAll(".card")].find(
          (c) => c.querySelector(".card-name")?.textContent?.trim() === "SERVICE 2",
        );
        return card?.querySelector(".legend-state")?.textContent?.trim() === "DOWN";
      }, null, { timeout: 8000 });

      const after = await readTaco();
      // Fixers hold the left, so one break with no fixes empties their end and
      // pushes the spark to the far left.
      assert.match(after.br!, /^\(1 breaks\)\s+100%$/, after.br);
      assert.match(after.fx!, /^0%\s+\(0 fixes\)$/, after.fx);
      assert.equal(after.breakWidth, "100%");
      assert.equal(after.spark, "0%", "the spark rides the boundary");
      assert.equal(stubs[2].hits.length, 1, "the flip calls the service exactly once");
      assert.deepEqual(stubs[2].hits, ["off"]);

      // A second break moves nothing further and must not call again.
      await page.waitForTimeout(300);
      await vote();
      await page.waitForTimeout(900);
      assert.equal(stubs[2].hits.length, 1, "piling on must stay silent");

      await page.context().close();
    });
  });

  describe("the audience gate, as the room sees it", () => {
    it("loads inert and explains itself while the floor is closed", async () => {
      await arm(false);
      const page = await openBoard(VIEWPORTS[1]);

      assert.equal(await page.getAttribute(".board", "data-armed"), "false");
      assert.equal((await page.textContent(".status"))?.trim(), "waiting for the demo to start");
      assert.ok(await page.$$eval(".vote", (els) => els.every((el) => (el as HTMLButtonElement).disabled)),
        "every vote button should be disabled, not just dimmed");
      const opacity = await page.$eval(".vote", (el) => getComputedStyle(el).opacity);
      assert.ok(parseFloat(opacity) < 0.6, `switches should read as inactive, opacity was ${opacity}`);

      const calls = stubs[2].calls;
      const before = await page.$$eval(".legend--break", (els) => els.map((e) => e.textContent));
      await page.$$eval(".vote", (els) => els.forEach((el) => (el as HTMLButtonElement).click()));
      await page.waitForTimeout(700);
      assert.deepEqual(
        await page.$$eval(".legend--break", (els) => els.map((e) => e.textContent)),
        before,
        "a locked board must not count votes",
      );
      assert.equal(stubs[2].calls, calls, "a locked board must not call out");
      await page.context().close();
    });

    it("comes alive the moment the operator opens the floor, with no reload", async () => {
      await arm(false);
      const page = await openBoard(VIEWPORTS[1]);
      await arm(true);

      await page.waitForFunction(() => document.querySelector(".board")?.getAttribute("data-armed") === "true",
        null, { timeout: 5000 });
      assert.equal((await page.textContent(".status"))?.trim(), "live");
      assert.ok(await page.$$eval(".vote", (els) => els.every((el) => !(el as HTMLButtonElement).disabled)));

      // A vote now registers: the bar moves off its 50/50 tie.
      await page.$eval(".vote", (el) => (el as HTMLButtonElement).click());
      await page.waitForFunction(
        () => document.querySelector(".legend--break")?.textContent?.trim() !== "50%",
        null, { timeout: 8000 });
      await page.context().close();
    });

    it("goes inert again when the floor closes mid-demo", async () => {
      await arm(true);
      const page = await openBoard(VIEWPORTS[1]);
      await arm(false);
      await page.waitForFunction(() => document.querySelector(".board")?.getAttribute("data-armed") === "false",
        null, { timeout: 5000 });
      assert.ok(await page.$$eval(".vote", (els) => els.every((el) => (el as HTMLButtonElement).disabled)));
      await page.context().close();
    });
  });

  describe("the operator page", () => {
    it("refuses to render without the right token", async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${app.base}/control`, { waitUntil: "networkidle" });
      assert.match((await page.textContent(".control"))!, /Append \?token=/);
      await page.goto(`${app.base}/control?token=wrong`, { waitUntil: "networkidle" });
      assert.match((await page.textContent(".control"))!, /Append \?token=/);
      await context.close();
    });

    it("drives every service and every phone from one button", async () => {
      await arm(true);
      const phone = await openBoard(VIEWPORTS[1]);

      const context = await browser.newContext({ viewport: { width: 430, height: 980 } });
      const operator = await context.newPage();
      await operator.goto(`${app.base}/control?token=${TOKEN}`, { waitUntil: "networkidle" });
      await operator.waitForTimeout(800);

      await operator.getByRole("button", { name: "ALL ON" }).click();
      await phone.waitForFunction(
        () => [...document.querySelectorAll(".legend-state")].every((el) => el.textContent?.trim() === "UP"),
        null, { timeout: 6000 });
      assert.ok(stubs.every((stub) => stub.on), "every service should be on");

      await operator.getByRole("button", { name: "ALL OFF" }).click();
      await phone.waitForFunction(
        () => [...document.querySelectorAll(".legend-state")].every((el) => el.textContent?.trim() === "DOWN"),
        null, { timeout: 6000 });
      assert.ok(stubs.every((stub) => !stub.on), "every service should be off");

      await context.close();
      await phone.context().close();
    });

    it("keeps the gate switch, its caption and the server in agreement", async () => {
      const context = await browser.newContext({ viewport: { width: 430, height: 980 } });
      const operator = await context.newPage();
      await operator.goto(`${app.base}/control?token=${TOKEN}`, { waitUntil: "networkidle" });
      await operator.waitForTimeout(800);
      const gate = operator.getByRole("switch", { name: "AUDIENCE CONTROLS" });

      for (const target of [true, false, true, false]) {
        if ((await gate.getAttribute("data-on")) !== String(target)) await gate.click();
        await operator.waitForTimeout(1000); // well past the knob transition

        assert.equal(await gate.getAttribute("data-on"), String(target));
        assert.equal(await gate.getAttribute("aria-checked"), String(target));
        const caption = (await operator.textContent(".ctl-note--tight"))!;
        assert.equal(caption.includes("floor is open"), target, `caption disagreed at ${target}: ${caption}`);

        const state = (await (await fetch(`${app.base}/api/admin/state`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })).json()) as { armed: boolean };
        assert.equal(state.armed, target, "the server must agree with the switch");
      }
      await context.close();
    });

    it("zeroes the counters on request", async () => {
      await arm(true);
      const phone = await openBoard(VIEWPORTS[1]);
      await phone.$eval(".vote", (el) => (el as HTMLButtonElement).click());
      await phone.waitForTimeout(600);

      const context = await browser.newContext({ viewport: { width: 430, height: 980 } });
      const operator = await context.newPage();
      await operator.goto(`${app.base}/control?token=${TOKEN}`, { waitUntil: "networkidle" });
      await operator.waitForFunction(() => /[1-9]/.test(document.body.textContent?.match(/(\d+) taps/)?.[1] ?? "0"),
        null, { timeout: 8000 });

      await operator.getByRole("button", { name: "RESET COUNTERS" }).click();
      await operator.waitForFunction(
        () => [...document.querySelectorAll(".ctl-meta")].every((el) => el.textContent?.startsWith("0 taps")),
        null, { timeout: 8000 });

      await context.close();
      await phone.context().close();
    });
  });
});

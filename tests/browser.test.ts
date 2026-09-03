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

  const openBoard = async (viewport: { width: number; height: number; dpr: number }): Promise<Page> => {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.dpr,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto(app.base, { waitUntil: "networkidle" });
    await page.waitForSelector('.board[data-ready="true"]');
    await page.waitForTimeout(400);
    return page;
  };

  describe("layout", () => {
    before(async () => { await arm(true); });

    for (const viewport of VIEWPORTS) {
      it(`fits all five switches on ${viewport.name} with no scrolling`, async () => {
        const page = await openBoard(viewport);
        const report = await page.evaluate(() => {
          const switches = [...document.querySelectorAll('[role="switch"]')];
          const boxes = switches.map((el) => el.getBoundingClientRect());
          return {
            count: switches.length,
            allVisible: boxes.every((b) => b.top >= 0 && b.bottom <= window.innerHeight),
            lastBottom: Math.max(...boxes.map((b) => b.bottom)),
            viewportHeight: window.innerHeight,
            scrollHeight: document.documentElement.scrollHeight,
            scrollWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
          };
        });

        assert.equal(report.count, 5, "all five switches should render");
        assert.ok(report.allVisible, `last switch ends at ${report.lastBottom} of ${report.viewportHeight}`);
        assert.ok(report.scrollHeight <= report.viewportHeight + 1,
          `page scrolls vertically: ${report.scrollHeight} > ${report.viewportHeight}`);
        assert.ok(report.scrollWidth <= report.viewportWidth + 1,
          `page scrolls horizontally: ${report.scrollWidth} > ${report.viewportWidth}`);
        await page.context().close();
      });
    }

    it("puts the MCP switch above the four APIs", async () => {
      const page = await openBoard(VIEWPORTS[1]);
      const tops = await page.$$eval('[role="switch"]', (els) =>
        els.map((el) => ({ name: el.getAttribute("aria-label"), top: el.getBoundingClientRect().top })));
      const mcp = tops.find((t) => t.name === "AGENT MCP")!;
      assert.ok(tops.filter((t) => t !== mcp).every((t) => t.top > mcp.top),
        "the MCP switch must sit above every API switch");
      await page.context().close();
    });
  });

  describe("the ON/OFF type treatment", () => {
    before(async () => { await arm(true); });

    it("renders the active side at 24pt black, outlined and glowing", async () => {
      const page = await openBoard(VIEWPORTS[1]);
      const labels = await page.$$eval('[role="switch"]', (els) =>
        els.map((el) => {
          const on = (el as HTMLElement).dataset.on === "true";
          const active = getComputedStyle(el.querySelector(on ? ".lbl--on" : ".lbl--off")!);
          const idle = getComputedStyle(el.querySelector(on ? ".lbl--off" : ".lbl--on")!);
          return {
            on,
            activeSize: active.fontSize,
            activeColor: active.color,
            activeStroke: active.webkitTextStrokeWidth,
            activeGlow: active.textShadow !== "none",
            idleSize: idle.fontSize,
            idleColor: idle.color,
            idleGlow: idle.textShadow !== "none",
            idleStroke: idle.webkitTextStrokeWidth,
          };
        }));

      assert.ok(labels.some((l) => l.on) && labels.some((l) => !l.on),
        "need at least one ON and one OFF switch to compare");

      for (const label of labels) {
        assert.equal(label.activeSize, "32px", "24pt active label");
        assert.equal(label.activeColor, "rgb(0, 0, 0)", "active label is black");
        assert.ok(parseFloat(label.activeStroke) > 0, "active label has a white outline");
        assert.ok(label.activeGlow, "active label glows");

        assert.equal(label.idleSize, "16px", "12pt idle label");
        assert.notEqual(label.idleColor, "rgb(0, 0, 0)", "idle label is grey, not black");
        assert.ok(!label.idleGlow, "idle label does not glow");
        assert.ok(parseFloat(label.idleStroke) > 0, "idle label keeps its thin white outline");
      }
      await page.context().close();
    });

    it("swaps the emphasis when a switch is toggled", async () => {
      const page = await openBoard(VIEWPORTS[1]);
      const target = page.getByRole("switch", { name: "SERVICE 1" });
      const before = await target.getAttribute("data-on");

      await target.tap();
      await page.waitForFunction(
        (was) => document.querySelector('[aria-label="SERVICE 1"]')?.getAttribute("data-on") !== was,
        before);
      await page.waitForTimeout(400); // let the transition settle

      const after = await target.evaluate((el) => ({
        on: (el as HTMLElement).dataset.on === "true",
        onSize: getComputedStyle(el.querySelector(".lbl--on")!).fontSize,
        offSize: getComputedStyle(el.querySelector(".lbl--off")!).fontSize,
      }));
      assert.equal(after.onSize, after.on ? "32px" : "16px");
      assert.equal(after.offSize, after.on ? "16px" : "32px");
      await page.context().close();
    });

    it("sends a real tap through to the backend service", async () => {
      const page = await openBoard(VIEWPORTS[1]);
      const before = stubs[1].calls;
      await page.getByRole("switch", { name: "SERVICE 1" }).tap();
      await page.waitForTimeout(800);
      assert.equal(stubs[1].calls, before + 1, "the tap should have produced exactly one POST");
      await page.context().close();
    });
  });

  describe("the audience gate, as the room sees it", () => {
    it("loads inert and explains itself while the floor is closed", async () => {
      await arm(false);
      const page = await openBoard(VIEWPORTS[1]);

      assert.equal(await page.getAttribute(".board", "data-armed"), "false");
      assert.equal(await page.textContent(".foot"), "waiting for the demo to start");
      assert.ok(await page.$$eval('[role="switch"]', (els) => els.every((el) => (el as HTMLButtonElement).disabled)),
        "every switch should be a disabled button, not just dimmed");
      const opacity = await page.$eval('[role="switch"]', (el) => getComputedStyle(el).opacity);
      assert.ok(parseFloat(opacity) < 0.6, `switches should read as inactive, opacity was ${opacity}`);

      const target = page.getByRole("switch", { name: "SERVICE 2" });
      const before = await target.getAttribute("data-on");
      const calls = stubs[2].calls;
      await target.click({ force: true });
      await page.waitForTimeout(600);
      assert.equal(await target.getAttribute("data-on"), before, "a locked switch must not move");
      assert.equal(stubs[2].calls, calls, "a locked switch must not call out");
      await page.context().close();
    });

    it("comes alive the moment the operator opens the floor, with no reload", async () => {
      await arm(false);
      const page = await openBoard(VIEWPORTS[1]);
      await arm(true);

      await page.waitForFunction(() => document.querySelector(".board")?.getAttribute("data-armed") === "true",
        null, { timeout: 5000 });
      assert.equal(await page.textContent(".foot"), "live");
      assert.ok(await page.$$eval('[role="switch"]', (els) => els.every((el) => !(el as HTMLButtonElement).disabled)));

      const target = page.getByRole("switch", { name: "SERVICE 3" });
      const before = await target.getAttribute("data-on");
      await target.tap();
      await page.waitForTimeout(600);
      assert.notEqual(await target.getAttribute("data-on"), before, "the switch should respond now");
      await page.context().close();
    });

    it("goes inert again when the floor closes mid-demo", async () => {
      await arm(true);
      const page = await openBoard(VIEWPORTS[1]);
      await arm(false);
      await page.waitForFunction(() => document.querySelector(".board")?.getAttribute("data-armed") === "false",
        null, { timeout: 5000 });
      assert.ok(await page.$$eval('[role="switch"]', (els) => els.every((el) => (el as HTMLButtonElement).disabled)));
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
        () => [...document.querySelectorAll('[role="switch"]')].every((el) => (el as HTMLElement).dataset.on === "true"),
        null, { timeout: 6000 });
      assert.ok(stubs.every((stub) => stub.on), "every service should be on");

      await operator.getByRole("button", { name: "ALL OFF" }).click();
      await phone.waitForFunction(
        () => [...document.querySelectorAll('[role="switch"]')].every((el) => (el as HTMLElement).dataset.on === "false"),
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
      await phone.getByRole("switch", { name: "SERVICE 4" }).tap();
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

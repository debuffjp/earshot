import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const server = spawn("node", ["serve.mjs"], { cwd: new URL("..", import.meta.url), stdio: "ignore", env: { ...process.env, EARSHOT_HOST: "" } });
await new Promise((r) => setTimeout(r, 800));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed;
try {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const open = async () => {
    const page = await (await browser.newContext()).newPage();
    page.errors = []; page.on("pageerror", (e) => page.errors.push(e.message));
    await page.goto("http://localhost:4710/voice.html");
    await page.click("#join");
    return page;
  };
  const a = await open();
  await sleep(500);
  const b = await open();
  for (const p of [a, b]) await p.waitForFunction(() => window.demo.stats.state === "connected" && window.demo.heard && window.demo.gotPosition, null, { timeout: 15000 });

  await sleep(2500);
  const read = (p) => p.evaluate(() => ({ state: window.demo.stats.state, packets: window.demo.stats.packets, rtt: window.demo.stats.rttMs, level: window.demo.level, voice: window.demo.voice.state, mix: window.demo.voice.mix }));
  const before = await read(a);
  console.log("a", before);
  assert.ok(before.packets > 50, "audio packets arrive");
  assert.ok(before.level > 0, "remote audio reaches Web Audio");
  assert.deepEqual(before.mix.walls, ["thin"], "the first seat hears the second through the thin wall");

  await b.evaluate(() => { window.demo.me.x = 12; window.demo.me.y = 10; });
  await sleep(500);
  const moved = await read(a);
  assert.deepEqual(moved.mix.walls, ["solid"], "position travels over the data channel");
  assert.ok(moved.mix.gain < before.mix.gain, "the solid wall is quieter");

  await a.click("#mute");
  await sleep(300);
  assert.equal(await a.evaluate(() => document.querySelector("#mute").textContent), "Muted");

  const third = await open();
  await third.waitForFunction(() => window.demo.stats.state.startsWith("room full"));

  await b.close();
  await a.waitForFunction(() => window.demo.stats.state === "the other device left", null, { timeout: 8000 });
  assert.deepEqual(a.errors, []);
  await browser.close();
  console.log("voice ok");
} catch (e) { failed = e; } finally { server.kill(); }
if (failed) { console.error(failed); process.exit(1); }

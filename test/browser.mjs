import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const out = new URL("./out/", import.meta.url);
mkdirSync(out, { recursive: true });

// 3.5 s quiet noise, then a tone about 30 dB louder for 2 s, then quiet, looped by Chromium.
function fakeMicWav() {
  const rate = 48000, seconds = 9, n = rate * seconds, data = Buffer.alloc(44 + n * 2);
  data.write("RIFF", 0); data.writeUInt32LE(36 + n * 2, 4); data.write("WAVEfmt ", 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate, loud = t > 4.5 && t < 6.5;
    const v = loud ? 0.25 * Math.sin(2 * Math.PI * 300 * t) : 0.004 * (Math.random() * 2 - 1);
    data.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return data;
}
const wav = new URL("mic.wav", out);
writeFileSync(wav, fakeMicWav());
const wavPath = decodeURIComponent(wav.pathname).replace(/^\/([A-Z]:)/, "$1");

const server = spawn("node", ["serve.mjs"], { cwd: new URL("..", import.meta.url), stdio: "ignore", env: { ...process.env, EARSHOT_HOST: "" } });
await new Promise((r) => setTimeout(r, 800));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed;
try {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4710/wall.html");
  await page.click("#go");
  await page.waitForFunction(() => window.demo.ready);
  const spots = { clear: [8.5, 7.5], thin: [12.5, 5.5], solid: [12.5, 9.5], multi: [17.5, 1.5], silent: [23.5, 13.5] };
  const res = {};
  for (const [name, [x, y]] of Object.entries(spots)) {
    await page.evaluate(([x, y]) => window.demo.set(x, y), [x, y]);
    await sleep(600);
    const peak = { low: -200, high: -200 };
    for (let i = 0; i < 25; i++) {
      const b = await page.evaluate(() => window.demo.bands());
      peak.low = Math.max(peak.low, b.low); peak.high = Math.max(peak.high, b.high);
      await sleep(100);
    }
    res[name] = { ...peak, ...(await page.evaluate(() => { const l = window.demo.last; return { label: l.label, gain: l.gain, room: l.room }; })) };
  }
  console.table(res);
  await page.screenshot({ path: new URL("wall.png", out).pathname.slice(1) });
  assert.equal(res.clear.label, "clear");
  assert.equal(res.thin.label, "thin wall");
  assert.equal(res.solid.label, "solid wall");
  assert.match(res.multi.label, /walls/);
  assert.ok(res.multi.gain > 0, "two walls are reachable within earshot from the start position");
  assert.ok(res.thin.high < res.clear.high - 6, "thin wall cuts treble");
  assert.ok(res.solid.high < res.thin.high - 3, "solid wall cuts more treble");

  const mic = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wavPath}`] });
  const wake = await mic.newPage({ viewport: { width: 760, height: 900 } });
  wake.on("pageerror", (e) => errors.push(e.message));
  await wake.goto("http://localhost:4710/wake.html");
  await wake.click("#start");
  await wake.click("#mic");
  await wake.waitForFunction(() => window.demo.floor !== null, null, { timeout: 8000 });
  const start = await wake.evaluate(() => ({ floor: window.demo.floor, applied: window.demo.log.applied }));
  let maxLevel = 0, woke = false;
  for (let i = 0; i < 120; i++) {
    const s = await wake.evaluate(() => ({ level: window.demo.level, m: window.demo.monster.state }));
    maxLevel = Math.max(maxLevel, s.level); woke ||= s.m === "hunting";
    await sleep(100);
  }
  const triggers = await wake.evaluate(() => window.demo.triggers);
  console.log("mic", { ...start, maxLevel, woke, triggers });
  await wake.screenshot({ path: new URL("wake.png", out).pathname.slice(1) });
  assert.ok(maxLevel >= 2, "loud fake mic reaches level 2+");
  assert.ok(woke, "monster wakes");
  await mic.close();

  // No mic device at all: the game must still start, and every event must work from keys.
  const none = await browser.newPage({ viewport: { width: 760, height: 900 } });
  none.on("pageerror", (e) => errors.push(e.message));
  await none.goto("http://localhost:4710/wake.html");
  await none.click("#start");
  await none.click("#mic");
  await none.waitForFunction(() => window.demo.log.mode === "keys");
  console.log("no mic:", await none.evaluate(() => window.demo.log.micError));
  await none.evaluate(() => window.demo.teleport(90, 120));
  await none.keyboard.down(" ");
  await sleep(1800);
  await none.keyboard.up(" ");
  assert.equal(await none.evaluate(() => window.demo.chests[0].open), true, "a hum key opens a chest");
  assert.equal(await none.evaluate(() => window.demo.monster.state), "asleep", "a hum doesn't wake it");
  await none.keyboard.down("x");
  await sleep(300);
  assert.equal(await none.evaluate(() => window.demo.monster.state), "hunting", "a shout key wakes it");

  // Phone width has no sideways scroll.
  const phone = await browser.newPage({ viewport: { width: 375, height: 812 } });
  for (const p of ["wall", "wake"]) {
    await phone.goto(`http://localhost:4710/${p}.html`);
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${p} fits a phone`);
  }
  assert.deepEqual(errors, []);
  await browser.close();
  console.log("browser ok");
} catch (e) { failed = e; } finally { server.kill(); }
if (failed) { console.error(failed); process.exit(1); }

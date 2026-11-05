import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url);
const server = spawn("node", ["serve.mjs"], { cwd: root, stdio: "ignore", env: { ...process.env, EARSHOT_HOST: "" } });
const worker = spawn("npx", ["wrangler", "dev", "--port", "8799", "--var", "MAX_PLAYERS:3"], { cwd: new URL("templates/worker/", root), shell: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" } });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("wrangler didn't start")), 60000);
  const look = (d) => { if (/Ready on/.test(String(d))) { clearTimeout(timer); resolve(); } };
  worker.stdout.on("data", look); worker.stderr.on("data", look);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed;
try {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const CODE = "test-room-code-0123456789";
  const join = async (x, options = "{}") => {
    const page = await (await browser.newContext()).newPage();
    page.on("pageerror", (e) => { throw e; });
    await page.goto("http://localhost:4710/");
    const result = await page.evaluate(async ({ x, CODE, options }) => {
      const { createListener, createVoiceMic, joinVoiceRoom } = await import("/dist/index.js");
      const ctx = new AudioContext(); await ctx.resume();
      const me = { x, y: 0 };
      const ear = createListener(ctx, { pos: () => me });
      const mic = createVoiceMic({ canUseVoice: () => true });
      await mic.start();
      const where = new Map();
      window.got = [];
      const r = await joinVoiceRoom({ url: "ws://localhost:8799", code: CODE, mic, listener: ear, ipPolicy: "direct", pos: (p) => where.get(p) ?? { x: 0, y: 0 }, onMessage: (p, m) => { window.got.push(m); where.set(p, m); }, ...JSON.parse(options) });
      window.t = { me, ear, room: r.room, where };
      setInterval(() => ear.update(), 50);
      return { ok: r.ok, error: r.error };
    }, { x, CODE, options });
    return { page, result };
  };
  const a = await join(0), b = await join(3), c = await join(6);
  assert.deepEqual([a.result.ok, b.result.ok, c.result.ok], [true, true, true]);
  for (const p of [a, b, c]) {
    await p.page.waitForFunction(() => window.t.room.peers.size === 2 && [...window.t.room.peers.keys()].every((k) => window.t.room.connection(k) === "connected"), null, { timeout: 20000 });
  }
  console.log("three players connected as a mesh");

  const full = await join(9);
  assert.deepEqual(full.result, { ok: false, error: "room-full" }, "a full room refuses");

  const levels = await a.page.evaluate(async () => {
    const peaks = [...window.t.room.peers.values()].map(() => -200);
    for (let i = 0; i < 120; i++) {
      [...window.t.room.peers.values()].forEach((v, n) => { peaks[n] = Math.max(peaks[n], v.levelDb); });
      await new Promise((r) => setTimeout(r, 25));
    }
    return peaks;
  });
  console.log("peak levels at a", levels);
  assert.ok(levels.every((l) => l > -50), "voice arrives from both players");

  await b.page.evaluate(() => { window.t.room.send({ x: 3, y: 0 }); });
  await a.page.waitForFunction(() => window.got.length > 0, null, { timeout: 5000 });

  const relay = await join(12, JSON.stringify({ ipPolicy: "relay", code: "another-room-code-0123456789" }));
  assert.deepEqual(relay.result, { ok: false, error: "no-turn-server" }, "relay fails closed without TURN");

  const badOrigin = await a.page.evaluate(() => new Promise((res) => { const s = new WebSocket("ws://localhost:8799/room?code=short&peer=abcdefgh"); s.onclose = (e) => res(e.code); s.onopen = () => res("open"); }));
  assert.notEqual(badOrigin, "open", "a short code is refused");

  const refused = await a.page.evaluate(async () => {
    const { createVoiceMic, joinVoiceRoom } = await import("/dist/index.js");
    const m = createVoiceMic({ canUseVoice: () => false });
    return [await m.start(), await joinVoiceRoom({ mic: m })];
  });
  assert.deepEqual(refused, [{ ok: false, error: "not-allowed" }, { ok: false, error: "mic-not-started" }], "the game can refuse voice");
  const stopped = await a.page.evaluate(async () => {
    const { createLoudness } = await import("/dist/index.js");
    const loud = createLoudness(new AudioContext());
    const result = loud.enableMic();
    await new Promise((r) => setTimeout(r, 300));
    loud.disableMic();
    return result;
  });
  assert.deepEqual(stopped, { ok: false, error: "stopped" }, "turning the mic off during calibration reports it");
  const controls = await c.page.evaluate(async () => {
    const { createVoiceMic } = await import("/dist/index.js");
    const m = createVoiceMic({ canUseVoice: () => true }); await m.start();
    const out = [m.live]; m.muted = true; out.push(m.live, m.stream.getAudioTracks()[0].enabled);
    m.muted = false; m.pushToTalk = true; out.push(m.live); m.talk(true); out.push(m.live); m.stop();
    return out;
  });
  assert.deepEqual(controls, [true, false, false, false, true], "mute and push to talk");

  await b.page.close();
  await a.page.waitForFunction(() => window.t.room.peers.size === 1, null, { timeout: 8000 });
  await a.page.evaluate(() => window.t.room.leave());
  assert.equal(await a.page.evaluate(() => window.t.room.peers.size), 0);
  const demo = [];
  for (let i = 0; i < 2; i++) {
    const page = await (await browser.newContext()).newPage();
    page.on("pageerror", (e) => { throw e; });
    await page.goto(`http://localhost:4710/voice.html?server=${encodeURIComponent("ws://localhost:8799")}&code=demo-room-code-012345678`);
    await page.click("#join");
    demo.push(page);
  }
  for (const page of demo) await page.waitForFunction(() => window.demo.heard && window.demo.gotPosition, null, { timeout: 20000 });
  await demo[1].evaluate(() => { window.demo.me.x = 12; window.demo.me.y = 10; });
  await sleep(500);
  const seen = await demo[0].evaluate(() => [...window.demo.room.peers.values()][0].mix.walls);
  assert.deepEqual(seen, ["solid"], "the demo moves a player behind the wall");
  await browser.close();
  console.log("room ok");
} catch (e) { failed = e; } finally { server.kill(); worker.kill(); spawn("taskkill", ["/F", "/T", "/PID", String(worker.pid)], { stdio: "ignore" }); }
if (failed) { console.error(failed); process.exit(1); }
process.exit(0);

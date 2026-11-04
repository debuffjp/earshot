import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const server = spawn("node", ["serve.mjs"], { cwd: new URL("..", import.meta.url), stdio: "ignore", env: { ...process.env, EARSHOT_HOST: "" } });
await new Promise((r) => setTimeout(r, 800));
let failed;
try {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  await page.goto("http://localhost:4710/");
  const result = await page.evaluate(async () => {
    const { createListener } = await import("/dist/index.js");
    const rms = (d, from) => { let s = 0; for (let i = from; i < d.length; i++) s += d[i] * d[i]; return 10 * Math.log10(s / (d.length - from) + 1e-20); };
    const render = async (distance, walls, reverb) => {
      const rate = 48000, ctx = new OfflineAudioContext(2, rate * 4, rate);
      const buffer = ctx.createBuffer(1, rate * 4, rate);
      const noise = buffer.getChannelData(0);
      for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 2 - 1) * 0.3;
      const src = new AudioBufferSourceNode(ctx, { buffer });
      const sink = new GainNode(ctx);
      const high = new BiquadFilterNode(ctx, { type: "highpass", frequency: 4000 });
      const merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
      // Channel 0 carries everything and channel 1 only the treble.
      sink.connect(merge, 0, 0);
      sink.connect(high).connect(merge, 0, 1);
      merge.connect(ctx.destination);
      const ear = createListener(ctx, { output: sink, pos: () => ({ x: 0, y: 0 }), world: { wallsBetween: () => walls, reverbAt: () => reverb } });
      ear.source(src, { pos: () => ({ x: distance, y: 0 }) });
      ear.update();
      src.start();
      src.stop(3);
      const out = await ctx.startRendering();
      const from = rate * 3;
      const data = out.getChannelData(0);
      // The source stops at 3 s, so anything from 3.2 s to 3.4 s is reverb tail.
      const tail = rms(data.subarray(0, Math.floor(rate * 3.4)), Math.floor(rate * 3.2));
      return { all: rms(data.subarray(0, from), rate * 2), treble: rms(out.getChannelData(1).subarray(0, from), rate * 2), tail };
    };
    const live = new AudioContext();
    await live.resume();
    const t0 = live.currentTime, p0 = performance.now();
    await new Promise((r) => setTimeout(r, 1000));
    return {
      clockRate: (live.currentTime - t0) / ((performance.now() - p0) / 1000),
      clear: await render(1, [], null),
      thin: await render(1, ["thin"], null),
      solid: await render(1, ["solid"], null),
      multi: await render(1, ["thin", "solid"], null),
      far: await render(30, [], null),
      room: await render(1, [], "room"),
      cave: await render(1, [], "cave"),
      attack: await (async () => {
        const rate = 48000, ctx = new OfflineAudioContext(1, rate, rate);
        const buffer = ctx.createBuffer(1, rate, rate);
        buffer.getChannelData(0).fill(0.5);
        const src = new AudioBufferSourceNode(ctx, { buffer });
        const ear = createListener(ctx, { pos: () => ({ x: 0, y: 0 }) });
        ear.source(src, { pos: () => ({ x: 1, y: 0 }) });
        ear.update();
        src.start();
        const out = await ctx.startRendering();
        return out.getChannelData(0)[480];
      })(),
    };
  });
  console.log("live clock rate", result.clockRate.toFixed(3));
  delete result.clockRate;
  console.log("level 10 ms after start", result.attack);
  assert.ok(result.attack > 0.3, "a new sound starts at full level");
  delete result.attack;
  console.table(result);
  const { clear, thin, solid, multi, far, room, cave } = result;
  assert.ok(Math.abs(clear.all - thin.all) > 6, "a thin wall is quieter");
  assert.ok(thin.treble < clear.treble - 12, "a thin wall cuts treble");
  assert.ok(solid.treble < thin.treble - 6, "a solid wall cuts more treble");
  assert.ok(multi.treble < solid.treble - 6, "two walls cut more treble");
  assert.ok(far.all < -120, "out of range is silent");
  assert.ok(clear.tail < -120, "no reverb, no tail");
  assert.ok(room.tail > -120, "a room has a tail");
  assert.ok(cave.tail > room.tail + 6, "a cave's tail is louder and longer");
  await browser.close();
  console.log("offline ok");
} catch (e) { failed = e; } finally { server.kill(); }
if (failed) { console.error(failed); process.exit(1); }

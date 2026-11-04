// Spike code for the Wall Test and Wake It demos. Pure logic first, Web Audio after.

export const DEFAULTS = {
  fullRadius: 2,
  silentRadius: 12,
  panWidth: 0.6,
  panRange: 8,
  smoothing: 0.08,
  thinHz: 2000, thinDb: -6,
  solidHz: 1200, solidDb: -12,
  multiHz: 700, multiDb: -18,
  roomWetDb: -18,
  caveWetDb: -12,
};

const dbToGain = (db) => 10 ** (db / 20);

/** 1 inside fullRadius, exactly 0 from silentRadius on. */
export function distanceGain(d, full, silent) {
  if (d <= full) return 1;
  if (d >= silent) return 0;
  const t = (d - full) / (silent - full);
  return 1 - t * t * (3 - 2 * t);
}

/** Walls crossed between two tile-space points, one entry per wall. Tile values: 1 thin, 2 solid. */
export function wallsBetween(tiles, a, b) {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 8) || 1;
  const found = [];
  let inside = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const v = tiles[Math.floor(a.y + (b.y - a.y) * t)]?.[Math.floor(a.x + (b.x - a.x) * t)] ?? 0;
    const wall = v === 1 || v === 2 ? v : 0;
    if (wall && wall !== inside) found.push(wall);
    inside = wall;
  }
  return found;
}

export function occlusion(walls, p) {
  if (walls.length === 0) return { hz: 20000, gain: 1, label: "clear" };
  if (walls.length >= 2) return { hz: p.multiHz, gain: dbToGain(p.multiDb), label: `${walls.length} walls` };
  return walls[0] === 1
    ? { hz: p.thinHz, gain: dbToGain(p.thinDb), label: "thin wall" }
    : { hz: p.solidHz, gain: dbToGain(p.solidDb), label: "solid wall" };
}

export function mix(listener, source, tiles, p) {
  const d = Math.hypot(source.x - listener.x, source.y - listener.y);
  const occ = occlusion(wallsBetween(tiles, source, listener), p);
  const dg = distanceGain(d, p.fullRadius, p.silentRadius);
  const pan = Math.max(-1, Math.min(1, (source.x - listener.x) / p.panRange)) * p.panWidth;
  return { distance: d, distanceGain: dg, gain: dg * occ.gain, cutoff: occ.hz, pan, label: occ.label };
}

/** Exponentially decaying noise, so no impulse file ships with the demo. */
export function makeImpulse(ctx, seconds) {
  const length = Math.ceil(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * 10 ** ((-3 * i) / length);
    }
  }
  return buffer;
}

/** One source: filter > gain > pan > master, with a send to each room's shared reverb. */
export function createVoice(ctx, input, buses, output) {
  const filter = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 20000 });
  const gain = new GainNode(ctx, { gain: 0 });
  const pan = new StereoPannerNode(ctx);
  input.connect(filter).connect(gain).connect(pan).connect(output);
  const sends = {};
  for (const [name, bus] of Object.entries(buses)) {
    sends[name] = new GainNode(ctx, { gain: 0 });
    gain.connect(sends[name]).connect(bus);
  }
  return {
    apply(m, room, wet, tau) {
      const t = ctx.currentTime;
      filter.frequency.setTargetAtTime(m.cutoff, t, tau);
      gain.gain.setTargetAtTime(m.gain, t, tau);
      pan.pan.setTargetAtTime(m.pan, t, tau);
      for (const [name, send] of Object.entries(sends)) {
        send.gain.setTargetAtTime(name === room ? wet : 0, t, tau);
      }
    },
  };
}

export function createBuses(ctx, output) {
  const buses = {};
  for (const [name, seconds] of [["room", 0.4], ["cave", 1.8]]) {
    buses[name] = new ConvolverNode(ctx, { buffer: makeImpulse(ctx, seconds) });
    buses[name].connect(output);
  }
  return buses;
}

export const wetGain = (room, p) =>
  room === "room" ? dbToGain(p.roomWetDb) : room === "cave" ? dbToGain(p.caveWetDb) : 0;

/**
 * Turns dB readings into levels 0 to 3 relative to the player's noise floor.
 * A level rises after attackMs above its threshold and falls after releaseMs
 * below threshold minus hysteresis, so one clap or a breath doesn't flicker it.
 */
export function createLoudness({ steps = [10, 20, 30], attackMs = 150, releaseMs = 400, hysteresis = 5 } = {}) {
  let floor = null;
  let level = 0;
  let aboveFor = 0;
  let belowFor = 0;
  return {
    get floor() { return floor; },
    get level() { return level; },
    calibrate(readings) {
      const sorted = [...readings].sort((a, b) => a - b);
      floor = sorted[Math.floor(sorted.length * 0.2)];
      level = 0;
    },
    update(db, dtMs) {
      if (floor === null) return 0;
      const over = db - floor;
      let target = 0;
      for (const s of steps) if (over >= s) target++;
      if (target > level) {
        aboveFor += dtMs;
        belowFor = 0;
        if (aboveFor >= attackMs) { level = target; aboveFor = 0; }
      } else {
        aboveFor = 0;
        const holds = level > 0 && over >= steps[level - 1] - hysteresis;
        if (level > 0 && !holds) {
          belowFor += dtMs;
          if (belowFor >= releaseMs) { level = target; belowFor = 0; }
        } else belowFor = 0;
      }
      return level;
    },
  };
}

export function rmsDb(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return 10 * Math.log10(sum / samples.length + 1e-12);
}

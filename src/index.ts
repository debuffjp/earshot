export interface Point { x: number; y: number }

/** A wall type. `hz` is the low-pass cutoff, `db` the level change. */
export interface Material { hz: number; db: number }

export interface Params {
  /** Full volume inside this many tiles. */
  fullRadius: number;
  /** Exactly silent from this many tiles. */
  silentRadius: number;
  /** Largest pan, 0 to 1. Pan uses screen x only. */
  panWidth: number;
  /** Tiles of horizontal offset that reach `panWidth`. */
  panRange: number;
  /** Time constant in seconds for parameter changes. */
  smoothing: number;
  /** Used whenever two or more walls are in the way. */
  multiWall: Material;
}

export const DEFAULT_PARAMS: Readonly<Params> = {
  fullRadius: 2,
  silentRadius: 12,
  panWidth: 0.6,
  panRange: 8,
  smoothing: 0.08,
  multiWall: { hz: 700, db: -18 },
};

export const DEFAULT_MATERIALS: Readonly<Record<string, Material>> = {
  thin: { hz: 2000, db: -6 },
  solid: { hz: 1200, db: -12 },
};

/** A reverb preset. `wetDb` sets how loud the reverb is against the dry sound. */
export interface Reverb { seconds: number; wetDb: number }

export const DEFAULT_REVERBS: Readonly<Record<string, Reverb>> = {
  room: { seconds: 0.4, wetDb: -18 },
  cave: { seconds: 1.8, wetDb: -12 },
};

const dbToGain = (db: number) => 10 ** (db / 20);

/** 1 inside `full`, exactly 0 from `silent` on, smoothstep between. */
export function distanceGain(d: number, full: number, silent: number): number {
  if (d <= full) return 1;
  if (d >= silent) return 0;
  const t = (d - full) / (silent - full);
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Walls crossed between two points in tile units. `tiles[y][x]` holds a material
 * name or nothing; adjacent tiles of one material count as one wall.
 */
export function wallsOnGrid(tiles: ReadonlyArray<ReadonlyArray<string | null | undefined>>, a: Point, b: Point): string[] {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 8) || 1;
  const found: string[] = [];
  let inside: string | null = null;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const wall = tiles[Math.floor(a.y + (b.y - a.y) * t)]?.[Math.floor(a.x + (b.x - a.x) * t)] ?? null;
    if (wall && wall !== inside) found.push(wall);
    inside = wall;
  }
  return found;
}

export interface Mix {
  distance: number;
  /** Final linear gain, distance and walls combined. */
  gain: number;
  /** Low-pass cutoff in Hz. */
  cutoff: number;
  pan: number;
  walls: readonly string[];
}

const OPEN_CUTOFF = 20000;

/** The whole audio decision as plain numbers, so a game can show it or test it without Web Audio. */
export function computeMix(listener: Point, source: Point, walls: readonly string[], params: Params, materials: Readonly<Record<string, Material>>): Mix {
  const distance = Math.hypot(source.x - listener.x, source.y - listener.y);
  let material: Material | undefined;
  if (walls.length >= 2) material = params.multiWall;
  else if (walls.length === 1) {
    material = materials[walls[0]!];
    if (!material) throw new Error(`earshot: unknown material "${walls[0]}"`);
  }
  const pan = Math.max(-1, Math.min(1, (source.x - listener.x) / params.panRange)) * params.panWidth;
  return {
    distance,
    gain: distanceGain(distance, params.fullRadius, params.silentRadius) * (material ? dbToGain(material.db) : 1),
    cutoff: material?.hz ?? OPEN_CUTOFF,
    pan,
    walls,
  };
}

/**
 * How loud a player's noise is at a point, in dB, for game rules such as a monster
 * that hears through walls. `levelDb` gives the loudness of levels 0 to 3.
 */
export function heardDb(level: number, mix: Pick<Mix, "gain">, levelDb: readonly number[] = [-Infinity, 10, 20, 30]): number {
  return (levelDb[level] ?? -Infinity) + 20 * Math.log10(mix.gain);
}

export interface World {
  /** Names of the materials between two points. Use `wallsOnGrid` for tile maps. */
  wallsBetween?(a: Point, b: Point): readonly string[];
  /** Name of the reverb a point sits in, or nothing for a dry sound. */
  reverbAt?(p: Point): string | null | undefined;
}

export interface ListenerOptions {
  /** Where sound ends up. Defaults to the context's destination. */
  output?: AudioNode;
  /** World units per tile. Positions are divided by this. Defaults to 1. */
  tile?: number;
  world?: World;
  params?: Partial<Params>;
  materials?: Record<string, Material>;
  reverbs?: Record<string, Reverb>;
  /** Position of the listener, read on every update. */
  pos(): Point;
}

export interface SourceOptions {
  /** Position of the source, read on every update. */
  pos(): Point;
}

export type SourceState = "audible" | "out-of-range" | "muted";

export interface Source {
  readonly state: SourceState;
  /** The mix from the latest update. */
  readonly mix: Mix | null;
  /** The reverb the source was in at the latest update. */
  readonly reverb: string | null;
  muted: boolean;
  /** Disconnects this source. The input node stays usable. */
  remove(): void;
}

export interface Listener {
  /** Live values: changes apply on the next update. */
  readonly params: Params;
  readonly materials: Record<string, Material>;
  readonly reverbs: Record<string, Reverb>;
  /** Sends any audio node through distance, walls, pan and reverb. */
  source(input: AudioNode, options: SourceOptions): Source;
  /** Call from your game loop. 10 to 20 times a second is enough. */
  update(): void;
  /** Removes every source and the reverbs. */
  dispose(): void;
}

function makeImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.ceil(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * 10 ** ((-3 * i) / length);
  }
  return buffer;
}

export function createListener(ctx: BaseAudioContext, options: ListenerOptions): Listener {
  const output = options.output ?? ctx.destination;
  const tile = options.tile ?? 1;
  // Cloned because `params`, `materials` and `reverbs` are live and editable.
  const params: Params = structuredClone({ ...DEFAULT_PARAMS, ...options.params });
  const materials = structuredClone({ ...DEFAULT_MATERIALS, ...options.materials });
  const reverbs = structuredClone({ ...DEFAULT_REVERBS, ...options.reverbs });
  // Convolvers are costly, so every source in a room shares one.
  const buses = new Map<string, ConvolverNode>();
  const bus = (name: string) => {
    let node = buses.get(name);
    if (!node) {
      const reverb = reverbs[name];
      if (!reverb) throw new Error(`earshot: unknown reverb "${name}"`);
      node = new ConvolverNode(ctx, { buffer: makeImpulse(ctx, reverb.seconds) });
      node.connect(output);
      buses.set(name, node);
    }
    return node;
  };
  const toTiles = (p: Point): Point => ({ x: p.x / tile, y: p.y / tile });
  const updates = new Set<(listener: Point) => void>();
  const removers = new Set<() => void>();

  return {
    params,
    materials,
    reverbs,
    source(input, { pos }) {
      const filter = new BiquadFilterNode(ctx, { type: "lowpass", frequency: OPEN_CUTOFF });
      const gain = new GainNode(ctx, { gain: 0 });
      const pan = new StereoPannerNode(ctx);
      input.connect(filter);
      filter.connect(gain).connect(pan).connect(output);
      const sends = new Map<string, GainNode>();
      let mix: Mix | null = null;
      let reverb: string | null = null;
      let muted = false;

      const update = (listener: Point) => {
        const at = toTiles(pos());
        mix = computeMix(listener, at, options.world?.wallsBetween?.(at, listener) ?? [], params, materials);
        reverb = options.world?.reverbAt?.(at) ?? null;
        const t = ctx.currentTime;
        const tau = params.smoothing;
        const level = muted ? 0 : mix.gain;
        filter.frequency.setTargetAtTime(mix.cutoff, t, tau);
        gain.gain.setTargetAtTime(level, t, tau);
        pan.pan.setTargetAtTime(mix.pan, t, tau);
        if (reverb && !sends.has(reverb)) {
          const send = new GainNode(ctx, { gain: 0 });
          gain.connect(send).connect(bus(reverb));
          sends.set(reverb, send);
        }
        for (const [name, send] of sends) {
          send.gain.setTargetAtTime(name === reverb ? dbToGain(reverbs[name]!.wetDb) : 0, t, tau);
        }
      };
      const remove = () => {
        updates.delete(update);
        removers.delete(remove);
        input.disconnect(filter);
        filter.disconnect();
        gain.disconnect();
        pan.disconnect();
        for (const send of sends.values()) send.disconnect();
      };
      updates.add(update);
      removers.add(remove);
      return {
        get state(): SourceState { return muted ? "muted" : mix && mix.gain === 0 ? "out-of-range" : "audible"; },
        get mix() { return mix; },
        get reverb() { return reverb; },
        get muted() { return muted; },
        set muted(value) { muted = value; },
        remove,
      };
    },
    update() {
      const listener = toTiles(options.pos());
      for (const update of updates) update(listener);
    },
    dispose() {
      for (const remove of [...removers]) remove();
      for (const node of buses.values()) node.disconnect();
      buses.clear();
    },
  };
}

export type LoudLevel = 0 | 1 | 2 | 3;

export interface DetectorOptions {
  /** dB above the noise floor for levels 1, 2 and 3. */
  steps?: readonly [number, number, number];
  attackMs?: number;
  releaseMs?: number;
  /** A level holds until the sound drops this many dB under its step. */
  hysteresisDb?: number;
}

export interface LevelDetector {
  readonly floor: number | null;
  readonly level: LoudLevel;
  /** Sets the noise floor from dB readings taken while the player was quiet. */
  calibrate(readings: readonly number[]): void;
  update(db: number, dtMs: number): LoudLevel;
}

/** Turns dB readings into levels relative to a noise floor, so a blip or a breath doesn't flicker. */
export function createLevelDetector(options: DetectorOptions = {}): LevelDetector {
  const { steps = [10, 20, 30], attackMs = 150, releaseMs = 400, hysteresisDb = 5 } = options;
  let floor: number | null = null;
  let level: LoudLevel = 0;
  let aboveFor = 0;
  let belowFor = 0;
  return {
    get floor() { return floor; },
    get level() { return level; },
    calibrate(readings) {
      const sorted = [...readings].sort((a, b) => a - b);
      floor = sorted[Math.floor(sorted.length * 0.2)] ?? null;
      level = 0;
      aboveFor = belowFor = 0;
    },
    update(db, dtMs) {
      if (floor === null) return 0;
      const over = db - floor;
      let target = 0;
      for (const step of steps) if (over >= step) target++;
      if (target > level) {
        aboveFor += dtMs;
        belowFor = 0;
        if (aboveFor >= attackMs) { level = target as LoudLevel; aboveFor = 0; }
        return level;
      }
      aboveFor = 0;
      if (level > 0 && over < steps[level - 1]! - hysteresisDb) {
        belowFor += dtMs;
        if (belowFor >= releaseMs) { level = target as LoudLevel; belowFor = 0; }
      } else belowFor = 0;
      return level;
    },
  };
}

export type MicStatus = "off" | "calibrating" | "on";

export interface MicResult { ok: boolean; error?: string }

export interface LoudnessOptions extends DetectorOptions {
  /** Quiet time used to measure the noise floor. Defaults to 3000. */
  calibrateMs?: number;
  /** Ask the browser for echo cancellation, noise suppression and auto gain. Off by default, as they flatten loudness. */
  browserProcessing?: boolean;
}

export interface Loudness {
  /** The louder of the mic and `press`. */
  readonly level: LoudLevel;
  readonly micStatus: MicStatus;
  /** dB above the noise floor, or null with no calibrated mic. */
  readonly overFloorDb: number | null;
  /** What the browser really applied. Browsers may ignore what was asked for. */
  readonly applied: MediaTrackSettings | null;
  /** Hold a level from a key or button. Everything the mic does works without one. */
  press(level: LoudLevel): void;
  /** Asks for the mic and calibrates. Never rejects: a denied mic leaves `press` working. */
  enableMic(): Promise<MicResult>;
  /** Measures the noise floor again. Ask the player to stay quiet first. */
  recalibrate(): Promise<void>;
  disableMic(): void;
  /** Called when `level` changes. Returns a function that removes the callback. */
  onLevel(callback: (level: LoudLevel) => void): () => void;
}

/**
 * Loudness as game input. Audio goes to an analyser and no further: nothing is
 * recorded, sent or played back.
 */
export function createLoudness(ctx: AudioContext, options: LoudnessOptions = {}): Loudness {
  const detector = createLevelDetector(options);
  const callbacks = new Set<(level: LoudLevel) => void>();
  const calibrateMs = options.calibrateMs ?? 3000;
  let stream: MediaStream | null = null;
  let analyser: AnalyserNode | null = null;
  let input: MediaStreamAudioSourceNode | null = null;
  let samples = new Float32Array(0);
  let timer: ReturnType<typeof setInterval> | undefined;
  let status: MicStatus = "off";
  let pressed: LoudLevel = 0;
  let micLevel: LoudLevel = 0;
  let shown: LoudLevel = 0;
  let db = -120;
  let lastTick = 0;
  let readings: number[] | null = null;

  const emit = () => {
    const next = Math.max(micLevel, pressed) as LoudLevel;
    if (next !== shown) {
      shown = next;
      for (const callback of callbacks) callback(next);
    }
  };
  const read = () => {
    analyser!.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    return 10 * Math.log10(sum / samples.length + 1e-12);
  };
  const calibrate = () => new Promise<void>((done) => {
    if (!analyser) return done();
    status = "calibrating";
    micLevel = 0;
    emit();
    readings = [];
    setTimeout(() => {
      if (analyser && readings) {
        detector.calibrate(readings);
        status = "on";
      }
      readings = null;
      done();
    }, calibrateMs);
  });
  const disableMic = () => {
    clearInterval(timer);
    stream?.getTracks().forEach((track) => track.stop());
    input?.disconnect();
    stream = analyser = input = null;
    readings = null;
    status = "off";
    micLevel = 0;
    db = -120;
    emit();
  };

  return {
    get level() { return shown; },
    get micStatus() { return status; },
    get overFloorDb() { return status === "on" && detector.floor !== null ? db - detector.floor : null; },
    get applied() { return stream?.getAudioTracks()[0]?.getSettings() ?? null; },
    press(level) { pressed = level; emit(); },
    async enableMic() {
      if (stream) return { ok: true };
      const on = options.browserProcessing ?? false;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: on, noiseSuppression: on, autoGainControl: on } });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.name : "unavailable" };
      }
      input = ctx.createMediaStreamSource(stream);
      analyser = new AnalyserNode(ctx, { fftSize: 2048 });
      input.connect(analyser);
      samples = new Float32Array(analyser.fftSize);
      lastTick = performance.now();
      // A timer rather than a frame callback, because hidden tabs stop frames.
      timer = setInterval(() => {
        if (!analyser) return;
        const now = performance.now();
        db = read();
        if (readings) readings.push(db);
        else { micLevel = detector.update(db, now - lastTick); emit(); }
        lastTick = now;
      }, 30);
      await calibrate();
      return { ok: true };
    },
    recalibrate: calibrate,
    disableMic,
    onLevel(callback) {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
  };
}

import assert from "node:assert/strict";
import { distanceGain, heardDb, wallsOnGrid, computeMix, createLevelDetector, DEFAULT_PARAMS as p, DEFAULT_MATERIALS as m } from "../dist/index.js";

assert.equal(distanceGain(2, 2, 12), 1);
assert.equal(distanceGain(12, 2, 12), 0);
assert.equal(distanceGain(7, 2, 12), 0.5);

const T = "thin", S = "solid";
const tiles = [[null, T, null, S, null, S, null]];
const at = (x) => ({ x: x + 0.5, y: 0.5 });
assert.deepEqual(wallsOnGrid(tiles, at(0), at(0)), []);
assert.deepEqual(wallsOnGrid(tiles, at(0), at(2)), [T]);
assert.deepEqual(wallsOnGrid(tiles, at(0), at(6)), [T, S, S]);
assert.deepEqual(wallsOnGrid([[S, S, S, null]], at(0), at(3)), [S], "a thick wall counts once");
assert.deepEqual(wallsOnGrid([[T, S, null]], at(0), at(2)), [T, S], "touching materials are two walls");

const a = { x: 0, y: 0 }, b = { x: 1, y: 0 };
assert.equal(computeMix(a, b, [], p, m).cutoff, 20000);
assert.equal(computeMix(a, b, [T], p, m).cutoff, 2000);
assert.equal(computeMix(a, b, [S], p, m).cutoff, 1200);
assert.equal(computeMix(a, b, [T, S], p, m).cutoff, 700);
assert.throws(() => computeMix(a, b, ["jelly"], p, m), /unknown material/);
assert.equal(computeMix(a, { x: 8, y: 0 }, [], p, m).pan, 0.6);
assert.equal(computeMix(a, { x: 0, y: 8 }, [], p, m).pan, 0, "vertical offset never pans");

assert.equal(heardDb(3, { gain: 1 }), 30);
assert.equal(heardDb(2, { gain: 0.1 }), 0);
assert.equal(heardDb(0, { gain: 1 }), -Infinity, "silence is never heard");
assert.equal(heardDb(3, { gain: 0 }), -Infinity, "out of range is never heard");

const run = (d, db, ms) => { for (let t = 0; t < ms; t += 16) d.update(db, 16); return d.level; };
const d = createLevelDetector();
assert.equal(d.update(0, 16), 0, "no level before calibration");
d.calibrate([-60, -60, -60, -60, -30]);
assert.equal(d.floor, -60);
assert.equal(run(d, -60, 500), 0);
assert.equal(run(d, -45, 100), 0, "a short blip stays under attack time");
assert.equal(run(d, -45, 200), 1);
assert.equal(run(d, -52, 1000), 1, "hysteresis holds level 1 at +8 dB");
assert.equal(run(d, -60, 300), 1, "release has not elapsed");
assert.equal(run(d, -60, 200), 0);
assert.equal(run(d, -25, 200), 3);
console.log("unit ok");

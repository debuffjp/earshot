import assert from "node:assert/strict";
import { distanceGain, wallsBetween, occlusion, createLoudness, DEFAULTS as p } from "../public/earshot.js";

assert.equal(distanceGain(2, 2, 12), 1);
assert.equal(distanceGain(12, 2, 12), 0);
assert.equal(distanceGain(7, 2, 12), 0.5);

const tiles = [[0, 1, 0, 2, 0, 2, 0]];
const at = (x) => ({ x: x + 0.5, y: 0.5 });
assert.deepEqual(wallsBetween(tiles, at(0), at(0)), []);
assert.deepEqual(wallsBetween(tiles, at(0), at(2)), [1]);
assert.deepEqual(wallsBetween(tiles, at(2), at(4)), [2]);
assert.deepEqual(wallsBetween(tiles, at(0), at(6)), [1, 2, 2]);
assert.deepEqual(wallsBetween([[2, 2, 2, 0]], at(0), at(3)), [2], "a thick wall counts once");
assert.equal(occlusion([1], p).hz, 2000);
assert.equal(occlusion([2], p).hz, 1200);
assert.equal(occlusion([1, 2], p).hz, 700);

const run = (m, db, ms) => { for (let t = 0; t < ms; t += 16) m.update(db, 16); return m.level; };
const m = createLoudness();
m.calibrate([-60, -60, -60, -60, -30]);
assert.equal(m.floor, -60);
assert.equal(run(m, -60, 500), 0);
assert.equal(run(m, -45, 100), 0, "a short blip stays under attack time");
assert.equal(run(m, -45, 200), 1);
assert.equal(run(m, -52, 1000), 1, "hysteresis holds level 1 at +8 dB");
assert.equal(run(m, -60, 300), 1, "release has not elapsed");
assert.equal(run(m, -60, 200), 0);
assert.equal(run(m, -25, 200), 3);
console.log("unit ok");

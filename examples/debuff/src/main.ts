import { Audio } from "@debuffjp/audio";
import { Game } from "@debuffjp/core";
import { Input } from "@debuffjp/input";
import { createListener, wallsOnGrid } from "@debuffjp/earshot";

const canvas = document.querySelector<HTMLCanvasElement>("#game");
if (!canvas) throw new Error('Missing <canvas id="game">');

const TILE = 16;
const game = new Game({ canvas, width: 320, height: 176, background: "#11140d" });
const input = new Input(game, {
  bindings: {
    left: ["ArrowLeft", "KeyA"],
    right: ["ArrowRight", "KeyD"],
    up: ["ArrowUp", "KeyW"],
    down: ["ArrowDown", "KeyS"],
  },
});
const audio = new Audio();

const tiles: (string | null)[][] = Array.from({ length: 11 }, () => Array<string | null>(20).fill(null));
for (let y = 0; y < 11; y++) tiles[y]![10] = y < 6 ? "thin" : "solid";

const player = { x: 40, y: 88 };
const radio = { x: 256, y: 56 };

// A placeholder sound. Any AudioNode works, including an AudioBufferSourceNode or a plonk bus.
const tone = new OscillatorNode(audio.ctx, { type: "sawtooth", frequency: 220 });
const quiet = new GainNode(audio.ctx, { gain: 0.2 });
tone.connect(quiet);
tone.start();

const ear = createListener(audio.ctx, {
  output: audio.bus("sfx"),
  tile: TILE,
  pos: () => player,
  world: { wallsBetween: (a, b) => wallsOnGrid(tiles, a, b) },
});
const source = ear.source(quiet, { pos: () => radio });

game.add({
  id: "play",
  update(dt) {
    player.x += input.axis("left", "right") * 80 * dt;
    player.y += input.axis("up", "down") * 80 * dt;
    ear.update();
  },
  render(draw) {
    for (let y = 0; y < tiles.length; y++) {
      for (let x = 0; x < 20; x++) {
        const wall = tiles[y]![x];
        if (wall) draw.rect(x * TILE, y * TILE, TILE, TILE, wall === "thin" ? "#6b7a58" : "#d3dcc2");
      }
    }
    draw.circle(radio.x, radio.y, 6, "#38bdf8");
    draw.circle(player.x, player.y, 6, "#cffb2d");
    draw.text(source.state, 6, 6, { color: "#d3dcc2" });
  },
  inspect: () => ({ player, state: source.state, mix: source.mix }),
}).go("play");
game.start();

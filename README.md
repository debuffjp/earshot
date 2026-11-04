# Earshot

Spatial audio for 2D web games: sound that knows about walls and rooms, plus mic loudness as game input. No runtime dependencies, about 3.7 KB gzipped before minifying, and any engine that can give it a Web Audio context.

```bash
npm i @debuffjp/earshot
```

## Sound through walls

```ts
import { createListener, wallsOnGrid } from "@debuffjp/earshot";

const ctx = new AudioContext(); // Resume it from a tap or key press.
const ear = createListener(ctx, {
  tile: 16,
  pos: () => player,
  world: {
    wallsBetween: (a, b) => wallsOnGrid(tiles, a, b), // tiles[y][x] is "thin", "solid" or null
    reverbAt: (p) => (p.y > 20 ? "cave" : null),
  },
});

const radio = ear.source(radioNode, { pos: () => radioPosition });

// In your game loop. 10 to 20 times a second is enough.
ear.update();
radio.state; // "audible" | "out-of-range" | "muted"
```

A source is any `AudioNode`, and it starts silent until the first `update()`. Positions are in your world units, and `tile` converts them. `ear.params`, `ear.materials` and `ear.reverbs` are live, so you can tune them while the game runs. `computeMix` returns the same decision as plain numbers, without Web Audio.

The defaults are starting points tuned on one demo, not measured standards:

| Setting | Default |
|---|---|
| Full volume, silence | 2 tiles, 12 tiles |
| Thin wall | 2000 Hz, -6 dB |
| Solid wall | 1200 Hz, -12 dB |
| Two or more walls | 700 Hz, -18 dB |
| Room reverb | 0.4 s, wet -18 dB |
| Cave reverb | 1.8 s, wet -12 dB |

Each reverb is shared by every source in it, because convolvers are expensive.

## Loudness as input

```ts
import { createLoudness } from "@debuffjp/earshot";

const loud = createLoudness(ctx);
loud.onLevel((level) => { if (level >= 2) monster.hear(player); }); // 0 to 3

// From a button: the player stays quiet for 3 seconds while it measures the room.
const { ok, error } = await loud.enableMic();

// Keys work with or without a mic.
loud.press(1);
loud.press(0);
```

To make walls and distance matter, check what the noise sounds like where the monster is. The threshold is yours to tune; 6 dB felt right in the Wake It demo.

```ts
import { computeMix, heardDb, wallsOnGrid, DEFAULT_MATERIALS, DEFAULT_PARAMS } from "@debuffjp/earshot";

const walls = wallsOnGrid(tiles, player, monster); // Both in tile units.
const mix = computeMix(player, monster, walls, DEFAULT_PARAMS, DEFAULT_MATERIALS);
if (loud.level >= 2 && heardDb(loud.level, mix) >= 6) monster.wake();
```

Audio goes to an analyser and no further: Earshot doesn't record it, send it or play it back. Levels are relative to the measured noise floor, so loud and quiet rooms behave alike.

Always give players a key or button through `press()`. Don't require words or long strain, and tell players what the mic is for before asking.

## What to know

- The mic needs HTTPS or localhost, and an iframe needs `allow="microphone"`.
- A denied mic returns `{ ok: false, error }`, so your game carries on.
- Browsers can ignore constraints. Read `loud.applied` for what you got.
- Opening the mic can change game audio on iPhones. [WebKit bug 311451](https://bugs.webkit.org/show_bug.cgi?id=311451) reports lower quality and mono output on iOS 26.4 and later. Test on a real phone.
- Tested on a desktop browser and one iPhone. Android is untested.
- Pan uses horizontal position only, which suits top-down and side-on games.

## With debuff

Pass debuff's context and a bus, so Earshot follows the game's volume. See [examples/debuff](examples/debuff).

```ts
const ear = createListener(audio.ctx, { output: audio.bus("sfx"), pos: () => player });
```

## Demos

```bash
npm start
```

This prints a local address, plus an HTTPS address and QR code for phones on your network. The certificate is self-signed and needs `openssl`.

## Licence

MIT

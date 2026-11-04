# Earshot voice rooms

A Cloudflare Worker that connects players for `joinVoiceRoom()`. You deploy it to your own account and you pay for it: nobody hosts this for you. Voice normally travels between players or through TURN, never through this Worker.

## Set up

1. Copy this folder into your project and run `npm install`.
2. In the Cloudflare dashboard, create a TURN key under Realtime. It gives you a key ID and an API token.
3. Set `ALLOWED_ORIGINS` in `wrangler.jsonc` to your game's address.
4. Add the secrets and deploy:

```bash
npx wrangler secret put TURN_KEY_ID
```

```bash
npx wrangler secret put TURN_KEY_API_TOKEN
```

```bash
npx wrangler deploy
```

5. Pass the Worker's address to your game as `wss://earshot-voice.<your-subdomain>.workers.dev`.

Test from two different networks, such as Wi-Fi and a phone on mobile data. Set a usage alert in Cloudflare too.

## Costs

TURN bills relayed traffic after Cloudflare's free allowance, which was 1,000 GB a month at $0.05/GB afterwards when this was written. Worst case at 32 kbps, with everyone relayed and talking all the time, is about 0.29 GB per room-hour for 4 players and 1.35 GB for 8. Check current prices before relying on these.

## Before you ship

Edit `canJoin` in `src/index.js`. As shipped, anyone with a room code can join, and it does nothing about bans or age.

- The origin check stops other websites, not custom clients. Anyone determined can get TURN credentials from an open Worker, so require a login if your costs matter.
- There is no stranger matching. Room codes are for friends, so keep it that way unless you can moderate.
- You are responsible for privacy notices and for laws on children and online safety where your players are. This isn't legal advice.

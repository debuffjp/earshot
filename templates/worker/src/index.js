import { DurableObject } from "cloudflare:workers";

const CODE = /^[A-Za-z0-9_-]{16,64}$/;
const PEER = /^[A-Za-z0-9-]{8,64}$/;
const MAX_MESSAGE = 16 * 1024;

/**
 * Your rules go here: check a login, a ban list or a parent's consent.
 * Return false to refuse the connection. Everyone with a room code can join until you do.
 */
async function canJoin(request, env, { room, peer }) {
  return true;
}

async function iceServers(env) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return [{ urls: "stun:stun.cloudflare.com:3478" }];
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl: Number(env.TURN_TTL_SECONDS ?? 14400) }),
  });
  if (!response.ok) throw new Error(`TURN credentials: HTTP ${response.status}`);
  const { iceServers: servers } = await response.json();
  return servers;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/room") return new Response("Earshot voice rooms", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });

    const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim());
    if (!allowed.includes(request.headers.get("Origin"))) return new Response("Origin not allowed", { status: 403 });

    const room = url.searchParams.get("code") ?? "";
    const peer = url.searchParams.get("peer") ?? "";
    if (!CODE.test(room) || !PEER.test(peer)) return new Response("Bad room code or peer id", { status: 400 });
    if (!(await canJoin(request, env, { room, peer }))) return new Response("Not allowed", { status: 403 });

    const servers = await iceServers(env);
    const headers = new Headers(request.headers);
    headers.set("x-ice-servers", JSON.stringify(servers));
    headers.set("x-peer", peer);
    return env.ROOMS.getByName(room).fetch(new Request(request.url, { headers }));
  },
};

/** One voice room. It only passes connection messages between players: voice never comes through here. */
export class VoiceRoom extends DurableObject {
  async fetch(request) {
    const peer = request.headers.get("x-peer");
    const sockets = this.ctx.getWebSockets();
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    if (sockets.length >= Number(this.env.MAX_PLAYERS ?? 8)) {
      server.close(4001, "Room full");
      return new Response(null, { status: 101, webSocket: client });
    }
    const others = sockets.map((s) => s.deserializeAttachment()?.peer).filter(Boolean);
    server.serializeAttachment({ peer });
    server.send(JSON.stringify({ type: "welcome", peers: others, iceServers: JSON.parse(request.headers.get("x-ice-servers")) }));
    for (const s of sockets) s.send(JSON.stringify({ type: "join", from: peer }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, data) {
    if (typeof data !== "string" || data.length > MAX_MESSAGE) return ws.close(4002, "Bad message");
    let message;
    try { message = JSON.parse(data); } catch { return ws.close(4002, "Bad message"); }
    const from = ws.deserializeAttachment()?.peer;
    const target = this.ctx.getWebSockets().find((s) => s.deserializeAttachment()?.peer === message.to);
    target?.send(JSON.stringify({ ...message, from }));
  }

  webSocketClose(ws) {
    const from = ws.deserializeAttachment()?.peer;
    if (!from) return;
    for (const s of this.ctx.getWebSockets()) if (s !== ws) s.send(JSON.stringify({ type: "leave", from }));
  }
}

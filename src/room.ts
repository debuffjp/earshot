import type { Listener, MicResult, Point, Voice, VoiceMic } from "./index.js";

export interface VoiceRoomOptions {
  /** Your Worker's address, such as `wss://earshot-voice.you.workers.dev`. */
  url: string;
  /** From `createRoomCode()`. Anyone with the code can join, so share it only with friends. */
  code: string;
  /** A mic that has already started. */
  mic: VoiceMic;
  listener: Listener;
  /**
   * Required, with no default, because it's a privacy decision. "relay" sends all voice through
   * your TURN server, which hides IP addresses from other players but costs bandwidth, and fails
   * rather than falling back. "direct" connects players directly where it can, so they can see
   * each other's IP addresses.
   */
  ipPolicy: "relay" | "direct";
  /** Where a player is in the world, by their id. */
  pos(peer: string): Point;
  onPeer?(peer: string, voice: Voice): void;
  onLeave?(peer: string): void;
  /** A small message from `room.send`, for positions or names. It can arrive late or not at all. */
  onMessage?(peer: string, message: unknown): void;
}

export interface VoiceRoom {
  /** This player's id. */
  readonly id: string;
  readonly peers: ReadonlyMap<string, Voice>;
  /** Connection state by player, for your UI: "connecting", "connected", "failed" and so on. */
  connection(peer: string): RTCPeerConnectionState | null;
  /** Sends a small message to every connected player, directly rather than through your Worker. */
  send(message: unknown): void;
  leave(): void;
}

export type JoinResult = { ok: true; room: VoiceRoom } | (MicResult & { ok: false; error: string });

interface Peer {
  pc: RTCPeerConnection;
  sender: RTCRtpSender;
  channel: RTCDataChannel | null;
  voice: Voice | null;
  pending: RTCIceCandidateInit[];
  gated: boolean;
}

/** 128 random bits, which can't practically be guessed. */
export function createRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const hasTurn = (servers: RTCIceServer[]) => servers.some((s) => [s.urls].flat().some((u) => u.startsWith("turn")));

/**
 * Connects to a voice room on your own Worker and sends each player through `listener`.
 * Everyone connects to everyone, so upload grows with each player: keep rooms small.
 * Never rejects.
 */
export function joinVoiceRoom(options: VoiceRoomOptions): Promise<JoinResult> {
  const { mic, listener, ipPolicy } = options;
  const stream = mic.stream;
  if (!stream) return Promise.resolve({ ok: false, error: "mic-not-started" });
  const track = stream.getAudioTracks()[0]!;
  const id = crypto.randomUUID();
  const peers = new Map<string, Peer>();
  const voices = new Map<string, Voice>();
  let config: RTCConfiguration = {};
  let gate: ReturnType<typeof setInterval> | undefined;

  return new Promise((resolve) => {
    const socket = new WebSocket(`${options.url}/room?code=${encodeURIComponent(options.code)}&peer=${id}`);
    let settled = false;
    const finish = (result: JoinResult) => { if (!settled) { settled = true; resolve(result); } };
    const signal = (to: string, message: object) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ to, ...message }));
    };

    const useChannel = (peerId: string, peer: Peer, channel: RTCDataChannel) => {
      peer.channel = channel;
      channel.onmessage = (event) => options.onMessage?.(peerId, JSON.parse(event.data));
    };
    const connect = (peerId: string) => {
      const pc = new RTCPeerConnection(config);
      const peer: Peer = { pc, sender: pc.addTrack(track, stream), channel: null, voice: null, pending: [], gated: false };
      peers.set(peerId, peer);
      pc.onicecandidate = (event) => { if (event.candidate) signal(peerId, { type: "ice", candidate: event.candidate }); };
      pc.ondatachannel = (event) => useChannel(peerId, peer, event.channel);
      pc.ontrack = (event) => {
        peer.voice?.remove();
        peer.voice = listener.voice(event.streams[0]!, { pos: () => options.pos(peerId) });
        voices.set(peerId, peer.voice);
        options.onPeer?.(peerId, peer.voice);
      };
      return peer;
    };
    const drop = (peerId: string) => {
      const peer = peers.get(peerId);
      if (!peer) return;
      peer.voice?.remove();
      peer.pc.close();
      peers.delete(peerId);
      voices.delete(peerId);
      options.onLeave?.(peerId);
    };
    const flush = async (peer: Peer) => {
      for (const candidate of peer.pending) await peer.pc.addIceCandidate(candidate);
      peer.pending = [];
    };
    const offer = async (peerId: string) => {
      const peer = connect(peerId);
      useChannel(peerId, peer, peer.pc.createDataChannel("earshot", { ordered: false, maxRetransmits: 0 }));
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      signal(peerId, { type: "offer", sdp: peer.pc.localDescription });
    };

    const room: VoiceRoom = {
      id,
      peers: voices,
      connection: (peer) => peers.get(peer)?.pc.connectionState ?? null,
      send(message) {
        const data = JSON.stringify(message);
        for (const { channel } of peers.values()) if (channel?.readyState === "open") channel.send(data);
      },
      leave() {
        clearInterval(gate);
        socket.onclose = null;
        socket.close();
        for (const peerId of [...peers.keys()]) drop(peerId);
      },
    };

    socket.onmessage = async (event) => {
      const m = JSON.parse(event.data);
      if (m.type === "welcome") {
        if (ipPolicy === "relay" && !hasTurn(m.iceServers)) {
          socket.onclose = null;
          socket.close();
          return finish({ ok: false, error: "no-turn-server" });
        }
        config = { iceServers: m.iceServers, iceTransportPolicy: ipPolicy === "relay" ? "relay" : "all" };
        // Stops sending to players well out of range, which saves upload without renegotiating.
        gate = setInterval(() => {
          for (const peer of peers.values()) {
            const far = peer.voice?.mix ? peer.voice.mix.distance > listener.params.silentRadius * 1.25 : false;
            if (far !== peer.gated) {
              peer.gated = far;
              void peer.sender.replaceTrack(far ? null : track);
            }
          }
        }, 1000);
        // The newcomer offers to everyone, so two players never offer to each other at once.
        for (const peerId of m.peers) await offer(peerId);
        finish({ ok: true, room });
      } else if (m.type === "offer") {
        const peer = connect(m.from);
        await peer.pc.setRemoteDescription(m.sdp);
        await flush(peer);
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        signal(m.from, { type: "answer", sdp: peer.pc.localDescription });
      } else if (m.type === "answer") {
        const peer = peers.get(m.from);
        if (peer) { await peer.pc.setRemoteDescription(m.sdp); await flush(peer); }
      } else if (m.type === "ice") {
        const peer = peers.get(m.from);
        if (peer?.pc.remoteDescription) await peer.pc.addIceCandidate(m.candidate);
        else peer?.pending.push(m.candidate);
      } else if (m.type === "leave") drop(m.from);
    };
    socket.onclose = (event) => finish({ ok: false, error: event.code === 4001 ? "room-full" : "connection-failed" });
  });
}

/**
 * Tiny WebSocket room relay for 2048 Versus online mode.
 *
 * Why not WebRTC/PeerJS? Move payloads are tiny; a relay is far more reliable
 * across browsers/NATs. Signaling can succeed while ICE stays stuck in
 * "checking" forever — which is exactly the failure mode we hit in testing.
 *
 * Usage:
 *   node server/relay.mjs
 *   # listens on ws://127.0.0.1:8787  (PORT env overrides)
 *
 * Host:  ws://127.0.0.1:8787/?room=ABC123&intent=host
 * Guest: ws://127.0.0.1:8787/?room=ABC123&intent=join
 */
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8787);
const MAX_PEERS = 2;

/** @typedef {{ id: number, room: string, ws: import('ws').WebSocket }} Client */

/** @type {Map<string, Set<Client>>} */
const rooms = new Map();
let nextId = 1;

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, exceptId, obj) {
  const peers = rooms.get(room);
  if (!peers) return;
  const raw = JSON.stringify(obj);
  for (const c of peers) {
    if (c.id === exceptId) continue;
    if (c.ws.readyState === 1) c.ws.send(raw);
  }
}

function leave(client) {
  const peers = rooms.get(client.room);
  if (!peers) return;
  peers.delete(client);
  broadcast(client.room, client.id, {
    type: "sys",
    event: "peer-left",
  });
  if (peers.size === 0) rooms.delete(client.room);
  else {
    for (const c of peers) {
      send(c.ws, {
        type: "sys",
        event: "roster",
        count: peers.size,
      });
    }
  }
  console.log(`[relay] ${client.id} left ${client.room} (${peers.size} left)`);
}

const server = createServer((_req, res) => {
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end("2048 Versus relay OK\n");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const room = (url.searchParams.get("room") || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
  const intent = (url.searchParams.get("intent") || "join").toLowerCase();

  if (room.length !== 6) {
    send(ws, {
      type: "sys",
      event: "error",
      message: "Room code must be 6 characters",
    });
    ws.close();
    return;
  }

  const existing = rooms.get(room);

  if (intent === "host") {
    if (existing && existing.size > 0) {
      send(ws, {
        type: "sys",
        event: "error",
        message: "Room code already in use — create a new room",
      });
      ws.close();
      return;
    }
    rooms.set(room, new Set());
  } else {
    // join
    if (!existing || existing.size === 0) {
      send(ws, {
        type: "sys",
        event: "error",
        message: "Room not found — host must Create Room first",
      });
      ws.close();
      return;
    }
    if (existing.size >= MAX_PEERS) {
      send(ws, { type: "sys", event: "error", message: "Room is full" });
      ws.close();
      return;
    }
  }

  const peers = rooms.get(room);
  const client = { id: nextId++, room, ws };
  peers.add(client);
  const seat = peers.size === 1 ? "host" : "guest";
  console.log(`[relay] ${client.id} joined ${room} as ${seat} (${peers.size}/${MAX_PEERS})`);

  send(ws, {
    type: "sys",
    event: "welcome",
    room,
    peerId: client.id,
    seat,
    count: peers.size,
  });

  for (const c of peers) {
    send(c.ws, {
      type: "sys",
      event: "roster",
      count: peers.size,
    });
  }

  ws.on("message", (data) => {
    let text;
    if (typeof data === "string") text = data;
    else if (Buffer.isBuffer(data)) text = data.toString("utf8");
    else return;
    broadcast(room, client.id, {
      type: "relay",
      from: client.id,
      payload: text,
    });
  });

  ws.on("close", () => leave(client));
  ws.on("error", () => leave(client));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[relay] listening on ws://127.0.0.1:${PORT}`);
  console.log(`[relay] health check http://127.0.0.1:${PORT}/`);
});

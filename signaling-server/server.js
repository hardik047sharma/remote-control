const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");

// Fixed deployment config (no environment variables needed)
const PORT = 3000;
const ROOM_PASSWORD = "pass";
const BASE_PATH = "/remoteControl";
const WS_PATH = "/remoteControl/ws";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: WS_PATH, maxPayload: 10 * 1024 * 1024 });

app.use(express.static(path.join(__dirname, "public")));
app.use(BASE_PATH, express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.redirect(`${BASE_PATH}/`));

const rooms = {};

wss.on("connection", (ws) => {
  let role = null;
  let room = null;

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (role === "host" && room && rooms[room]) {
        const client = rooms[room].client;
        if (client && client.readyState === 1) {
          client.send(data, { binary: true });
        }
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "join") {
      if (msg.password !== ROOM_PASSWORD) {
        ws.send(JSON.stringify({ type: "error", message: "Invalid password" }));
        return;
      }

      room = msg.room || "default";
      role = msg.role;

      if (!rooms[room]) {
        rooms[room] = { host: null, client: null };
      }

      const r = rooms[room];

      if (role === "host") {
        if (r.host && r.host.readyState === 1) {
          r.host.close();
        }
        r.host = ws;
        ws.send(JSON.stringify({ type: "joined", role: "host" }));
        if (r.client && r.client.readyState === 1) {
          r.client.send(JSON.stringify({ type: "host-connected" }));
          ws.send(JSON.stringify({ type: "client-connected" }));
        }
      } else if (role === "client") {
        if (r.client && r.client.readyState === 1) {
          r.client.close();
        }
        r.client = ws;
        ws.send(JSON.stringify({ type: "joined", role: "client" }));
        if (r.host && r.host.readyState === 1) {
          r.host.send(JSON.stringify({ type: "client-connected" }));
          ws.send(JSON.stringify({ type: "host-connected" }));
        }
      }
      return;
    }

    if (msg.type === "input" && role === "client") {
      if (room && rooms[room] && rooms[room].host) {
        const host = rooms[room].host;
        if (host.readyState === 1) {
          host.send(JSON.stringify(msg));
        }
      }
      return;
    }

    if (msg.type === "screen-info" && role === "host") {
      if (room && rooms[room] && rooms[room].client) {
        const client = rooms[room].client;
        if (client.readyState === 1) {
          client.send(JSON.stringify(msg));
        }
      }
      return;
    }
  });

  ws.on("close", () => {
    if (room && rooms[room]) {
      const r = rooms[room];
      if (role === "host") {
        r.host = null;
        if (r.client && r.client.readyState === 1) {
          r.client.send(JSON.stringify({ type: "host-disconnected" }));
        }
      } else if (role === "client") {
        r.client = null;
        if (r.host && r.host.readyState === 1) {
          r.host.send(JSON.stringify({ type: "client-disconnected" }));
        }
      }
      if (!r.host && !r.client) {
        delete rooms[room];
      }
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Remote Desktop Server running on port ${PORT}`);
  console.log(`Client UI: http://0.0.0.0:${PORT}${BASE_PATH}/`);
  console.log(`WebSocket path: ${WS_PATH}`);
});

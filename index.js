require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

// In development / LAN mode, allow all origins so that peers on other
// devices (e.g. 192.168.x.x, 172.x.x.x) can connect successfully.
// VITE_SOCKET_URL / FRONTEND_URL can still pin a specific origin in prod.
const ALLOWED_ORIGINS = [
  "http://localhost:8080",
  "http://localhost:5173",
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
];

const IS_PRODUCTION = !!process.env.FRONTEND_URL;

const app = express();
app.use(cors({
  origin: (origin, callback) => {
    // Always allow same-machine / server-side requests (no Origin header)
    if (!origin) return callback(null, true);
    // In production, enforce the allowlist; in dev/LAN accept everything
    if (IS_PRODUCTION) {
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS: origin ${origin} not allowed`));
    }
    return callback(null, true);
  },
  methods: ["GET", "POST", "OPTIONS"],
  credentials: true,
}));
app.use(express.json());

// Auth routes (Google OAuth2)
const authRoutes = require("./routes/auth");
app.use("/api/auth", authRoutes);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    // Mirror the Express CORS policy: open in dev/LAN, restricted in prod
    origin: IS_PRODUCTION ? ALLOWED_ORIGINS : true,
    methods: ["GET", "POST"],
    credentials: true,
  },
  
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000,
});

const rooms = new Map();
const chatHistory = new Map();
const endedRooms = new Set();
const pendingKnocks = new Map();

// Per-room host tracking:
//   originalHostPeerId — the original creator; retains permanent host rights
//   activeHostPeerId   — who currently holds host powers (may be a temp stand-in)
//   hostChain          — ordered list of peerIds that have held temp host (for chain demotion)
const roomMeta = new Map();

const socketPeerMap = new Map();

// ─── helpers ────────────────────────────────────────────────────────────────

/** Demote every peer in the room whose isHost===true and peerId !== keepPeerId */
function demoteAllExcept(room, keepPeerId, keepDisplayName, io) {
  room.forEach((peer) => {
    if (peer.isHost && peer.peerId !== keepPeerId) {
      peer.isHost = false;
      io.to(peer.socketId).emit("host-demoted", {
        newHostPeerId: keepPeerId,
        newHostDisplayName: keepDisplayName,
      });
      console.log(`[Server] Demoted ${peer.peerId} (${peer.displayName}) — real host taking back control`);
    }
  });
}

/** Return the first peer in the room who is NOT excludePeerId, or null */
function pickNextHost(room, excludePeerId) {
  for (const peer of room.values()) {
    if (peer.peerId !== excludePeerId) return peer;
  }
  return null;
}

io.on("connection", (socket) => {
  console.log(`[Server] Socket connected: ${socket.id}`);

  socket.on("join-room", ({ roomCode, peerId, displayName, isHost, avatarUrl }) => {
    if (!roomCode || !peerId) return;

    // Reject join if the room has been permanently ended by the host
    if (endedRooms.has(roomCode)) {
      socket.emit("room-ended", { roomCode });
      return;
    }

    console.log(`[Server] ${peerId} (${displayName}) joining ${roomCode}`);

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.peerId = peerId;
    socket.data.displayName = displayName;
    socket.data.isHost = isHost;
    socket.data.avatarUrl = avatarUrl || null;
    socket.data.isMuted = true;
    socket.data.isCameraOff = true;
    socket.data.isMicLocked = false;
    socket.data.isCameraLocked = false;

    if (!rooms.has(roomCode)) {
      rooms.set(roomCode, new Map());
    }

    const room = rooms.get(roomCode);

    // Set up room meta (original host) the first time
    if (!roomMeta.has(roomCode)) {
      roomMeta.set(roomCode, { originalHostPeerId: isHost ? peerId : null, activeHostPeerId: isHost ? peerId : null });
    } else if (isHost && !roomMeta.get(roomCode).originalHostPeerId) {
      // Original host not recorded yet — record them
      roomMeta.get(roomCode).originalHostPeerId = peerId;
    }

    const meta = roomMeta.get(roomCode);

    // Determine effective isHost for this peer:
    // 1. If this is the original host rejoining → restore host, demote temp host
    // 2. Otherwise use the isHost flag sent by client
    let effectiveIsHost = isHost;

    if (meta.originalHostPeerId === peerId) {
      // Real host is (re)joining — always restore their host status.
      effectiveIsHost = true;

      // Find the actual current active host (meta may be stale from chain promotions)
      let prevActiveHostPeerId = meta.activeHostPeerId;
      let prevActiveHostDisplayName = "";
      room.forEach((peer) => {
        if (peer.isHost && peer.peerId !== peerId) {
          prevActiveHostPeerId = peer.peerId;
          prevActiveHostDisplayName = peer.displayName;
        }
      });

      // Demote ALL peers with isHost=true who aren't the real host
      demoteAllExcept(room, peerId, displayName, io);

      // Always sync meta to the real host
      meta.activeHostPeerId = peerId;

      console.log(`[Server] Real host ${peerId} (${displayName}) rejoined ${roomCode}; prev active host was ${prevActiveHostPeerId}`);

      // Broadcast to everyone already in room that host changed (real host back)
      socket.to(roomCode).emit("host-changed", {
        newHostPeerId: peerId,
        newHostDisplayName: displayName,
        prevHostPeerId: prevActiveHostPeerId,
        prevHostDisplayName: prevActiveHostDisplayName,
        isRestored: true,
      });
    }

    socket.data.isHost = effectiveIsHost;

    
    const existing = room.get(peerId);
    if (existing && existing.socketId !== socket.id) {
      console.log(`[Server] ${peerId} reconnected with new socket, cleaning stale entry`);
      socketPeerMap.delete(existing.socketId);
    }

    
    const existingPeers = [];
    room.forEach((peer) => {
      if (peer.peerId !== peerId) {
        existingPeers.push({
          peerId: peer.peerId,
          displayName: peer.displayName,
          avatarUrl: peer.avatarUrl || null,
          isHost: peer.isHost,
          isMuted: peer.isMuted,
          isCameraOff: peer.isCameraOff,
          isMicLocked: peer.isMicLocked,
          isCameraLocked: peer.isCameraLocked,
        });
      }
    });

    
    room.set(peerId, {
      socketId: socket.id,
      peerId,
      displayName,
      avatarUrl: avatarUrl || null,
      isHost: effectiveIsHost,
      isMuted: true,
      isCameraOff: true,
      isMicLocked: false,
      isCameraLocked: false,
    });

    socketPeerMap.set(socket.id, { roomCode, peerId });

    socket.emit("existing-peers", { peers: existingPeers });

    // Notify peer-joined with the effective isHost value
    socket.to(roomCode).emit("peer-joined", {
      peerId,
      displayName,
      avatarUrl: avatarUrl || null,
      isHost: effectiveIsHost,
    });

    // Only send host-transferred if host is RETURNING to a room already
    // occupied by other participants (existingPeers.length > 0)
    if (meta && meta.originalHostPeerId === peerId && effectiveIsHost && existingPeers.length > 0) {
      socket.emit("host-transferred", { newHostPeerId: peerId, newHostDisplayName: displayName, isRestored: true });
    }
  });

  socket.on("knock", ({ roomCode, peerId, displayName }) => {
    if (!roomCode || !peerId) return;

    if (endedRooms.has(roomCode)) {
      socket.emit("knock-denied", { roomCode, reason: "room-ended" });
      return;
    }

    if (!pendingKnocks.has(roomCode)) pendingKnocks.set(roomCode, new Map());
    pendingKnocks.get(roomCode).set(peerId, { socketId: socket.id, displayName });

    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit("knock-admitted", { roomCode });
      pendingKnocks.get(roomCode)?.delete(peerId);
      return;
    }

    let hostSocketId = null;
    room.forEach((peer) => {
      if (peer.isHost) hostSocketId = peer.socketId;
    });

    if (!hostSocketId) {
      socket.emit("knock-admitted", { roomCode });
      pendingKnocks.get(roomCode)?.delete(peerId);
      return;
    }

    io.to(hostSocketId).emit("participant-knocking", { peerId, displayName });
    console.log(`[Server] ${displayName} (${peerId}) knocking on ${roomCode}`);
  });

  socket.on("admit-participant", ({ roomCode, peerId }) => {
    const knocks = pendingKnocks.get(roomCode);
    const knocker = knocks?.get(peerId);
    if (knocker) {
      io.to(knocker.socketId).emit("knock-admitted", { roomCode });
      knocks.delete(peerId);
      console.log(`[Server] Host admitted ${peerId} to ${roomCode}`);
    }
  });

  socket.on("deny-participant", ({ roomCode, peerId }) => {
    const knocks = pendingKnocks.get(roomCode);
    const knocker = knocks?.get(peerId);
    if (knocker) {
      io.to(knocker.socketId).emit("knock-denied", { roomCode });
      knocks.delete(peerId);
      console.log(`[Server] Host denied ${peerId} from ${roomCode}`);
    }
  });

  socket.on("signal", ({ roomCode, fromPeer, toPeer, type, payload }) => {
    if (!roomCode || !toPeer) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    const targetPeer = room.get(toPeer);
    if (!targetPeer) {
      console.warn(`[Server] signal target ${toPeer} not found in room ${roomCode}`);
      return;
    }
    io.to(targetPeer.socketId).emit("signal", { fromPeer, type, payload });
  });

  socket.on("broadcast", ({ roomCode, fromPeer, type, payload }) => {
    if (!roomCode) return;
    socket.to(roomCode).emit(type, { fromPeer, payload });
  });

  socket.on("participant-status", ({ roomCode, peerId, isMuted, isCameraOff }) => {
    if (!roomCode || !peerId) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    const peer = room.get(peerId);
    if (!peer) return;
    peer.isMuted = isMuted;
    peer.isCameraOff = isCameraOff;
    socket.to(roomCode).emit("participant-updated", {
      peerId,
      isMuted,
      isCameraOff,
      isMicLocked: peer.isMicLocked,
      isCameraLocked: peer.isCameraLocked,
    });
  });

  socket.on("host-control", ({ roomCode, fromPeer, targetPeer, action, value }) => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    // Only the active host may send control signals
    const sender = room.get(fromPeer);
    if (!sender?.isHost) {
      console.warn(`[Server] host-control rejected: ${fromPeer} is not the active host in ${roomCode}`);
      return;
    }
    const target = room.get(targetPeer);
    if (!target) return;

    if (action === "lock-mic" || action === "unlock-mic") target.isMicLocked = value;
    if (action === "lock-camera" || action === "unlock-camera") target.isCameraLocked = value;
    if (action === "mute" || action === "unmute") target.isMuted = value;

    io.to(target.socketId).emit("host-control", {
      fromPeer,
      payload: { action, value },
    });

    socket.to(roomCode).emit("participant-updated", {
      peerId: targetPeer,
      isMuted: target.isMuted,
      isCameraOff: target.isCameraOff,
      isMicLocked: target.isMicLocked,
      isCameraLocked: target.isCameraLocked,
    });
  });

  socket.on("chat-message", ({ roomCode, peerId, senderName, content }) => {
    if (!roomCode) return;
    if (!chatHistory.has(roomCode)) {
      chatHistory.set(roomCode, []);
    }
    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      peerId,
      senderName,
      content,
      timestamp: Date.now(),
    };
    chatHistory.get(roomCode).push(message);
    io.to(roomCode).emit("chat-message", message);
  });

  socket.on("get-chat-history", ({ roomCode }) => {
    const history = chatHistory.get(roomCode) || [];
    socket.emit("chat-history", history);
  });

  socket.on("caption", ({ roomCode, peerId, displayName, text, interim }) => {
    if (!roomCode || !peerId) return;
    console.log(`[Server] Caption from ${displayName} (${peerId}): "${text}" interim:${interim}`);
    // Broadcast caption to all other participants in the room
    socket.to(roomCode).emit("caption", {
      peerId,
      displayName,
      text,
      interim,
      timestamp: Date.now(),
    });
  });

  socket.on("leave-room", ({ roomCode, peerId }) => {
    if (roomCode && peerId) {
      // Remove from socketPeerMap AND clear socket.data so the 'disconnect'
      // event that fires right after does NOT call handleLeave a second time
      socketPeerMap.delete(socket.id);
      socket.data.roomCode = null;
      socket.data.peerId = null;
      handleLeave(socket, roomCode, peerId);
    }
  });

  socket.on("end-room", ({ roomCode, peerId }, ackCallback) => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    const peer = room?.get(peerId);
    if (!peer?.isHost) {
      if (typeof ackCallback === "function") ackCallback({ ok: false, reason: "not-host" });
      return; // only the active host can trigger end-room
    }
    // Only the ORIGINAL (real) host may permanently end the room.
    // A temporary stand-in host must not be able to destroy the session.
    const meta = roomMeta.get(roomCode);
    if (meta?.originalHostPeerId && meta.originalHostPeerId !== peerId) {
      console.warn(`[Server] end-room rejected: ${peerId} is a temporary host, not the original host`);
      socket.emit("end-room-rejected", { reason: "Only the original host can end this meeting permanently." });
      if (typeof ackCallback === "function") ackCallback({ ok: false, reason: "not-original-host" });
      return;
    }
    console.log(`[Server] Host ${peerId} ended room ${roomCode} permanently`);
    // Mark as permanently ended so no one can rejoin
    endedRooms.add(roomCode);
    const roomKnocks = pendingKnocks.get(roomCode);
    if (roomKnocks) {
      roomKnocks.forEach(({ socketId }) => {
        io.to(socketId).emit("knock-denied", { roomCode, reason: "room-ended" });
      });
    }
    socket.to(roomCode).emit("room-ended", { roomCode });
    if (room) {
      rooms.delete(roomCode);
      chatHistory.delete(roomCode);
      roomMeta.delete(roomCode);
      pendingKnocks.delete(roomCode);
    }
    // Prevent disconnect from calling handleLeave again
    socketPeerMap.delete(socket.id);
    socket.data.roomCode = null;
    socket.data.peerId = null;
    socket.leave(roomCode);
    // Acknowledge to the client that the room has been ended
    if (typeof ackCallback === "function") ackCallback({ ok: true });
  });

  socket.on("disconnect", (reason) => {
    console.log(`[Server] Socket disconnected: ${socket.id} reason: ${reason}`);
    const mapping = socketPeerMap.get(socket.id);
    if (mapping) {
      socketPeerMap.delete(socket.id);
      handleLeave(socket, mapping.roomCode, mapping.peerId);
    } else if (socket.data.roomCode && socket.data.peerId) {
      handleLeave(socket, socket.data.roomCode, socket.data.peerId);
    }
  });
});

function handleLeave(socket, roomCode, peerId) {
  console.log(`[Server] ${peerId} leaving ${roomCode}`);

  const roomKnocks = pendingKnocks.get(roomCode);
  if (roomKnocks?.has(peerId)) {
    roomKnocks.delete(peerId);
    const room = rooms.get(roomCode);
    if (room) {
      room.forEach((peer) => {
        if (peer.isHost) {
          io.to(peer.socketId).emit("knock-cancelled", { peerId });
        }
      });
    }
  }

  const room = rooms.get(roomCode);
  if (room) {
    const leavingPeer = room.get(peerId);
    room.delete(peerId);

    if (room.size === 0) {
      rooms.delete(roomCode);
      chatHistory.delete(roomCode);
      roomMeta.delete(roomCode);
      pendingKnocks.delete(roomCode);
      console.log(`[Server] Room ${roomCode} is now empty, deleted`);
    } else if (leavingPeer?.isHost) {
      // Active host left — promote the next available participant.
      // Use pickNextHost to skip the leaving peer (already deleted from map).
      const meta = roomMeta.get(roomCode);
      const nextPeer = pickNextHost(room, peerId);
      if (nextPeer && meta) {
        nextPeer.isHost = true;
        meta.activeHostPeerId = nextPeer.peerId; // always keep meta in sync
        const isRealHost = meta.originalHostPeerId === nextPeer.peerId;
        const leavingDisplayName = leavingPeer?.displayName ?? "";
        console.log(
          `[Server] Host left — promoting ${nextPeer.peerId} (${nextPeer.displayName}) | isTemporary:${!isRealHost}`
        );
        // Tell the newly promoted host they now have host powers
        io.to(nextPeer.socketId).emit("host-transferred", {
          newHostPeerId: nextPeer.peerId,
          newHostDisplayName: nextPeer.displayName,
          isRestored: isRealHost,   // true only if the promoted peer IS the real host
          isTemporary: !isRealHost, // stand-in until real host returns
        });
        // Tell ALL others (including the room) who the new host is
        io.to(roomCode).emit("host-changed", {
          newHostPeerId: nextPeer.peerId,
          newHostDisplayName: nextPeer.displayName,
          prevHostPeerId: peerId,
          prevHostDisplayName: leavingDisplayName,
          isTemporary: !isRealHost,
        });
      }
    }
  }
  socket.to(roomCode).emit("peer-left", { peerId });
  socket.leave(roomCode);
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
});

require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Auth routes (Google OAuth2)
const authRoutes = require("./routes/auth");
app.use("/api/auth", authRoutes);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000,
});

const rooms = new Map();
const chatHistory = new Map();

const socketPeerMap = new Map();

io.on("connection", (socket) => {
  console.log(`[Server] Socket connected: ${socket.id}`);

  socket.on("join-room", ({ roomCode, peerId, displayName, isHost }) => {
    if (!roomCode || !peerId) return;

    console.log(`[Server] ${peerId} (${displayName}) joining ${roomCode}`);

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.peerId = peerId;
    socket.data.displayName = displayName;
    socket.data.isHost = isHost;
    socket.data.isMuted = true;
    socket.data.isCameraOff = true;
    socket.data.isMicLocked = false;
    socket.data.isCameraLocked = false;

    if (!rooms.has(roomCode)) {
      rooms.set(roomCode, new Map());
    }

    const room = rooms.get(roomCode);

    
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
      isHost,
      isMuted: true,
      isCameraOff: true,
      isMicLocked: false,
      isCameraLocked: false,
    });

    socketPeerMap.set(socket.id, { roomCode, peerId });

    
    socket.emit("existing-peers", { peers: existingPeers });

    
    socket.to(roomCode).emit("peer-joined", {
      peerId,
      displayName,
      isHost,
    });
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
      handleLeave(socket, roomCode, peerId);
    }
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
  const room = rooms.get(roomCode);
  if (room) {
    room.delete(peerId);
    if (room.size === 0) {
      rooms.delete(roomCode);
      chatHistory.delete(roomCode);
      console.log(`[Server] Room ${roomCode} is now empty, deleted`);
    }
  }
  socket.to(roomCode).emit("peer-left", { peerId });
  socket.leave(roomCode);
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
});

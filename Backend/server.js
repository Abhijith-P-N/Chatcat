// server.js
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const connectDB = require("./config/db");
const userRoutes = require("./routes/userRoutes");
const chatRoutes = require("./routes/chatRoutes");
const uploadRoutes = require("./routes/uploadRoutes");
const { notFound, errorHandler } = require("./middleware/errorMiddleware");
const path = require("path");

dotenv.config();
connectDB();

const app = express();

// ✅ Allow multiple origins (local + deployed)
const FRONTEND_ORIGINS = [
  "https://fanciful-croissant-bb4062.netlify.app" // optional HTTPS
];

// ✅ Global CORS middleware (apply before all routes)
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // Allow requests with no origin (e.g., Postman)
      if (FRONTEND_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      console.warn("❌ Blocked by CORS:", origin);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ✅ Handle preflight requests manually (works with Express 4 & 5)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// ✅ Parse JSON
app.use(express.json());

// ✅ API Routes
app.use("/api/users", userRoutes);
app.use("/api/chats", chatRoutes);
app.use("/api/upload", uploadRoutes);

// ✅ Serve static uploads
app.use("/uploads", express.static(path.join(__dirname, "/uploads")));

// ✅ Error Handling
app.use(notFound);
app.use(errorHandler);

// ✅ Create HTTP + Socket.IO Server
const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: FRONTEND_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true,
  },
  pingTimeout: 60000,
});

// ✅ Socket.IO Logic
io.on("connection", (socket) => {
  console.log("⚡ Socket connected:", socket.id);

  // --- Setup user room ---
  socket.on("setup", (userData) => {
    if (!userData?._id) return;
    socket.join(userData._id);
    console.log(`👤 ${userData.name} (${userData._id}) connected`);
    socket.emit("connected");
  });

  // --- Join chat ---
  socket.on("join chat", (roomId) => {
    socket.join(roomId);
    console.log(`📁 Joined chat room: ${roomId}`);
  });

  // --- Messaging ---
  socket.on("new message", (message) => {
    const chat = message.chat;
    if (!chat?.users) return console.log("⚠️ chat.users not defined.");

    chat.users.forEach((user) => {
      if (user._id === message.sender._id) return;
      io.to(user._id).emit("message received", message);
    });
  });

  // --- Call signaling events ---
  socket.on("call-user", (data) => {
    io.to(data.to).emit("incoming-call", {
      from: data.from,
      name: data.name,
      callType: data.callType,
    });
  });

  socket.on("call-accepted", (data) => {
    io.to(data.to).emit("call-accepted", { from: data.from });
  });

  // ✅ Added handshake for WebRTC stability
  socket.on("prepare-call", (data) => {
    io.to(data.to).emit("prepare-call", { from: data.from });
  });

  socket.on("ready-for-offer", (data) => {
    io.to(data.to).emit("ready-for-offer", { from: data.from });
  });

  // --- WebRTC signaling data ---
  socket.on("webrtc-offer", (data) => {
    io.to(data.to).emit("webrtc-offer", data);
  });

  socket.on("webrtc-answer", (data) => {
    io.to(data.to).emit("webrtc-answer", data);
  });

  socket.on("webrtc-ice-candidate", (data) => {
    io.to(data.to).emit("webrtc-ice-candidate", data);
  });

  socket.on("end-call", (data) => {
    io.to(data.to).emit("end-call", data);
  });

  // ✅ Notify peers on disconnect
  socket.on("disconnecting", () => {
    const rooms = Array.from(socket.rooms);
    rooms.forEach((room) => {
      if (room !== socket.id) {
        io.to(room).emit("peer-disconnected", { socketId: socket.id });
      }
    });
  });

  socket.on("disconnect", () => {
    console.log("❌ Socket disconnected:", socket.id);
  });
});

// ✅ Start Server
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

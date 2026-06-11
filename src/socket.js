import { Server } from "socket.io";

let io;

export const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: "https://v2.dothis2.com",
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["polling"], // Yahan bhi sirf polling set karein
  });

  io.on("connection", (socket) => {
    console.log("🔌 User connected:", socket.id);

    // ✅ Join personal room
    socket.on("join", (userId) => {
      socket.join(userId);
      console.log(`👤 User ${userId} joined personal room`);
    });

    // ✅ Join TASK rooms
    socket.on("join-tasks", (userId) => {
      socket.join(`user_tasks_${userId}`);
      console.log(`📋 User ${userId} joined tasks room`);
    });

    // ✅ Join conversation room
    socket.on("join-conversation", (conversationId) => {
      socket.join(conversationId);
      console.log(`💬 Joined conversation ${conversationId}`);
    });

    // ✅ Typing indicator (optional)
    socket.on("typing", ({ conversationId, user }) => {
      socket.to(conversationId).emit("typing", user);
    });

    socket.on("stop-typing", ({ conversationId }) => {
      socket.to(conversationId).emit("stop-typing");
    });

    socket.on("disconnect", () => {
      console.log("❌ User disconnected:", socket.id);
    });
  });

  return io;
};

// ✅ Access io anywhere (controllers, services)
export const getIO = () => {
  if (!io) throw new Error("Socket.io not initialized!");
  return io;
};

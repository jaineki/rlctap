const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(express.json());
app.use(express.static("public"));

// In-memory storage
const users = new Map();
const messages = [];
const MAX_MESSAGE_LENGTH = 500;
const MAX_USERNAME_LENGTH = 30;

// Helper functions
const getOnlineUsers = () => {
  return Array.from(users.values()).map(user => ({
    userId: user.userId,
    username: user.username
  }));
};

const broadcastUsers = () => {
  const onlineUsers = getOnlineUsers();
  io.emit("users:update", onlineUsers);
};

// REST API Endpoints
app.get("/api", (req, res) => {
  res.json({
    success: true,
    message: "Real-time chat API is running"
  });
});

app.get("/api/users", (req, res) => {
  res.json({
    success: true,
    users: getOnlineUsers()
  });
});

app.get("/api/info", (req, res) => {
  res.json({
    success: true,
    api: "Real-time Chat API",
    version: "1.0.0",
    socketIO: true,
    availableEvents: [
      "user:join",
      "user:leave",
      "users:update",
      "message:send",
      "message:new",
      "typing:start",
      "typing:stop"
    ],
    onlineUsers: users.size,
    totalMessages: messages.length
  });
});

// Socket.IO Logic
io.on("connection", (socket) => {
  console.log(`New client connected: ${socket.id}`);

  // User joins
  socket.on("user:join", (data) => {
    const { username } = data;
    
    // Validate username
    if (!username || username.trim().length === 0) {
      socket.emit("error", { message: "Username is required" });
      return;
    }
    
    const trimmedUsername = username.trim().slice(0, MAX_USERNAME_LENGTH);
    
    // Check if username already exists
    const existingUser = Array.from(users.values()).find(
      user => user.username.toLowerCase() === trimmedUsername.toLowerCase()
    );
    
    if (existingUser) {
      socket.emit("error", { message: "Username already taken" });
      return;
    }
    
    const userId = uuidv4();
    
    // Store user
    users.set(userId, {
      userId,
      socketId: socket.id,
      username: trimmedUsername
    });
    
    // Join a room for this user
    socket.join(`user:${userId}`);
    
    // Send current user info
    socket.emit("user:joined", {
      userId,
      username: trimmedUsername
    });
    
    // Send online users to the new user
    socket.emit("users:update", getOnlineUsers());
    
    // Broadcast to others that a user joined
    socket.broadcast.emit("user:join", {
      userId,
      username: trimmedUsername
    });
    
    // Update all users
    broadcastUsers();
    
    console.log(`User ${trimmedUsername} (${userId}) joined`);
  });

  // Send message
  socket.on("message:send", (data) => {
    const { message } = data;
    
    // Find user by socket ID
    const user = Array.from(users.values()).find(
      u => u.socketId === socket.id
    );
    
    if (!user) {
      socket.emit("error", { message: "You must join the chat first" });
      return;
    }
    
    // Validate message
    if (!message || message.trim().length === 0) {
      socket.emit("error", { message: "Message cannot be empty" });
      return;
    }
    
    const trimmedMessage = message.trim().slice(0, MAX_MESSAGE_LENGTH);
    
    const messageObj = {
      id: uuidv4(),
      userId: user.userId,
      username: user.username,
      message: trimmedMessage,
      timestamp: new Date().toISOString()
    };
    
    // Store message (keep last 100)
    messages.push(messageObj);
    if (messages.length > 100) {
      messages.shift();
    }
    
    // Broadcast to all connected clients
    io.emit("message:new", messageObj);
    
    console.log(`Message from ${user.username}: ${trimmedMessage}`);
  });

  // Typing indicators
  socket.on("typing:start", () => {
    const user = Array.from(users.values()).find(
      u => u.socketId === socket.id
    );
    
    if (user) {
      socket.broadcast.emit("typing:start", {
        userId: user.userId,
        username: user.username
      });
    }
  });

  socket.on("typing:stop", () => {
    const user = Array.from(users.values()).find(
      u => u.socketId === socket.id
    );
    
    if (user) {
      socket.broadcast.emit("typing:stop", {
        userId: user.userId,
        username: user.username
      });
    }
  });

  // User disconnect
  socket.on("disconnect", () => {
    let disconnectedUser = null;
    
    // Find and remove user
    for (const [userId, user] of users.entries()) {
      if (user.socketId === socket.id) {
        disconnectedUser = user;
        users.delete(userId);
        break;
      }
    }
    
    if (disconnectedUser) {
      // Broadcast to others that user left
      io.emit("user:leave", {
        userId: disconnectedUser.userId,
        username: disconnectedUser.username
      });
      
      // Update all users
      broadcastUsers();
      
      console.log(`User ${disconnectedUser.username} (${disconnectedUser.userId}) disconnected`);
    } else {
      console.log(`Unknown client disconnected: ${socket.id}`);
    }
  });

  // Error handling
  socket.on("error", (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
  });
});

// Error handling for server
server.on("error", (error) => {
  console.error("Server error:", error);
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to test the chat`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down server...");
  io.close(() => {
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  });
});

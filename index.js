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
  },
  // Increase ping timeout to prevent premature disconnections
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

// Middleware
app.use(express.json());
app.use(express.static("public"));

// In-memory storage with persistence
const users = new Map();
let messages = [];
const MAX_MESSAGE_LENGTH = 500;
const MAX_USERNAME_LENGTH = 30;
const MAX_MESSAGES_STORED = 1000; // Increased storage

// Load messages from memory (could be replaced with database)
// For demo purposes, we'll keep them in memory but with better handling

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

// Admin check middleware
const isAdmin = (req, res, next) => {
  const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
  if (adminKey === process.env.ADMIN_KEY || adminKey === 'admin123') {
    next();
  } else {
    res.status(403).json({
      success: false,
      message: "Unauthorized. Admin key required."
    });
  }
};

// REST API Endpoints
app.get("/api", (req, res) => {
  res.json({
    success: true,
    message: "Real-time chat API is running",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/users", (req, res) => {
  res.json({
    success: true,
    users: getOnlineUsers(),
    count: users.size
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
    totalMessages: messages.length,
    maxMessagesStored: MAX_MESSAGES_STORED
  });
});

// Get all messages (with optional limit)
app.get("/api/messages", (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const recentMessages = messages.slice(-limit);
  
  res.json({
    success: true,
    count: recentMessages.length,
    total: messages.length,
    messages: recentMessages
  });
});

// Get a specific message by ID
app.get("/api/messages/:id", (req, res) => {
  const message = messages.find(m => m.id === req.params.id);
  
  if (!message) {
    return res.status(404).json({
      success: false,
      message: "Message not found"
    });
  }
  
  res.json({
    success: true,
    message
  });
});

// Delete a specific message (Admin only)
app.delete("/api/messages/:id", isAdmin, (req, res) => {
  const messageId = req.params.id;
  const messageIndex = messages.findIndex(m => m.id === messageId);
  
  if (messageIndex === -1) {
    return res.status(404).json({
      success: false,
      message: "Message not found"
    });
  }
  
  const deletedMessage = messages[messageIndex];
  messages.splice(messageIndex, 1);
  
  // Notify all clients about message deletion
  io.emit("message:deleted", {
    messageId: messageId,
    deletedBy: "admin"
  });
  
  res.json({
    success: true,
    message: "Message deleted successfully",
    deletedMessage
  });
});

// Delete all messages (Admin only)
app.delete("/api/messages", isAdmin, (req, res) => {
  const deletedCount = messages.length;
  messages = [];
  
  // Notify all clients that all messages were deleted
  io.emit("messages:cleared", {
    deletedCount,
    clearedBy: "admin",
    timestamp: new Date().toISOString()
  });
  
  res.json({
    success: true,
    message: "All messages deleted successfully",
    deletedCount
  });
});

// Bulk delete messages by user (Admin only)
app.delete("/api/messages/user/:userId", isAdmin, (req, res) => {
  const userId = req.params.userId;
  const userMessages = messages.filter(m => m.userId === userId);
  const deletedCount = userMessages.length;
  
  messages = messages.filter(m => m.userId !== userId);
  
  // Notify all clients about bulk deletion
  io.emit("messages:cleared", {
    deletedCount,
    userId,
    clearedBy: "admin",
    timestamp: new Date().toISOString()
  });
  
  res.json({
    success: true,
    message: `Deleted ${deletedCount} messages from user`,
    deletedCount,
    userId
  });
});

// Delete messages older than specified time (Admin only)
app.delete("/api/messages/old/:hours", isAdmin, (req, res) => {
  const hours = parseInt(req.params.hours);
  if (isNaN(hours) || hours <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid hours parameter"
    });
  }
  
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  const deletedMessages = messages.filter(m => new Date(m.timestamp) < cutoffTime);
  const deletedCount = deletedMessages.length;
  
  messages = messages.filter(m => new Date(m.timestamp) >= cutoffTime);
  
  // Notify all clients
  io.emit("messages:cleared", {
    deletedCount,
    olderThanHours: hours,
    clearedBy: "admin",
    timestamp: new Date().toISOString()
  });
  
  res.json({
    success: true,
    message: `Deleted ${deletedCount} messages older than ${hours} hours`,
    deletedCount,
    hours
  });
});

// Socket.IO Logic
io.on("connection", (socket) => {
  console.log(`New client connected: ${socket.id}`);

  // Send existing messages to new user
  const recentMessages = messages.slice(-50); // Send last 50 messages
  socket.emit("messages:history", recentMessages);

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
      username: trimmedUsername,
      joinedAt: new Date().toISOString()
    });
    
    // Join a room for this user
    socket.join(`user:${userId}`);
    
    // Send current user info
    socket.emit("user:joined", {
      userId,
      username: trimmedUsername,
      joinedAt: new Date().toISOString()
    });
    
    // Send online users to the new user
    socket.emit("users:update", getOnlineUsers());
    
    // Broadcast to others that a user joined
    socket.broadcast.emit("user:join", {
      userId,
      username: trimmedUsername,
      joinedAt: new Date().toISOString()
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
    
    // Store message (keep last MAX_MESSAGES_STORED)
    messages.push(messageObj);
    if (messages.length > MAX_MESSAGES_STORED) {
      messages = messages.slice(-MAX_MESSAGES_STORED);
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
  socket.on("disconnect", (reason) => {
    console.log(`Client ${socket.id} disconnected: ${reason}`);
    
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
        username: disconnectedUser.username,
        leftAt: new Date().toISOString()
      });
      
      // Update all users
      broadcastUsers();
      
      console.log(`User ${disconnectedUser.username} (${disconnectedUser.userId}) disconnected`);
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

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to test the chat`);
  console.log(`Admin panel: http://localhost:${PORT}/admin.html`);
  console.log(`Admin key: admin123`);
});

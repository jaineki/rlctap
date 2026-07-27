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
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

// Middleware
app.use(express.json());
app.use(express.static("public"));

// In-memory storage
const users = new Map();
let messages = [];
const MAX_MESSAGE_LENGTH = 500;
const MAX_USERNAME_LENGTH = 30;
const MAX_MESSAGES_STORED = 1000;

// Admin configuration
const ADMIN_CONFIG = {
  password: process.env.ADMIN_PASSWORD || "admin123"
};

// AI Configuration
const AI_CONFIG = {
  apiUrl: "https://selovapi.onrender.com/api/jay",
  defaultUid: "8",
  commandPrefix: "/ai",
  enabled: true
};

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

// AI function to get response from API
async function getAIResponse(prompt) {
  try {
    const url = `${AI_CONFIG.apiUrl}?prompt=${encodeURIComponent(prompt)}&uid=${AI_CONFIG.defaultUid}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`AI API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data && data.status === true && data.response) {
      return data.response;
    } else {
      throw new Error("Invalid AI response format");
    }
  } catch (error) {
    console.error("AI API Error:", error);
    return "Sorry, I'm having trouble responding right now. Please try again later.";
  }
}

// Admin authentication middleware
const authenticateAdmin = (req, res, next) => {
  const providedPassword = req.headers['x-admin-password'] || req.query.adminPassword;
  
  if (!providedPassword) {
    return res.status(401).json({
      success: false,
      message: "Admin password required"
    });
  }

  if (providedPassword === ADMIN_CONFIG.password) {
    next();
  } else {
    res.status(403).json({
      success: false,
      message: "Invalid admin password"
    });
  }
};

// User authentication middleware for deleting their own messages
const authenticateUser = (req, res, next) => {
  const userId = req.headers['x-user-id'];
  const messageId = req.params.id;
  
  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "User ID required"
    });
  }
  
  const message = messages.find(m => m.id === messageId);
  if (!message) {
    return res.status(404).json({
      success: false,
      message: "Message not found"
    });
  }
  
  if (message.userId !== userId) {
    return res.status(403).json({
      success: false,
      message: "You can only delete your own messages"
    });
  }
  
  if (!users.has(userId)) {
    return res.status(401).json({
      success: false,
      message: "User not found or disconnected"
    });
  }
  
  next();
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
    maxMessagesStored: MAX_MESSAGES_STORED,
    ai: {
      enabled: AI_CONFIG.enabled,
      commandPrefix: AI_CONFIG.commandPrefix,
      apiUrl: AI_CONFIG.apiUrl
    }
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

// Delete a message - Users can delete their own messages
app.delete("/api/messages/:id", authenticateUser, (req, res) => {
  const messageId = req.params.id;
  const userId = req.headers['x-user-id'];
  
  const messageIndex = messages.findIndex(m => m.id === messageId);
  
  if (messageIndex === -1) {
    return res.status(404).json({
      success: false,
      message: "Message not found"
    });
  }
  
  const deletedMessage = messages[messageIndex];
  messages.splice(messageIndex, 1);
  
  io.emit("message:deleted", {
    messageId: messageId,
    userId: userId,
    deletedBy: "user",
    timestamp: new Date().toISOString()
  });
  
  res.json({
    success: true,
    message: "Message deleted successfully",
    deletedMessage
  });
});

// Admin protected routes
app.delete("/api/messages/all", authenticateAdmin, (req, res) => {
  const deletedCount = messages.length;
  messages = [];
  
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

app.delete("/api/messages/user/:userId", authenticateAdmin, (req, res) => {
  const userId = req.params.userId;
  const userMessages = messages.filter(m => m.userId === userId);
  const deletedCount = userMessages.length;
  
  messages = messages.filter(m => m.userId !== userId);
  
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

app.delete("/api/messages/old/:hours", authenticateAdmin, (req, res) => {
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
  const recentMessages = messages.slice(-50);
  socket.emit("messages:history", recentMessages);

  // User joins
  socket.on("user:join", (data) => {
    const { username } = data;
    
    if (!username || username.trim().length === 0) {
      socket.emit("error", { message: "Username is required" });
      return;
    }
    
    const trimmedUsername = username.trim().slice(0, MAX_USERNAME_LENGTH);
    
    const existingUser = Array.from(users.values()).find(
      user => user.username.toLowerCase() === trimmedUsername.toLowerCase()
    );
    
    if (existingUser) {
      socket.emit("error", { message: "Username already taken" });
      return;
    }
    
    const userId = uuidv4();
    
    users.set(userId, {
      userId,
      socketId: socket.id,
      username: trimmedUsername,
      joinedAt: new Date().toISOString()
    });
    
    socket.join(`user:${userId}`);
    
    socket.emit("user:joined", {
      userId,
      username: trimmedUsername,
      joinedAt: new Date().toISOString()
    });
    
    socket.emit("users:update", getOnlineUsers());
    
    socket.broadcast.emit("user:join", {
      userId,
      username: trimmedUsername,
      joinedAt: new Date().toISOString()
    });
    
    broadcastUsers();
    
    console.log(`User ${trimmedUsername} (${userId}) joined`);
  });

  // Send message - Now with AI support
  socket.on("message:send", async (data) => {
    const { message } = data;
    
    const user = Array.from(users.values()).find(
      u => u.socketId === socket.id
    );
    
    if (!user) {
      socket.emit("error", { message: "You must join the chat first" });
      return;
    }
    
    if (!message || message.trim().length === 0) {
      socket.emit("error", { message: "Message cannot be empty" });
      return;
    }
    
    const trimmedMessage = message.trim().slice(0, MAX_MESSAGE_LENGTH);
    
    // Check if message starts with AI command prefix
    const isAICommand = trimmedMessage.toLowerCase().startsWith(AI_CONFIG.commandPrefix + " ");
    
    if (isAICommand && AI_CONFIG.enabled) {
      // Extract the AI prompt (remove the /ai prefix)
      const aiPrompt = trimmedMessage.slice(AI_CONFIG.commandPrefix.length + 1).trim();
      
      if (aiPrompt.length > 0) {
        // Show typing indicator for AI
        socket.broadcast.emit("typing:start", {
          userId: "ai-bot",
          username: "AI Bot"
        });
        
        // Get AI response
        const aiResponse = await getAIResponse(aiPrompt);
        
        // Stop typing indicator
        socket.broadcast.emit("typing:stop", {
          userId: "ai-bot",
          username: "AI Bot"
        });
        
        // Create AI message object
        const aiMessageObj = {
          id: uuidv4(),
          userId: "ai-bot",
          username: "🤖 AI Bot",
          message: aiResponse,
          timestamp: new Date().toISOString(),
          isAI: true
        };
        
        // Store AI message
        messages.push(aiMessageObj);
        if (messages.length > MAX_MESSAGES_STORED) {
          messages = messages.slice(-MAX_MESSAGES_STORED);
        }
        
        // Broadcast AI response to all connected clients
        io.emit("message:new", aiMessageObj);
        
        console.log(`AI response to ${user.username}: ${aiResponse.substring(0, 50)}...`);
        return; // Don't process as regular message
      }
    }
    
    // Regular message (not AI)
    const messageObj = {
      id: uuidv4(),
      userId: user.userId,
      username: user.username,
      message: trimmedMessage,
      timestamp: new Date().toISOString(),
      isAI: false
    };
    
    messages.push(messageObj);
    if (messages.length > MAX_MESSAGES_STORED) {
      messages = messages.slice(-MAX_MESSAGES_STORED);
    }
    
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
    
    for (const [userId, user] of users.entries()) {
      if (user.socketId === socket.id) {
        disconnectedUser = user;
        users.delete(userId);
        break;
      }
    }
    
    if (disconnectedUser) {
      io.emit("user:leave", {
        userId: disconnectedUser.userId,
        username: disconnectedUser.username,
        leftAt: new Date().toISOString()
      });
      
      broadcastUsers();
      
      console.log(`User ${disconnectedUser.username} (${disconnectedUser.userId}) disconnected`);
    }
  });

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
  console.log(`Admin password: ${ADMIN_CONFIG.password}`);
  console.log(`AI Bot: Type "/ai <message>" to chat with AI`);
});

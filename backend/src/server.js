import "dotenv/config";
import cors from "cors";
import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import callEventRoutes from "./routes/callEvents.js";
import contactRequestRoutes from "./routes/contactRequests.js";
import contactRoutes from "./routes/contacts.js";
import conversationRoutes from "./routes/conversations.js";
import dashboardRoutes from "./routes/dashboard.js";
import messageRoutes from "./routes/messages.js";
import notificationRoutes from "./routes/notifications.js";
import profileRoutes from "./routes/profile.js";
import pushRoutes from "./routes/push.js";
import uploadRoutes from "./routes/uploads.js";
import userRoutes from "./routes/users.js";
import { seedDefaultAccounts } from "./services/defaultAccounts.js";
import { setupSocket } from "./socket.js";

const app = express();
const server = http.createServer(app);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 4000;
const clientOrigin = process.env.FRONTEND_URL || "http://localhost:5173";

app.use(cors({ origin: clientOrigin, credentials: true }));
app.use(express.json());
app.use("/uploads", express.static(path.resolve(__dirname, "../uploads")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, name: "Zivico Talk API" });
});

app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/contacts", contactRoutes);
app.use("/api/contact-requests", contactRequestRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/call-events", callEventRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/users", userRoutes);
app.use("/api/messages", messageRoutes);

const io = new Server(server, {
  cors: {
    origin: clientOrigin,
    credentials: true
  }
});

app.set("io", io);
setupSocket(io);

await seedDefaultAccounts()
  .then(({ support }) => {
    if (!support) return;
    console.log("Default support account ensured");
    console.log(`Support email: ${support.email}`);
  })
  .catch((error) => {
    console.error("Default account seed skipped:", error.message);
  });

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other backend server or change PORT in .env.`);
    process.exit(0);
  }

  console.error(`Backend server failed to start: ${error.message}`);
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Zivico Talk backend listening on http://localhost:${PORT}`);
});

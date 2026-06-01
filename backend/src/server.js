import "dotenv/config";
import cors from "cors";
import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import authRoutes from "./routes/auth.js";
import callEventRoutes from "./routes/callEvents.js";
import contactRequestRoutes from "./routes/contactRequests.js";
import contactRoutes from "./routes/contacts.js";
import conversationRoutes from "./routes/conversations.js";
import messageRoutes from "./routes/messages.js";
import uploadRoutes from "./routes/uploads.js";
import userRoutes from "./routes/users.js";
import { setupSocket } from "./socket.js";

const app = express();
const server = http.createServer(app);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = Number(process.env.PORT || 4000);
const clientOrigin = process.env.FRONTEND_URL || "http://localhost:5173";

app.use(cors({ origin: clientOrigin, credentials: true }));
app.use(express.json());
app.use("/uploads", express.static(path.resolve(__dirname, "../uploads")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, name: "Zivico Talk API" });
});

app.use("/api/auth", authRoutes);
app.use("/api/contacts", contactRoutes);
app.use("/api/contact-requests", contactRequestRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/call-events", callEventRoutes);
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

server.listen(port, "0.0.0.0", () => {
  console.log(`Zivico Talk backend listening on http://localhost:${port}`);
});

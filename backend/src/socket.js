import { v4 as uuid } from "uuid";
import { verifySocketToken } from "./middleware/auth.js";
import { createNotification, markConversationRead, saveMessage, updateMessageStatus } from "./services/store.js";

const onlineUsers = new Map();

export function getOnlineUserCount() {
  return onlineUsers.size;
}

function publicOnlineUsers() {
  return Array.from(onlineUsers, ([userId, entry]) => ({
    id: userId,
    name: entry.user.name,
    email: entry.user.email
  }));
}

function emitPresence(io) {
  io.emit("presence", publicOnlineUsers());
}

export function setupSocket(io) {
  io.use(verifySocketToken);

  io.on("connection", (socket) => {
    const user = socket.user;
    socket.join(user.id);
    onlineUsers.set(user.id, { socketId: socket.id, user });
    console.log("user joined", user.id);
    emitPresence(io);

    async function handleMessage(
      {
        receiverId,
        message,
        text,
        clientId,
        type,
        mediaUrl,
        mediaName,
        mediaMimeType,
        mediaDurationSeconds,
        replyToMessageId
      },
      ack
    ) {
      const receiverRoom = String(receiverId);
      const messageText = String(text || message || "").trim();
      const messageType = type || (mediaUrl ? "file" : "text");
      if (!receiverId || (!messageText && !mediaUrl)) {
        ack?.({ ok: false, message: "receiverId and message text or media are required" });
        return;
      }

      const messageId = clientId ? String(clientId) : uuid();
      const payload = await saveMessage({
        id: messageId,
        senderId: user.id,
        receiverId,
        type: messageType,
        text: messageText,
        message: messageText,
        mediaUrl,
        mediaName,
        mediaMimeType,
        mediaDurationSeconds,
        replyToMessageId,
        createdAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
        status: "sent"
      });
      console.log("message sent", payload.id);

      if (onlineUsers.has(receiverRoom)) {
        payload.status = "delivered";
        await updateMessageStatus(payload.id, "delivered");
        io.to(receiverRoom).emit("private-message", payload);
        io.to(receiverRoom).emit("receive-message", payload);
        console.log("message delivered", payload.id);
      }

      const notification = await createNotification({
        userId: receiverId,
        type: "new_message",
        title: `New message from ${user.name}`,
        body: messageText || mediaName || messageType
      });
      io.to(receiverRoom).emit("notification-created", notification);

      socket.emit("private-message", payload);
      socket.emit("message-status-updated", payload);
      ack?.({ ok: true, message: payload });
    }

    socket.on("private-message", handleMessage);
    socket.on("send-message", handleMessage);

    socket.on("message-read", async ({ peerId, messageIds = [] }) => {
      const updated = await markConversationRead({ readerId: user.id, peerId, messageIds });
      if (updated.length === 0) return;

      const readMessageIds = updated.map((message) => message.id);
      console.log("message read", readMessageIds);
      io.to(String(peerId)).emit("message-read", {
        from: user.id,
        messageIds: readMessageIds
      });
      io.to(String(peerId)).emit("messages-read", {
        from: user.id,
        messageIds: readMessageIds
      });
      socket.emit("message-read", {
        from: peerId,
        messageIds: readMessageIds
      });
      socket.emit("messages-read", {
        from: peerId,
        messageIds: readMessageIds
      });
    });

    socket.on("typing", ({ to, isTyping }) => {
      if (!to) return;
      io.to(String(to)).emit("typing", { from: user.id, name: user.name, isTyping: Boolean(isTyping) });
    });

    socket.on("call-offer", ({ to, offer, callType }) => {
      if (!to || !offer) return;
      io.to(String(to)).emit("call-offer", {
        from: user.id,
        fromUser: { id: user.id, name: user.name, email: user.email },
        offer,
        callType: callType || "voice"
      });
    });

    socket.on("call-answer", ({ to, answer, callType }) => {
      if (!to || !answer) return;
      io.to(String(to)).emit("call-answer", {
        from: user.id,
        answer,
        callType: callType || "voice"
      });
    });

    socket.on("ice-candidate", ({ to, candidate, callType }) => {
      if (!to || !candidate) return;
      io.to(String(to)).emit("ice-candidate", {
        from: user.id,
        candidate,
        callType: callType || "voice"
      });
    });

    socket.on("call-reject", ({ to, callType }) => {
      if (!to) return;
      io.to(String(to)).emit("call-reject", {
        from: user.id,
        callType: callType || "voice"
      });
    });

    socket.on("call-end", ({ to, callType }) => {
      if (!to) return;
      io.to(String(to)).emit("call-end", {
        from: user.id,
        callType: callType || "voice"
      });
    });

    socket.on("disconnect", () => {
      const current = onlineUsers.get(user.id);
      if (current?.socketId === socket.id) {
        onlineUsers.delete(user.id);
      }
      emitPresence(io);
    });
  });
}

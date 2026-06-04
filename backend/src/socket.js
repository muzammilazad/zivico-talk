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

    socket.on("call-user", ({ to, callerId, receiverId, callType, fromOffer }) => {
      const type = callType || "voice";
      console.log("call type sent", type);
      // For a production WhatsApp-like experience, this is also where the
      // backend should send a native/Web Push incoming-call notification to the
      // receiver's saved push subscriptions. Web browsers can wake a service
      // worker for a notification, but true background ringing/call UI needs
      // native Android/iOS push plus call-notification APIs.
      io.to(to).emit("call-user", {
        from: user.id,
        callerId: callerId || user.id,
        receiverId: receiverId || to,
        fromUser: { id: user.id, name: user.name, email: user.email },
        callType: type,
        fromOffer
      });
    });

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

    socket.on("call-accepted", ({ to, callerId, receiverId, callType }) => {
      io.to(to).emit("call-accepted", {
        from: user.id,
        callerId: callerId || to,
        receiverId: receiverId || user.id,
        fromUser: { id: user.id, name: user.name, email: user.email },
        callType: callType || "voice"
      });
    });

    socket.on("offer", ({ to, callerId, receiverId, offer, callType }) => {
      io.to(to).emit("offer", {
        from: user.id,
        callerId: callerId || user.id,
        receiverId: receiverId || to,
        offer,
        callType: callType || "voice"
      });
    });

    socket.on("answer", ({ to, callerId, receiverId, answer, callType }) => {
      io.to(to).emit("answer", {
        from: user.id,
        callerId: callerId || to,
        receiverId: receiverId || user.id,
        answer,
        callType: callType || "voice"
      });
    });

    socket.on("ice-candidate", ({ to, callerId, receiverId, candidate, callType }) => {
      io.to(to).emit("ice-candidate", {
        from: user.id,
        callerId: callerId || user.id,
        receiverId: receiverId || to,
        candidate,
        callType: callType || "voice"
      });
    });

    socket.on("call-rejected", ({ to, callerId, receiverId, callType }) => {
      io.to(to).emit("call-rejected", {
        from: user.id,
        callerId: callerId || to,
        receiverId: receiverId || user.id,
        callType: callType || "voice"
      });
    });

    socket.on("end-call", ({ to, callerId, receiverId, callType, callStatus }) => {
      io.to(to).emit("end-call", {
        from: user.id,
        callerId: callerId || user.id,
        receiverId: receiverId || to,
        callType: callType || "voice",
        callStatus
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

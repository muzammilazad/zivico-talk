import { v4 as uuid } from "uuid";
import { verifySocketToken } from "./middleware/auth.js";
import {
  createNotification,
  markConversationRead,
  saveCallEvent,
  saveMessage,
  updateMessageStatus
} from "./services/store.js";

const onlineUsers = new Map();
const activeCalls = new Map();
const CALL_TIMEOUT_MS = 30_000;

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

async function createCallEventAndNotify(io, call, status) {
  const event = await saveCallEvent({
    id: uuid(),
    type: "call_event",
    callType: call.callType,
    status,
    callerId: call.callerId,
    receiverId: call.receiverId,
    durationSeconds: 0,
    createdAt: new Date().toISOString()
  });

  io.to(String(call.callerId)).emit("call-event-created", event);
  io.to(String(call.receiverId)).emit("call-event-created", event);

  if (status === "missed") {
    const notification = await createNotification({
      userId: call.receiverId,
      type: "missed_call",
      title: "Missed call",
      body: `${call.callType} call`
    });
    io.to(String(call.receiverId)).emit("notification-created", notification);
    io.to(String(call.receiverId)).emit("missed-call", { callId: call.callId, event });
  }

  return event;
}

function clearCallTimeout(call) {
  if (call?.timeout) clearTimeout(call.timeout);
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

    socket.on("call-start", async ({ to, callId, callType }, ack) => {
      const receiverId = String(to || "");
      const nextCallId = String(callId || uuid());
      const type = callType || "voice";
      const receiverRoom = io.sockets.adapter.rooms.get(receiverId);
      const receiverSocketIds = receiverRoom ? Array.from(receiverRoom) : [];

      console.log("CALL_START received", { callId: nextCallId, callerId: user.id, callType: type });
      console.log("Receiver userId", receiverId);
      console.log("Receiver socketId", receiverSocketIds.length ? receiverSocketIds : "offline");

      if (!receiverId || !receiverRoom?.size) {
        console.log("Receiver not online, creating missed call", { callId: nextCallId, receiverId });
        const offlineCall = {
          callId: nextCallId,
          callerId: user.id,
          receiverId,
          callType: type
        };
        if (receiverId) await createCallEventAndNotify(io, offlineCall, "missed");
        socket.emit("call-unavailable", { callId: nextCallId, reason: "offline" });
        ack?.({ ok: false, callId: nextCallId, reason: "offline" });
        return;
      }

      const call = {
        callId: nextCallId,
        callerId: user.id,
        receiverId,
        callType: type,
        answered: false,
        timeout: null
      };

      call.timeout = setTimeout(async () => {
        try {
          const activeCall = activeCalls.get(nextCallId);
          if (!activeCall || activeCall.answered) return;

          activeCalls.delete(nextCallId);
          console.log("Call timeout, creating missed call", { callId: nextCallId });
          await createCallEventAndNotify(io, activeCall, "missed");
          io.to(String(activeCall.callerId)).emit("call-timeout", { callId: nextCallId });
          io.to(String(activeCall.receiverId)).emit("call-timeout", { callId: nextCallId });
        } catch (error) {
          console.error("Call timeout handling failed", error);
        }
      }, CALL_TIMEOUT_MS);

      activeCalls.set(nextCallId, call);
      console.log("Emitting incoming-call to receiver", { callId: nextCallId, receiverId });
      io.to(receiverId).emit("incoming-call", {
        callId: nextCallId,
        from: user.id,
        fromUser: { id: user.id, name: user.name, email: user.email },
        callType: type,
        timeoutMs: CALL_TIMEOUT_MS
      });
      ack?.({ ok: true, callId: nextCallId });
    });

    socket.on("call-offer", ({ to, callId, offer, callType }) => {
      if (!to || !offer) return;
      io.to(String(to)).emit("call-offer", {
        callId,
        from: user.id,
        fromUser: { id: user.id, name: user.name, email: user.email },
        offer,
        callType: callType || "voice"
      });
    });

    socket.on("call-answer", ({ to, callId, answer, callType }) => {
      if (!to || !answer) return;
      const call = activeCalls.get(String(callId || ""));
      if (call) {
        call.answered = true;
        clearCallTimeout(call);
        activeCalls.set(call.callId, call);
      }
      io.to(String(to)).emit("call-answer", {
        callId,
        from: user.id,
        answer,
        callType: callType || "voice"
      });
    });

    socket.on("ice-candidate", ({ to, callId, candidate, callType }) => {
      if (!to || !candidate) return;
      io.to(String(to)).emit("ice-candidate", {
        callId,
        from: user.id,
        candidate,
        callType: callType || "voice"
      });
    });

    socket.on("call-reject", async ({ to, callId, callType }) => {
      if (!to) return;
      const call = activeCalls.get(String(callId || ""));
      if (call) {
        clearCallTimeout(call);
        activeCalls.delete(call.callId);
        await createCallEventAndNotify(io, call, "declined");
      }
      io.to(String(to)).emit("call-reject", {
        callId,
        from: user.id,
        callType: callType || "voice"
      });
    });

    socket.on("call-end", async ({ to, callId, callType }) => {
      if (!to) return;
      const call = activeCalls.get(String(callId || ""));
      if (call) {
        clearCallTimeout(call);
        activeCalls.delete(call.callId);
        if (!call.answered) {
          await createCallEventAndNotify(io, call, "missed");
        }
      }
      io.to(String(to)).emit("call-end", {
        callId,
        from: user.id,
        callType: callType || "voice"
      });
    });

    socket.on("disconnect", () => {
      const current = onlineUsers.get(user.id);
      if (current?.socketId === socket.id) {
        const remainingUserSockets = io.sockets.adapter.rooms.get(String(user.id));
        const nextSocketId = remainingUserSockets ? Array.from(remainingUserSockets)[0] : null;
        if (nextSocketId) {
          onlineUsers.set(user.id, { socketId: nextSocketId, user });
        } else {
          onlineUsers.delete(user.id);
        }
      }

      const remainingUserSockets = io.sockets.adapter.rooms.get(String(user.id));
      if (!remainingUserSockets?.size) {
        for (const [callId, call] of activeCalls) {
          if (call.answered || (call.callerId !== user.id && call.receiverId !== user.id)) continue;

          clearCallTimeout(call);
          activeCalls.delete(callId);
          if (call.callerId === user.id) {
            console.log("Receiver not online, creating missed call", {
              callId,
              receiverId: call.receiverId,
              reason: "caller-disconnected"
            });
            createCallEventAndNotify(io, call, "missed").catch(console.error);
            io.to(String(call.receiverId)).emit("call-end", {
              callId,
              from: user.id,
              callType: call.callType
            });
          }
        }
      }
      emitPresence(io);
    });
  });
}

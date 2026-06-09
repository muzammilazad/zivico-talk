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
    console.log(`[Socket Debug] connected userId=${user.id} socketId=${socket.id}`);
    socket.join(user.id);
    console.log(`[Socket Debug] joined room=${user.id}`);
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

    socket.on("incoming_call", async (payload, ack) => {
      const receiverId = String(payload.to || payload.receiverId || "");
      const channelName = String(payload.channelName || "");
      const callType = payload.callType || (payload.isVideoCall ? "video" : "voice");
      const isVideoCall = callType === "video" || payload.isVideoCall === true;
      const nextCallId = String(payload.callId || uuid());
      const receiverRoom = io.sockets.adapter.rooms.get(receiverId);

      console.log("incoming_call received", {
        callId: nextCallId,
        callerId: user.id,
        receiverId,
        channelName,
        callType
      });

      if (!channelName || !/^[A-Za-z0-9]{1,50}$/.test(channelName)) {
        ack?.({ ok: false, callId: nextCallId, reason: "invalid-channel" });
        return;
      }

      if (!receiverId || !receiverRoom?.size) {
        const offlineCall = {
          callId: nextCallId,
          callerId: user.id,
          receiverId,
          channelName,
          callType,
          isVideoCall
        };
        if (receiverId) await createCallEventAndNotify(io, offlineCall, "missed");
        ack?.({ ok: false, callId: nextCallId, reason: "offline" });
        return;
      }

      const call = {
        callId: nextCallId,
        callerId: user.id,
        receiverId,
        channelName,
        callType,
        isVideoCall,
        answered: false,
        timeout: null
      };

      call.timeout = setTimeout(async () => {
        try {
          const activeCall = activeCalls.get(nextCallId);
          if (!activeCall || activeCall.answered) return;

          activeCalls.delete(nextCallId);
          await createCallEventAndNotify(io, activeCall, "missed");
          const timeoutPayload = {
            callId: nextCallId,
            channelName: activeCall.channelName,
            callType: activeCall.callType,
            isVideoCall: activeCall.isVideoCall,
            reason: "timeout"
          };
          io.to(String(activeCall.callerId)).emit("call_ended", timeoutPayload);
          io.to(String(activeCall.receiverId)).emit("call_ended", timeoutPayload);
        } catch (error) {
          console.error("Call timeout handling failed", error);
        }
      }, CALL_TIMEOUT_MS);

      activeCalls.set(nextCallId, call);
      io.to(receiverId).emit("incoming_call", {
        callId: nextCallId,
        channelName,
        from: user.id,
        callerId: user.id,
        callerName: user.name,
        receiverId,
        fromUser: { id: user.id, name: user.name, email: user.email },
        callType,
        isVideoCall,
        timeoutMs: CALL_TIMEOUT_MS
      });
      ack?.({ ok: true, callId: nextCallId, timeoutMs: CALL_TIMEOUT_MS });
    });

    socket.on("call_answered", (payload = {}) => {
      const to = payload.to || payload.callerId;
      const callId = payload.callId || payload.channelName;
      if (!to || !callId) return;
      const call = activeCalls.get(String(callId || ""));
      if (call) {
        call.answered = true;
        clearCallTimeout(call);
        activeCalls.set(call.callId, call);
      }
      io.to(String(to)).emit("call_answered", {
        callId,
        channelName: payload.channelName || call?.channelName,
        from: user.id,
        receiverId: user.id,
        callType: payload.callType || call?.callType || "voice",
        isVideoCall: payload.isVideoCall ?? call?.isVideoCall ?? false
      });
    });

    socket.on("call_rejected", async (payload = {}) => {
      const to = payload.to || payload.callerId;
      const callId = payload.callId || payload.channelName;
      if (!to) return;
      const call = activeCalls.get(String(callId || ""));
      if (call) {
        clearCallTimeout(call);
        activeCalls.delete(call.callId);
        await createCallEventAndNotify(io, call, "declined");
      }
      io.to(String(to)).emit("call_rejected", {
        callId,
        channelName: payload.channelName || call?.channelName,
        from: user.id,
        callType: payload.callType || call?.callType || "voice",
        isVideoCall: payload.isVideoCall ?? call?.isVideoCall ?? false,
        reason: payload.reason || "rejected"
      });
    });

    socket.on("call_ended", async (payload = {}) => {
      const to = payload.to ||
        (String(payload.callerId) === String(user.id) ? payload.receiverId : payload.callerId);
      const callId = payload.callId || payload.channelName;
      if (!to) return;
      const call = activeCalls.get(String(callId || ""));
      if (call) {
        clearCallTimeout(call);
        activeCalls.delete(call.callId);
        if (!call.answered) {
          await createCallEventAndNotify(io, call, "missed");
        }
      }
      io.to(String(to)).emit("call_ended", {
        callId,
        channelName: payload.channelName || call?.channelName,
        from: user.id,
        callType: payload.callType || call?.callType || "voice",
        isVideoCall: payload.isVideoCall ?? call?.isVideoCall ?? false,
        reason: payload.reason || "ended"
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
          const isCaller = String(call.callerId) === String(user.id);
          const isReceiver = String(call.receiverId) === String(user.id);
          if (!isCaller && !isReceiver) continue;

          clearCallTimeout(call);
          activeCalls.delete(callId);
          const otherUserId = isCaller ? call.receiverId : call.callerId;
          if (!call.answered) {
            console.log("Receiver not online, creating missed call", {
              callId,
              receiverId: call.receiverId,
              reason: isCaller ? "caller-disconnected" : "receiver-disconnected"
            });
            createCallEventAndNotify(io, call, "missed").catch(console.error);
          }
          io.to(String(otherUserId)).emit("call_ended", {
            callId,
            channelName: call.channelName,
            from: user.id,
            callType: call.callType,
            isVideoCall: call.isVideoCall,
            reason: "peer-disconnected"
          });
        }
      }
      emitPresence(io);
    });
  });
}

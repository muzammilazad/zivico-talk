import express from "express";
import { authRequired } from "../middleware/auth.js";
import { sendMessagePush } from "../services/fcmService.js";
import {
  deleteMessageReaction,
  deleteMessage,
  editMessage,
  findMessageForUser,
  forwardMessage,
  getConversation,
  getUserPushTarget,
  upsertMessageReaction
} from "../services/store.js";

const router = express.Router();
const allowedReactions = new Set(["👍", "❤️", "😂", "😮", "😢", "🙏"]);

function emitReactionEvent(req, message, action, reaction) {
  const io = req.app.get("io");
  const eventNames = {
    added: "message-reaction-added",
    updated: "message-reaction-updated",
    removed: "message-reaction-removed"
  };
  const eventName = eventNames[action] || "message-reaction-updated";
  const payload = { messageId: message.id, action, reaction };

  io?.to(String(message.senderId)).emit(eventName, payload);
  io?.to(String(message.receiverId)).emit(eventName, payload);
}

router.get("/:peerId", authRequired, async (req, res) => {
  const messages = await getConversation(req.user.id, req.params.peerId);
  return res.json(messages);
});

router.post("/:messageId/forward", authRequired, async (req, res) => {
  const receiverIds = Array.isArray(req.body.receiverIds) ? req.body.receiverIds : [];
  if (receiverIds.length === 0) {
    return res.status(400).json({ message: "receiverIds are required" });
  }

  try {
    const messages = await forwardMessage({
      messageId: req.params.messageId,
      senderId: req.user.id,
      receiverIds
    });

    if (!messages) {
      return res.status(404).json({ message: "Message not found" });
    }

    const io = req.app.get("io");
    messages.forEach((message) => {
      io?.to(String(message.receiverId)).emit("private-message", message);
      io?.to(String(message.receiverId)).emit("receive-message", message);
      io?.to(String(message.senderId)).emit("private-message", message);
      io?.to(String(message.senderId)).emit("message-status-updated", message);
    });

    await Promise.all(
      messages.map(async (message) => {
        try {
          const receiver = await getUserPushTarget(message.receiverId);
          if (!receiver?.fcmToken || !receiver.notifyMessages) return;

          await sendMessagePush({
            fcmToken: receiver.fcmToken,
            senderName: req.user.name,
            senderId: req.user.id,
            receiverId: message.receiverId,
            chatId: req.user.id,
            message:
              message.text ||
              message.mediaName ||
              message.type ||
              "New message"
          });
        } catch (error) {
          console.error("FCM forwarded message push failed", {
            messageId: message.id,
            receiverId: message.receiverId,
            message: error.message
          });
        }
      })
    );

    return res.status(201).json(messages);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ message: err.message || "Could not forward message" });
  }
});

router.patch("/:messageId", authRequired, async (req, res) => {
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ message: "Text is required" });

  const message = await editMessage({ messageId: req.params.messageId, userId: req.user.id, text });
  if (!message) return res.status(404).json({ message: "Editable message not found" });

  const io = req.app.get("io");
  io?.to(String(message.senderId)).emit("message-updated", message);
  io?.to(String(message.receiverId)).emit("message-updated", message);
  return res.json(message);
});

router.delete("/:messageId", authRequired, async (req, res) => {
  const scope = req.query.scope === "everyone" ? "everyone" : "me";
  const result = await deleteMessage({ messageId: req.params.messageId, userId: req.user.id, scope });
  if (!result) return res.status(404).json({ message: "Message not found" });

  const io = req.app.get("io");
  if (result.scope === "everyone") {
    io?.to(String(result.message.senderId)).emit("message-deleted", result.message);
    io?.to(String(result.message.receiverId)).emit("message-deleted", result.message);
  }
  return res.json(result);
});

router.post("/:messageId/reactions", authRequired, async (req, res) => {
  const emoji = String(req.body.emoji || "").trim();
  if (!allowedReactions.has(emoji)) {
    return res.status(400).json({ message: "Unsupported reaction" });
  }

  const result = await upsertMessageReaction({
    messageId: req.params.messageId,
    userId: req.user.id,
    emoji
  });

  if (!result) {
    return res.status(404).json({ message: "Message not found" });
  }

  const message = await findMessageForUser(req.params.messageId, req.user.id);
  emitReactionEvent(req, message, result.action, result.reaction);
  return res.json({ action: result.action, reaction: result.reaction });
});

router.delete("/:messageId/reactions", authRequired, async (req, res) => {
  const result = await deleteMessageReaction({
    messageId: req.params.messageId,
    userId: req.user.id
  });

  if (!result) {
    return res.status(404).json({ message: "Message not found" });
  }

  const message = await findMessageForUser(req.params.messageId, req.user.id);
  emitReactionEvent(req, message, "removed", result.reaction || { messageId: req.params.messageId, userId: req.user.id });
  return res.json({ action: "removed", reaction: result.reaction });
});

export default router;

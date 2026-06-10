import express from "express";
import { authRequired } from "../middleware/auth.js";
import {
  getContactStatus,
  searchUsers,
  updateUserFcmToken
} from "../services/store.js";

const router = express.Router();

router.get("/", authRequired, async (req, res) => {
  return res.json([]);
});

router.get("/search", authRequired, async (req, res) => {
  const users = await searchUsers({ query: req.query.q, currentUserId: req.user.id });
  const results = await Promise.all(
    users.map(async (user) => {
      const contactStatus = await getContactStatus(req.user.id, user.id);
      const relationshipStatus =
        contactStatus.relationshipStatus ||
        (contactStatus.status === "accepted" ? "accepted" : contactStatus.status === "rejected" ? "rejected" : "none");
      return {
        ...user,
        relationshipStatus,
        requestStatus: contactStatus.status,
        contactRequestId: contactStatus.request?.id || null
      };
    })
  );
  return res.json(results);
});

router.post("/fcm-token", authRequired, async (req, res) => {
  const authenticatedUserId = String(req.user.id);
  const requestedUserId = String(req.body?.userId || authenticatedUserId);
  const fcmToken = String(req.body?.fcmToken || "").trim();

  if (requestedUserId !== authenticatedUserId) {
    return res.status(403).json({
      message: "You can only update your own FCM token"
    });
  }

  if (!fcmToken || fcmToken.length > 4096) {
    return res.status(400).json({ message: "A valid fcmToken is required" });
  }

  try {
    await updateUserFcmToken(authenticatedUserId, fcmToken);
    console.log("FCM token saved", {
      userId: authenticatedUserId,
      tokenPrefix: `${fcmToken.slice(0, 12)}...`
    });
    return res.json({ ok: true, userId: authenticatedUserId });
  } catch (error) {
    console.error("FCM token save failed", {
      userId: authenticatedUserId,
      message: error.message
    });
    return res.status(500).json({ message: "Could not save FCM token" });
  }
});

export default router;

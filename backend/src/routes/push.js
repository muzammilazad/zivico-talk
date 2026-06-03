import express from "express";
import { authRequired } from "../middleware/auth.js";

const router = express.Router();
const pushSubscriptionsByUserId = new Map();

export function getPushSubscriptionsForUser(userId) {
  return Array.from(pushSubscriptionsByUserId.get(String(userId)) || []);
}

router.get("/vapid-public-key", (_req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || "" });
});

router.post("/subscribe", authRequired, (req, res) => {
  const subscription = req.body?.subscription;
  if (!subscription?.endpoint) {
    return res.status(400).json({ message: "Missing push subscription" });
  }

  const userId = String(req.user.id);
  const currentSubscriptions = pushSubscriptionsByUserId.get(userId) || new Map();
  currentSubscriptions.set(subscription.endpoint, subscription);
  pushSubscriptionsByUserId.set(userId, currentSubscriptions);

  // This stores browser Push API subscriptions for a future Web Push sender.
  // True WhatsApp-like background ringing requires native Android/iOS push and
  // call notification support; web push can show a notification, but cannot run
  // a continuous background ringtone or guarantee call-screen behavior.
  res.json({ ok: true, count: currentSubscriptions.size });
});

router.delete("/subscribe", authRequired, (req, res) => {
  const endpoint = req.body?.endpoint;
  const userId = String(req.user.id);
  const currentSubscriptions = pushSubscriptionsByUserId.get(userId);
  if (endpoint && currentSubscriptions) {
    currentSubscriptions.delete(endpoint);
  }
  res.json({ ok: true, count: currentSubscriptions?.size || 0 });
});

export default router;

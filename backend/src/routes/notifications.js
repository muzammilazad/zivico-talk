import express from "express";
import { authRequired } from "../middleware/auth.js";
import { clearNotifications, listNotifications, markNotificationRead } from "../services/store.js";

const router = express.Router();

router.get("/", authRequired, async (req, res) => {
  return res.json(await listNotifications(req.user.id));
});

router.post("/:notificationId/read", authRequired, async (req, res) => {
  return res.json(await markNotificationRead(req.user.id, req.params.notificationId));
});

router.post("/clear", authRequired, async (req, res) => {
  return res.json(await clearNotifications(req.user.id));
});

export default router;

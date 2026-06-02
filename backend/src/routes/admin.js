import express from "express";
import { adminRequired, authRequired } from "../middleware/auth.js";
import {
  getAdminMessageStats,
  getAdminMetrics,
  listAdminCallEvents,
  listAdminMediaFiles,
  listAdminUsers,
  setUserBlocked
} from "../services/store.js";
import { getOnlineUserCount } from "../socket.js";

const router = express.Router();

router.use(authRequired, adminRequired);

router.get("/metrics", async (_req, res) => {
  return res.json(await getAdminMetrics(getOnlineUserCount()));
});

router.get("/users", async (_req, res) => {
  return res.json(await listAdminUsers());
});

router.post("/users/:userId/block", async (req, res) => {
  return res.json(await setUserBlocked(req.params.userId, true));
});

router.post("/users/:userId/unblock", async (req, res) => {
  return res.json(await setUserBlocked(req.params.userId, false));
});

router.get("/call-logs", async (_req, res) => {
  return res.json(await listAdminCallEvents());
});

router.get("/message-stats", async (_req, res) => {
  return res.json(await getAdminMessageStats());
});

router.get("/media-files", async (_req, res) => {
  return res.json(await listAdminMediaFiles());
});

export default router;

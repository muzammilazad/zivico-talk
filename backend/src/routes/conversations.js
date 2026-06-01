import express from "express";
import { authRequired } from "../middleware/auth.js";
import { getConversationSummaries, getConversationTimeline } from "../services/store.js";

const router = express.Router();

router.get("/summary", authRequired, async (req, res) => {
  const summaries = await getConversationSummaries(req.user.id);
  return res.json(summaries);
});

router.get("/:userId/timeline", authRequired, async (req, res) => {
  const timeline = await getConversationTimeline(req.user.id, req.params.userId);
  return res.json(timeline);
});

export default router;

import express from "express";
import { authRequired } from "../middleware/auth.js";
import { getDashboardMetrics } from "../services/store.js";

const router = express.Router();

router.get("/", authRequired, async (req, res) => {
  const metrics = await getDashboardMetrics(req.user.id);
  return res.json(metrics);
});

export default router;

import express from "express";
import { authRequired } from "../middleware/auth.js";
import { getContactStatus, searchUsers } from "../services/store.js";

const router = express.Router();

router.get("/", authRequired, async (req, res) => {
  return res.json([]);
});

router.get("/search", authRequired, async (req, res) => {
  const users = await searchUsers({ query: req.query.q, currentUserId: req.user.id });
  const results = await Promise.all(
    users.map(async (user) => {
      const contactStatus = await getContactStatus(req.user.id, user.id);
      return { ...user, requestStatus: contactStatus.status };
    })
  );
  return res.json(results);
});

export default router;

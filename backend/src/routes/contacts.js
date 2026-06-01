import express from "express";
import { authRequired } from "../middleware/auth.js";
import { listAcceptedContacts } from "../services/store.js";

const router = express.Router();

router.get("/", authRequired, async (req, res) => {
  const contacts = await listAcceptedContacts(req.user.id);
  return res.json(contacts);
});

export default router;

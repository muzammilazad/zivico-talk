import bcrypt from "bcryptjs";
import express from "express";
import { authRequired } from "../middleware/auth.js";
import { findUserById, updateUserProfile, updateUserSettings } from "../services/store.js";
import { prisma } from "../services/prisma.js";

const router = express.Router();

router.patch("/", authRequired, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const phone = String(req.body.phone || "").trim();
  const about = String(req.body.about || "").trim();
  if (name.length < 2) return res.status(400).json({ message: "Name must be at least 2 characters" });
  return res.json(await updateUserProfile(req.user.id, { name, phone, about }));
});

router.patch("/settings", authRequired, async (req, res) => {
  return res.json(await updateUserSettings(req.user.id, req.body || {}));
});

router.post("/password", authRequired, async (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");
  if (newPassword.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });

  const user = await findUserById(req.user.id);
  if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return res.status(401).json({ message: "Current password is incorrect" });
  }

  await prisma.user.update({
    where: { id: req.user.id },
    data: { passwordHash: await bcrypt.hash(newPassword, 10) }
  });
  return res.json({ ok: true });
});

export default router;

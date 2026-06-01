import bcrypt from "bcryptjs";
import express from "express";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import { createUser, findUserByEmail, findUserByPhone } from "../services/store.js";

const router = express.Router();
const jwtSecret = process.env.JWT_SECRET || "zivico-talk-local-dev-secret";

function signToken(user) {
  return jwt.sign(
    { userId: user.id, id: user.id, name: user.name, email: user.email, phone: user.phone || "" },
    jwtSecret,
    { expiresIn: "7d" }
  );
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

router.post("/register", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const phone = String(req.body.phone || "").trim();
  const password = String(req.body.password || "");

  if (name.length < 2) {
    return res.status(400).json({ message: "Name must be at least 2 characters" });
  }
  if (!validEmail(email)) {
    return res.status(400).json({ message: "A valid email is required" });
  }
  if (phone && phone.length < 7) {
    return res.status(400).json({ message: "Phone number looks too short" });
  }
  if (password.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters" });
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    return res.status(409).json({ message: "Email is already registered" });
  }
  if (phone && (await findUserByPhone(phone))) {
    return res.status(409).json({ message: "Phone number is already registered" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await createUser({
    id: uuid(),
    name,
    email,
    phone,
    passwordHash,
    createdAt: new Date().toISOString()
  });

  const { passwordHash: _passwordHash, ...safeUser } = user;
  return res.status(201).json({ token: signToken(user), user: safeUser });
});

router.post("/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = await findUserByEmail(email);

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ message: "Invalid email or password" });
  }

  const { passwordHash, ...safeUser } = user;
  return res.json({ token: signToken(user), user: safeUser });
});

export default router;

import bcrypt from "bcryptjs";
import express from "express";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import { ensureSupportContactForUser } from "../services/defaultAccounts.js";
import { createUser, ensureAdminRole, findUserByEmail, findUserByPhone } from "../services/store.js";

const router = express.Router();
const jwtSecret = process.env.JWT_SECRET || "zivico-talk-local-dev-secret";

function signToken(user) {
  return jwt.sign(
    { userId: user.id, id: user.id, name: user.name, email: user.email, phone: user.phone || "", role: user.role || "user" },
    jwtSecret,
    { expiresIn: "7d" }
  );
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function handleAuthError(res, error) {
  console.error(error);
  return res.status(503).json({
    message: "Database connection failed. Check DATABASE_URL in backend/.env and make sure MySQL is running."
  });
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

  try {
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
      role: "client",
      passwordHash,
      createdAt: new Date().toISOString()
    });
    await ensureSupportContactForUser(user);

    const {
      passwordHash: _passwordHash,
      fcmToken: _fcmToken,
      ...safeUser
    } = user;
    return res.status(201).json({ token: signToken(user), user: safeUser });
  } catch (error) {
    return handleAuthError(res, error);
  }
});

router.post("/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  try {
    const user = await findUserByEmail(email);

    if (!user || user.isBlocked || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const safeUser = await ensureAdminRole(user);
    return res.json({ token: signToken(safeUser), user: safeUser });
  } catch (error) {
    return handleAuthError(res, error);
  }
});

export default router;

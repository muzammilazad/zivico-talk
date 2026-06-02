import jwt from "jsonwebtoken";

const jwtSecret = process.env.JWT_SECRET || "zivico-talk-local-dev-secret";

export function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "Missing token" });
  }

  try {
    req.user = jwt.verify(token, jwtSecret);
    req.user.id = req.user.userId || req.user.id;
    return next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}

export function adminRequired(req, res, next) {
  const role = req.user?.role || "client";
  if (role !== "admin" && role !== "manager") {
    return res.status(403).json({ message: "Admin access required" });
  }
  return next();
}

export function verifySocketToken(socket, next) {
  const token = socket.handshake.auth?.token;

  if (!token) {
    return next(new Error("Missing token"));
  }

  try {
    socket.user = jwt.verify(token, jwtSecret);
    socket.user.id = socket.user.userId || socket.user.id;
    return next();
  } catch {
    return next(new Error("Invalid token"));
  }
}

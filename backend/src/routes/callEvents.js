import express from "express";
import { v4 as uuid } from "uuid";
import { authRequired } from "../middleware/auth.js";
import { saveCallEvent } from "../services/store.js";

const router = express.Router();
const callTypes = new Set(["voice", "video", "screen"]);
const statuses = new Set(["started", "ended", "missed", "declined"]);

router.post("/", authRequired, async (req, res) => {
  const callType = callTypes.has(req.body.callType) ? req.body.callType : "voice";
  const status = statuses.has(req.body.status) ? req.body.status : "started";
  const receiverId = String(req.body.receiverId || "");

  if (!receiverId) return res.status(400).json({ message: "receiverId is required" });

  const event = await saveCallEvent({
    id: uuid(),
    type: "call_event",
    callType,
    status,
    callerId: req.body.callerId || req.user.id,
    receiverId,
    durationSeconds: Number(req.body.durationSeconds || 0),
    createdAt: new Date().toISOString()
  });

  const io = req.app.get("io");
  io?.to(String(event.callerId)).emit("call-event-created", event);
  io?.to(String(event.receiverId)).emit("call-event-created", event);
  console.log("call event saved", event.id);

  return res.status(201).json(event);
});

export default router;

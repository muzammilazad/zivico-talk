import express from "express";
import { v4 as uuid } from "uuid";
import { authRequired } from "../middleware/auth.js";
import { createNotification, listCallEventsForUser, saveCallEvent } from "../services/store.js";

const router = express.Router();
const callTypes = new Set(["voice", "video", "screen"]);
const statuses = new Set(["started", "ended", "missed", "declined"]);

router.get("/", authRequired, async (req, res) => {
  return res.json(await listCallEventsForUser(req.user.id));
});

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
  if (["missed", "declined"].includes(event.status)) {
    const notification = await createNotification({
      userId: event.receiverId,
      type: event.status === "missed" ? "missed_call" : "call_declined",
      title: event.status === "missed" ? "Missed call" : "Call declined",
      body: `${event.callType} call`
    });
    io?.to(String(event.receiverId)).emit("notification-created", notification);
  }
  console.log("call event saved", event.id);

  return res.status(201).json(event);
});

export default router;

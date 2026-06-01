import express from "express";
import { v4 as uuid } from "uuid";
import { authRequired } from "../middleware/auth.js";
import {
  acceptContactRequest,
  createContactRequest,
  findUserById,
  getContactStatus,
  listPendingContactRequests,
  rejectContactRequest
} from "../services/store.js";

const router = express.Router();

router.get("/", authRequired, async (req, res) => {
  const requests = await listPendingContactRequests(req.user.id);
  return res.json(requests);
});

router.post("/", authRequired, async (req, res) => {
  const receiverId = String(req.body.receiverId || "");
  if (!receiverId) return res.status(400).json({ message: "receiverId is required" });
  if (String(receiverId) === String(req.user.id)) return res.status(400).json({ message: "You cannot add yourself" });

  const receiver = await findUserById(receiverId);
  if (!receiver) return res.status(404).json({ message: "User not found" });

  const contactStatus = await getContactStatus(req.user.id, receiverId);
  if (contactStatus.status === "accepted") return res.status(409).json({ message: "Already contacts" });
  if (contactStatus.status === "pending") return res.status(409).json({ message: "Request pending" });

  const request = await createContactRequest({
    id: uuid(),
    requesterId: req.user.id,
    receiverId,
    status: "pending",
    createdAt: new Date().toISOString()
  });

  const payload = {
    ...request,
    requester: { id: req.user.id, name: req.user.name, email: req.user.email, phone: req.user.phone || "" }
  };
  const io = req.app.get("io");
  io?.to(String(receiverId)).emit("contact-request-received", payload);
  io?.to(String(req.user.id)).emit("contact-request-sent", payload);
  console.log("contact request sent", request.id);

  return res.status(201).json(payload);
});

router.post("/:requestId/accept", authRequired, async (req, res) => {
  const result = await acceptContactRequest(req.params.requestId, req.user.id);
  if (!result) return res.status(404).json({ message: "Pending request not found" });

  const io = req.app.get("io");
  io?.to(String(result.request.requesterId)).emit("contact-request-accepted", result);
  io?.to(String(result.request.receiverId)).emit("contact-request-accepted", result);
  console.log("contact request accepted", result.request.id);

  return res.json(result);
});

router.post("/:requestId/reject", authRequired, async (req, res) => {
  const request = await rejectContactRequest(req.params.requestId, req.user.id);
  if (!request) return res.status(404).json({ message: "Pending request not found" });

  const io = req.app.get("io");
  io?.to(String(request.requesterId)).emit("contact-request-rejected", request);
  io?.to(String(request.receiverId)).emit("contact-request-rejected", request);
  console.log("contact request rejected", request.id);

  return res.json(request);
});

export default router;

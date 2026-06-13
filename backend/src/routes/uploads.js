import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import { v4 as uuid } from "uuid";
import { authRequired } from "../middleware/auth.js";
import { saveMediaFile, updateUserAvatar } from "../services/store.js";

const uploadDir = path.join(process.cwd(), "uploads");

fs.mkdirSync(uploadDir, { recursive: true });

// TODO: Move media uploads to Cloudinary, Supabase, or Firebase Storage for production.
const allowedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/zip",
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "video/webm"
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const originalName = path.basename(file.originalname || "file");
    const sanitizedName = originalName
      .normalize("NFKD")
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "file";
    cb(null, `${Date.now()}-${sanitizedName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (allowedMimeTypes.has(file.mimetype)) return cb(null, true);
    cb(new Error("Unsupported file type"));
  }
});

const router = express.Router();

router.post("/", authRequired, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "file is required" });
  console.log("upload received", {
    uploaderId: req.user.id,
    fileName: req.file.originalname,
    mimeType: req.file.mimetype,
    size: req.file.size
  });

  if (req.body.purpose === "avatar" && !req.file.mimetype.startsWith("image/")) {
    return res.status(400).json({ message: "Profile image must be an image file" });
  }

  const relativeUrl = `/uploads/${req.file.filename}`;
  const publicBaseUrl = String(process.env.PUBLIC_API_URL || `${req.protocol}://${req.get("host")}`)
    .replace(/\/+$/, "");
  const url = `${publicBaseUrl}${relativeUrl}`;
  console.log("file saved", { path: req.file.path, url: relativeUrl });

  const media = await saveMediaFile({
    id: uuid(),
    uploaderId: req.user.id,
    url,
    fileName: req.file.originalname,
    mimeType: req.file.mimetype,
    size: req.file.size
  });

  if (req.body.purpose === "avatar") {
    await updateUserAvatar(req.user.id, url);
  }

  console.log("public URL returned", { url: media.url });
  return res.status(201).json({
    id: media.id,
    url: media.url,
    fileName: media.fileName,
    mimeType: media.mimeType,
    size: media.size
  });
});

router.use((err, _req, res, _next) => {
  if (err) {
    return res.status(400).json({ message: err.message || "Upload failed" });
  }
  return res.status(400).json({ message: "Upload failed" });
});

export default router;

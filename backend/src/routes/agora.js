import agoraToken from "agora-token";
import express from "express";

const { RtcTokenBuilder, RtcRole } = agoraToken;
const router = express.Router();
const RTC_TOKEN_EXPIRES_IN_SECONDS = 3600;

export function createRtcToken(req, res) {
  try {
    const appId = String(process.env.AGORA_APP_ID || "").trim();
    const appCertificate = String(
      process.env.AGORA_APP_CERTIFICATE || ""
    ).trim();
    const channelName = String(req.query.channelName || "");
    const numericUid = Number(req.query.uid);

    console.log("Agora token request:", {
      channelName,
      uid: req.query.uid
    });
    console.log("Agora App ID loaded:", Boolean(appId));
    console.log("Agora Certificate loaded:", Boolean(appCertificate));

    if (!appId || !appCertificate) {
      return res.status(500).json({ error: "Agora server config missing" });
    }

    if (!/^[A-Za-z0-9]{1,50}$/.test(channelName)) {
      return res.status(400).json({ error: "Invalid channelName" });
    }

    if (
      !Number.isSafeInteger(numericUid) ||
      numericUid <= 0 ||
      numericUid > 0xffffffff
    ) {
      return res.status(400).json({ error: "Invalid uid" });
    }

    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs =
      currentTimestamp + RTC_TOKEN_EXPIRES_IN_SECONDS;
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      numericUid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );

    return res.json({
      appId,
      token,
      channelName,
      uid: numericUid,
      expiresIn: RTC_TOKEN_EXPIRES_IN_SECONDS
    });
  } catch (error) {
    console.error("Agora token generation failed:", error);
    return res.status(500).json({ error: "Token generation failed" });
  }
}

// This endpoint is public so web and mobile clients can obtain a short-lived
// Agora token before joining a channel.
router.get("/rtc-token", createRtcToken);

export default router;

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

let warnedAboutMissingConfig = false;

function getFirebaseApp() {
  const projectId = String(process.env.FIREBASE_PROJECT_ID || "").trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || "")
    .replace(/\\n/g, "\n")
    .trim();

  if (!projectId || !clientEmail || !privateKey) {
    if (!warnedAboutMissingConfig) {
      console.warn(
        "FCM disabled: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY are required"
      );
      warnedAboutMissingConfig = true;
    }
    return null;
  }

  return (
    getApps()[0] ||
    initializeApp({
      credential: cert({ projectId, clientEmail, privateKey })
    })
  );
}

function stringifyData(data = {}) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, String(value ?? "")])
  );
}

export async function sendPushNotification({
  token,
  title,
  body,
  data = {},
  androidChannelId
}) {
  const fcmToken = String(token || "").trim();
  if (!fcmToken) return null;

  const app = getFirebaseApp();
  if (!app) return null;

  return getMessaging(app).send({
    token: fcmToken,
    notification: {
      title: String(title || ""),
      body: String(body || "")
    },
    data: stringifyData(data),
    android: {
      priority: "high",
      notification: {
        channelId: String(androidChannelId || "default"),
        sound: "default",
        clickAction: "FLUTTER_NOTIFICATION_CLICK"
      }
    }
  });
}

export function sendIncomingCallPush({
  fcmToken,
  callerName,
  callerId,
  receiverId,
  callId,
  channelName,
  isVideoCall
}) {
  const videoCall = Boolean(isVideoCall);
  return sendPushNotification({
    token: fcmToken,
    title: videoCall ? "Incoming video call" : "Incoming voice call",
    body: `${callerName || "Zee Talk user"} is calling you`,
    data: {
      type: "incoming_call",
      callerId,
      callerName,
      receiverId,
      callId,
      channelName,
      isVideoCall: videoCall
    },
    androidChannelId: "calls"
  });
}

export function sendMessagePush({
  fcmToken,
  senderName,
  senderId,
  receiverId,
  chatId,
  message
}) {
  return sendPushNotification({
    token: fcmToken,
    title: senderName || "Zee Talk",
    body: message || "New message",
    data: {
      type: "chat_message",
      senderId,
      receiverId,
      chatId,
      message
    },
    androidChannelId: "messages"
  });
}

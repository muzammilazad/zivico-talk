import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

let warnedAboutMissingConfig = false;
let firebaseInitialized = false;

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

  const existingApp = getApps()[0];
  if (existingApp) {
    if (!firebaseInitialized) {
      console.log("Firebase Admin initialized");
      firebaseInitialized = true;
    }
    return existingApp;
  }

  const app = initializeApp({
    credential: cert({ projectId, clientEmail, privateKey })
  });
  console.log("Firebase Admin initialized");
  firebaseInitialized = true;
  return app;
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

  try {
    const response = await getMessaging(app).send({
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

    console.log("push sent", {
      tokenPrefix: `${fcmToken.slice(0, 12)}...`,
      title: String(title || ""),
      body: String(body || ""),
      androidChannelId: String(androidChannelId || "default")
    });
    return response;
  } catch (error) {
    console.error("push failed", {
      tokenPrefix: `${fcmToken.slice(0, 12)}...`,
      title: String(title || ""),
      body: String(body || ""),
      androidChannelId: String(androidChannelId || "default"),
      error: error.message
    });
    throw error;
  }
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
  const data = {
    type: String("incoming_call"),
    callerId: String(callerId ?? ""),
    callerName: String(callerName ?? ""),
    receiverId: String(receiverId ?? ""),
    callId: String(callId ?? ""),
    channelName: String(channelName ?? ""),
    isVideoCall: String(videoCall)
  };
  console.log("FCM call payload data", data);

  return sendPushNotification({
    token: fcmToken,
    title: videoCall ? "Incoming video call" : "Incoming voice call",
    body: `${callerName || "Zee Talk user"} is calling you`,
    data,
    androidChannelId: "calls"
  });
}

export function sendMessagePush({
  fcmToken,
  senderName,
  senderId,
  receiverId,
  chatId,
  messageId,
  message
}) {
  const data = {
    type: String("chat_message"),
    chatId: String(chatId ?? ""),
    senderId: String(senderId ?? ""),
    receiverId: String(receiverId ?? ""),
    senderName: String(senderName ?? ""),
    messageId: String(messageId ?? ""),
    message: String(message ?? "")
  };
  console.log("FCM chat payload data", data);

  return sendPushNotification({
    token: fcmToken,
    title: senderName || "Zee Talk",
    body: message || "New message",
    data,
    androidChannelId: "messages"
  });
}

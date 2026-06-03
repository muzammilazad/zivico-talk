const CACHE_NAME = "zivico-talk-pwa-v1";
const APP_SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((cached) => cached || caches.match("/")))
  );
});

function normalizeIncomingCallPayload(data = {}) {
  const call = data.call || data;
  const fromUser = call.fromUser || {
    id: call.from || call.callerId || "",
    name: call.callerName || "Zivico user",
    email: call.callerEmail || ""
  };

  return {
    from: call.from || call.callerId || fromUser.id,
    fromUser,
    callType: call.callType || "voice"
  };
}

async function showIncomingCallNotification(call) {
  const callerName = call.fromUser?.name || "Zivico user";
  await self.registration.showNotification("Incoming call", {
    body: callerName,
    tag: `incoming-call-${call.from || "unknown"}`,
    renotify: true,
    requireInteraction: true,
    data: {
      type: "incoming-call",
      call
    }
  });
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {
    data = { callerName: event.data?.text() || "Zivico user" };
  }

  const call = normalizeIncomingCallPayload(data);

  // Web Push can wake the service worker to show a notification, but browsers do
  // not allow a PWA to play an unlimited background ringtone like WhatsApp.
  // True WhatsApp-like background ringing requires native Android/iOS push
  // notification and call-notification APIs such as CallStyle/CallKit.
  event.waitUntil(showIncomingCallNotification(call));
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "show-incoming-call-notification") return;

  const call = normalizeIncomingCallPayload(event.data.call);
  event.waitUntil(showIncomingCallNotification(call));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const call = event.notification.data?.call || null;
  const url = call ? `/?incomingCall=${encodeURIComponent(JSON.stringify(call))}` : "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clientList) => {
      const existingClient = clientList.find((client) => "focus" in client);
      if (existingClient) {
        await existingClient.focus();
        existingClient.postMessage({ type: "incoming-call-notification-click", call });
        return;
      }

      if (self.clients.openWindow) {
        const newClient = await self.clients.openWindow(url);
        if (newClient && call) {
          setTimeout(() => {
            newClient.postMessage({ type: "incoming-call-notification-click", call });
          }, 600);
        }
      }
    })
  );
});

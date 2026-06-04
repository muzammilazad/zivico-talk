const turnUrl = import.meta.env.VITE_TURN_URL || "";
const turnUsername = import.meta.env.VITE_TURN_USERNAME || "";
const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL || "";

console.log("webrtc TURN URL loaded", turnUrl || "not configured");

export const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

if (turnUrl && turnUsername && turnCredential) {
  ICE_SERVERS.push({
    urls: turnUrl,
    username: turnUsername,
    credential: turnCredential
  });
} else {
  console.warn("webrtc TURN credentials incomplete; cross-network calls may fail");
}

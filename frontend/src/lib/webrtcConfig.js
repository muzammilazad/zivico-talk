const turnUrl = import.meta.env.VITE_TURN_URL || "";
const turnUsername = import.meta.env.VITE_TURN_USERNAME || "";
const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL || "";

console.log("webrtc TURN URL loaded", turnUrl || "not configured");
export const TURN_URL = turnUrl;

export const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: turnUrl,
    username: turnUsername,
    credential: turnCredential
  }
].filter((server) => server.urls);

export const ICE_CONFIG = {
  iceServers: ICE_SERVERS,
  iceCandidatePoolSize: 10
};

if (!turnUrl || !turnUsername || !turnCredential) {
  console.warn("webrtc TURN credentials incomplete; cross-network calls may fail");
}

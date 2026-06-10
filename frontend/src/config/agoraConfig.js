const DEFAULT_AGORA_APP_ID = "a84361a1dca0421dafc488d41619a153";
const DEFAULT_API_BASE_URL = "https://zivico-talk-production.up.railway.app";

export const AGORA_APP_ID = (
  import.meta.env.VITE_AGORA_APP_ID || DEFAULT_AGORA_APP_ID
).trim();

export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ||
  import.meta.env.VITE_API_URL ||
  DEFAULT_API_BASE_URL
)
  .trim()
  .replace(/\/+$/, "");

export function hasValidAgoraAppId() {
  return (
    AGORA_APP_ID.length >= 30 &&
    !AGORA_APP_ID.toLowerCase().includes("paste") &&
    /^[a-fA-F0-9]+$/.test(AGORA_APP_ID)
  );
}

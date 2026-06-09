const PLACEHOLDER_AGORA_APP_ID = "PASTE_AGORA_APP_ID_HERE";

export const AGORA_APP_ID = (
  import.meta.env.VITE_AGORA_APP_ID || PLACEHOLDER_AGORA_APP_ID
).trim();

export function hasValidAgoraAppId() {
  return Boolean(AGORA_APP_ID) && AGORA_APP_ID !== PLACEHOLDER_AGORA_APP_ID;
}

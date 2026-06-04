const PLACEHOLDER_BACKEND_URL = "https://REPLACE_WITH_LIVE_BACKEND_URL";

function normalizeUrl(value) {
  return (value || "").trim().replace(/\/+$/, "");
}

function isMissingBackendUrl(value) {
  return !value || value === PLACEHOLDER_BACKEND_URL;
}

export const API_BASE_URL = normalizeUrl(import.meta.env.VITE_API_URL);
export const SOCKET_URL = normalizeUrl(import.meta.env.VITE_SOCKET_URL);

export function assertApiBaseUrl() {
  if (isMissingBackendUrl(API_BASE_URL)) {
    throw new Error(
      "VITE_API_URL must be set to your live backend URL."
    );
  }
}

export function assertSocketUrl() {
  if (isMissingBackendUrl(SOCKET_URL)) {
    throw new Error(
      "VITE_SOCKET_URL must be set to your live backend URL."
    );
  }
}

export function logFrontendConfig() {
  console.info("API URL:", API_BASE_URL || "(missing)");
  console.info("Socket URL:", SOCKET_URL || "(missing)");

  if (isMissingBackendUrl(API_BASE_URL) || isMissingBackendUrl(SOCKET_URL)) {
    console.warn(
      "[Config] APK builds cannot use local URLs. Set VITE_API_URL and VITE_SOCKET_URL to your live backend URL."
    );
  }
}

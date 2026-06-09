function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

export function sanitizeAgoraChannelName(input) {
  const sanitized = String(input || "").replace(/[^A-Za-z0-9]/g, "");
  if (!sanitized) return `zt${Date.now()}`;
  return sanitized.length > 50 ? sanitized.substring(0, 50) : sanitized;
}

export function buildAgoraChannelName(currentUserId, remoteUserId) {
  const timestamp = Date.now();
  const a = Math.abs(hashString(String(currentUserId))) % 999999;
  const b = Math.abs(hashString(String(remoteUserId))) % 999999;
  return sanitizeAgoraChannelName(`zt${a}${b}${timestamp}`);
}

export function isValidAgoraChannelName(channelName) {
  return /^[A-Za-z0-9]{1,50}$/.test(channelName || "");
}

export function agoraUidFromUserId(userId) {
  // Keep web UIDs outside the mobile app's 1..1,000,000 range.
  return (Math.abs(hashString(String(userId))) % 1000000) + 1000001;
}

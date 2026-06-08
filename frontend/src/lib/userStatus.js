function formatTime(date) {
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

export function formatLastSeen(lastSeenAt, now = new Date()) {
  if (!lastSeenAt) return "offline";

  const lastSeen = new Date(lastSeenAt);
  if (Number.isNaN(lastSeen.getTime())) return "offline";

  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const lastSeenDay = Date.UTC(lastSeen.getFullYear(), lastSeen.getMonth(), lastSeen.getDate());
  const dayDifference = Math.round((today - lastSeenDay) / 86400000);
  const time = formatTime(lastSeen);

  if (dayDifference === 0) return `last seen ${time}`;
  if (dayDifference === 1) return `last seen yesterday ${time}`;

  const day = String(lastSeen.getDate()).padStart(2, "0");
  const month = lastSeen.toLocaleDateString([], { month: "short" });
  return `last seen ${day} ${month}, ${time}`;
}

export function userStatus({ isTyping = false, isOnline = false, lastSeenAt } = {}) {
  if (isTyping) return "typing...";
  if (isOnline) return "online";
  return formatLastSeen(lastSeenAt);
}

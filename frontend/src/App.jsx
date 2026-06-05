import { useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import {
  Bell,
  BellRing,
  Camera,
  CheckCircle2,
  FileText,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Phone,
  Search,
  Settings,
  Shield,
  UserCircle,
  Users
} from "lucide-react";
import AuthPanel from "./components/AuthPanel";
import ChatWindow from "./components/ChatWindow";
import UserList from "./components/UserList";
import VideoCallModal from "./components/VideoCallModal";
import { api } from "./lib/api";
import { API_BASE_URL, SOCKET_URL } from "./lib/config";
import { createSocket } from "./lib/socket";
import { ICE_CONFIG, ICE_SERVERS, TURN_URL } from "./lib/webrtcConfig";

const emptySession = { token: "", user: null };
// Camera video is limited to 720p / 24fps for mobile stability and lower TURN usage.
const CAMERA_VIDEO_CONSTRAINTS = {
  width: { max: 1280 },
  height: { max: 720 },
  frameRate: { max: 24 }
};
// Screen share is limited to 720p / 10fps to reduce TURN bandwidth usage.
const SCREEN_SHARE_VIDEO_CONSTRAINTS = {
  width: { max: 1280 },
  height: { max: 720 },
  frameRate: { max: 10 }
};
const INCOMING_RINGTONE_PATH = "/sounds/incoming-ringtone.wav";
const OUTGOING_RINGBACK_PATH = "/sounds/outgoing-ringback.wav";
const CALL_AUDIO_UNLOCKED_KEY = "zivico-call-audio-unlocked";
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || "";
const SCREEN_SHARE_UNSUPPORTED_MESSAGE = "Screen sharing is not supported on this mobile app yet.";
const WEBRTC_DEBUG_ENABLED = import.meta.env.VITE_WEBRTC_DEBUG !== "false";

function isAndroidApp() {
  return Capacitor.getPlatform?.() === "android";
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = `${base64String}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let index = 0; index < rawData.length; index += 1) {
    outputArray[index] = rawData.charCodeAt(index);
  }

  return outputArray;
}

function normalizeIncomingCallPayload(payload = {}) {
  const fromUser = payload.fromUser || {
    id: payload.from || payload.callerId || "",
    name: payload.callerName || "Zivico user",
    email: payload.callerEmail || ""
  };

  return {
    from: payload.from || payload.callerId || fromUser.id,
    fromUser,
    callType: payload.callType || "voice"
  };
}

function readIncomingCallFromUrl() {
  try {
    const url = new URL(window.location.href);
    const rawCall = url.searchParams.get("incomingCall");
    if (!rawCall) return null;

    url.searchParams.delete("incomingCall");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    return normalizeIncomingCallPayload(JSON.parse(rawCall));
  } catch {
    return null;
  }
}

function isAppForegrounded() {
  return document.visibilityState === "visible" && document.hasFocus();
}

function loadSavedSession() {
  try {
    const saved = localStorage.getItem("zivico-session");
    if (!saved) return emptySession;

    const session = JSON.parse(saved);
    if (!session?.token || !session?.user) return emptySession;

    return session;
  } catch {
    localStorage.removeItem("zivico-session");
    return emptySession;
  }
}

function getMessageText(message) {
  return message.text || message.message || "";
}

function getMessageCreatedAt(message) {
  return message.createdAt || message.timestamp || new Date().toISOString();
}

function normalizeMessage(message) {
  if (message.type === "call_event") {
    return message;
  }

  return {
    ...message,
    reactions: message.reactions || [],
    type: message.type || "message",
    text: getMessageText(message),
    createdAt: getMessageCreatedAt(message),
    status: message.status || "delivered"
  };
}

function getPreviewText(item) {
  if (!item) return "";
  if (item.type === "call_event") {
    const names = { voice: "Voice call", video: "Video call", screen: "Screen share" };
    const label = names[item.callType] || "Call";
    const statuses = {
      missed: `Missed ${label.toLowerCase()}`,
      declined: `Declined ${label.toLowerCase()}`,
      ended: `${label} ended`,
      started: `${label} started`
    };
    return statuses[item.status] || label;
  }
  if (item.type === "voice") return "Voice note";
  if (item.type === "image") return item.text || "Photo";
  if (item.type === "file") return item.mediaName || "File";
  return item.text || item.message || item.mediaName || "";
}

function mediaSrc(url) {
  if (!url) return "";
  return url.startsWith("http") ? url : `${API_BASE_URL}${url}`;
}

function currentUserAvatar(user) {
  if (user.avatarUrl) {
    return <img className="topbar-avatar image-avatar" src={mediaSrc(user.avatarUrl)} alt={user.name} />;
  }
  return <span className="topbar-avatar">{user.name.slice(0, 1).toUpperCase()}</span>;
}

function normalizeRole(role) {
  return role || "client";
}

function conversationStateFromSummaries(summaries) {
  return summaries.reduce(
    (state, summary) => {
      const peerId = String(summary.peerId);
      state.unreadCounts[peerId] = summary.unreadCount || 0;
      if (summary.latest) {
        state.latestMessages[peerId] = getPreviewText(summary.latest);
      }
      return state;
    },
    { unreadCounts: {}, latestMessages: {} }
  );
}

function mergeMessageById(currentMessages, nextMessage) {
  const message = normalizeMessage(nextMessage);
  const exists = currentMessages.some((item) => String(item.id) === String(message.id));

  if (!exists) return [...currentMessages, message];

  return currentMessages.map((item) => (String(item.id) === String(message.id) ? { ...item, ...message } : item));
}

function applyReactionToMessages(currentMessages, reaction, action) {
  if (!reaction?.messageId) return currentMessages;

  return currentMessages.map((message) => {
    if (String(message.id) !== String(reaction.messageId)) return message;

    const reactions = message.reactions || [];
    if (action === "removed") {
      return {
        ...message,
        reactions: reactions.filter((item) => String(item.userId) !== String(reaction.userId))
      };
    }

    const exists = reactions.some((item) => String(item.userId) === String(reaction.userId));
    return {
      ...message,
      reactions: exists
        ? reactions.map((item) => (String(item.userId) === String(reaction.userId) ? { ...item, ...reaction } : item))
        : [...reactions, reaction]
    };
  });
}

function activityLabel(item) {
  if (item.type === "call_event") return getPreviewText(item);
  if (item.isForwarded) return "Forwarded message";
  return getPreviewText(item) || "New message";
}

function StatCard({ label, value, icon: Icon }) {
  return (
    <article className="stat-card">
      <span className="stat-icon">{Icon ? <Icon size={20} /> : null}</span>
      <div>
        <strong>{value}</strong>
        <small>{label}</small>
      </div>
    </article>
  );
}

function DashboardView({ metrics, contacts, unreadTotal, missedCalls, todayCalls }) {
  const data = metrics || {};
  const cards = [
    ["Total Contacts", data.totalContacts ?? contacts.length, Users],
    ["Unread Messages", data.unreadMessages ?? unreadTotal, MessageSquare],
    ["Missed Calls", data.missedCalls ?? missedCalls, Phone],
    ["Today's Calls", data.todaysCalls ?? todayCalls, Phone],
    ["Pending Requests", data.pendingRequests ?? 0, Bell],
    ["Recent Activity", data.recentActivity?.length ?? 0, FileText]
  ];

  return (
    <section className="dashboard-view">
      <div className="welcome-panel">
        <div>
          <span className="eyebrow">Welcome back</span>
          <h1>Zee Talk</h1>
          <p>Client-ready communication with private chats, calls, media sharing, and operational visibility.</p>
        </div>
        <span className="hero-mark">ZT</span>
      </div>
      <div className="stats-grid">
        {cards.map(([label, value, icon]) => (
          <StatCard key={label} label={label} value={value} icon={icon} />
        ))}
      </div>
      <section className="activity-panel">
        <header>
          <h2>Recent Activity</h2>
        </header>
        <div className="activity-list">
          {(data.recentActivity || []).length === 0 && <p className="empty-copy">No recent activity yet.</p>}
          {(data.recentActivity || []).map((item) => (
            <article key={`${item.type || "message"}-${item.id}`} className="activity-item">
              <span className="activity-dot" />
              <div>
                <strong>{activityLabel(item)}</strong>
                <small>{new Date(item.createdAt).toLocaleString()}</small>
              </div>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}

function NotificationsPanel({ notifications, onRead, onClear }) {
  const unread = notifications.filter((item) => !item.isRead).length;
  return (
    <section className="notifications-panel">
      <header>
        <div>
          <h2>Notifications</h2>
          <small>{unread} unread</small>
        </div>
        <button type="button" onClick={onClear}>
          Clear all
        </button>
      </header>
      <div>
        {notifications.length === 0 && <p className="empty-copy">No notifications yet.</p>}
        {notifications.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`notification-item ${item.isRead ? "" : "unread"}`}
            onClick={() => onRead(item.id)}
          >
            <strong>{item.title}</strong>
            <small>{item.body || new Date(item.createdAt).toLocaleString()}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function CallsView({ calls, filter, onFilter, currentUser, onCallBack }) {
  const filters = ["All", "Missed", "Voice", "Video", "Screen Share"];
  const visibleCalls = calls.filter((call) => {
    if (filter === "All") return true;
    if (filter === "Missed") return call.status === "missed";
    if (filter === "Screen Share") return call.callType === "screen";
    return call.callType === filter.toLowerCase();
  });

  return (
    <section className="page-view">
      <header className="page-header">
        <div>
          <span className="eyebrow">Call history</span>
          <h1>Calls</h1>
        </div>
        <div className="filter-tabs">
          {filters.map((item) => (
            <button key={item} type="button" className={filter === item ? "active" : ""} onClick={() => onFilter(item)}>
              {item}
            </button>
          ))}
        </div>
      </header>
      <div className="table-list">
        {visibleCalls.length === 0 && <p className="empty-copy">No calls match this filter.</p>}
        {visibleCalls.map((call) => {
          const peer = String(call.callerId) === String(currentUser.id) ? call.receiver : call.caller;
          return (
            <article key={call.id} className={`call-row ${call.status === "missed" ? "missed" : ""}`}>
              <span className="avatar">{peer?.name?.slice(0, 1).toUpperCase() || "Z"}</span>
              <div>
                <strong>{peer?.name || "Zivico user"}</strong>
                <small>{call.callType} - {call.status} - {call.durationSeconds || 0}s</small>
              </div>
              <small>{new Date(call.createdAt).toLocaleString()}</small>
              <button type="button" onClick={() => peer && onCallBack(peer, call.callType)}>
                <Phone size={16} />
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function SimpleTablePage({ title, eyebrow, children }) {
  return (
    <section className="page-view">
      <header className="page-header">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
        </div>
      </header>
      <div className="table-list">{children}</div>
    </section>
  );
}

function ChatStartView({ role }) {
  return (
    <section className="page-view">
      <header className="page-header">
        <div>
          <span className="eyebrow">{role === "support" ? "Client conversations" : "Chats"}</span>
          <h1>Select a chat</h1>
        </div>
      </header>
      <p className="empty-copy">Choose a conversation from the sidebar.</p>
    </section>
  );
}

function getRelationshipStatus(user) {
  if (user.relationshipStatus) return user.relationshipStatus;
  if (user.requestStatus === "accepted") return "accepted";
  if (user.requestStatus === "pending") return "pending_sent";
  if (user.requestStatus === "rejected") return "rejected";
  return "none";
}

export default function App() {
  const [session, setSession] = useState(loadSavedSession);
  const [contacts, setContacts] = useState([]);
  const [contactRequests, setContactRequests] = useState([]);
  const [showAddContact, setShowAddContact] = useState(false);
  const [showRequests, setShowRequests] = useState(false);
  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState([]);
  const [contactSearchMessage, setContactSearchMessage] = useState("");
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [activeView, setActiveView] = useState("chats");
  const [dashboardMetrics, setDashboardMetrics] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [calls, setCalls] = useState([]);
  const [callFilter, setCallFilter] = useState("All");
  const [adminMetrics, setAdminMetrics] = useState(null);
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminCalls, setAdminCalls] = useState([]);
  const [adminMessageStats, setAdminMessageStats] = useState(null);
  const [adminMediaFiles, setAdminMediaFiles] = useState([]);
  const [profileForm, setProfileForm] = useState({ name: "", phone: "", about: "" });
  const [settingsForm, setSettingsForm] = useState({});
  const [toast, setToast] = useState("");
  const [onlineIds, setOnlineIds] = useState(new Set());
  const [selectedUser, setSelectedUser] = useState(null);
  const [messages, setMessages] = useState([]);
  const [unreadCounts, setUnreadCounts] = useState({});
  const [latestMessages, setLatestMessages] = useState({});
  const [messageText, setMessageText] = useState("");
  const [typingPeer, setTypingPeer] = useState(null);
  const [replyToMessage, setReplyToMessage] = useState(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [call, setCall] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);
  const [remoteStream, setRemoteStream] = useState(null);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const [webrtcLogs, setWebrtcLogs] = useState([]);
  const [showWebrtcDebug, setShowWebrtcDebug] = useState(WEBRTC_DEBUG_ENABLED);
  const [notificationPermission, setNotificationPermission] = useState(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission
  );

  const socketRef = useRef(null);
  const selectedUserRef = useRef(null);
  const callRef = useRef(null);
  const incomingCallRef = useRef(null);
  const callStartedAtRef = useRef(null);
  const stoppingCallRef = useRef(false);
  const pcRef = useRef(null);
  const processedSocketMessagesRef = useRef(new Set());
  const avatarInputRef = useRef(null);
  const localStreamRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const remoteStreamRef = useRef(new MediaStream());
  const pendingIceCandidatesRef = useRef([]);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const incomingRingtoneRef = useRef(null);
  const outgoingRingbackRef = useRef(null);
  const audioUnlockedRef = useRef(audioUnlocked);
  const serviceWorkerRegistrationRef = useRef(null);

  const currentUser = session.user;

  function addWebRtcLog(message, data) {
    const timestamp = new Date().toLocaleTimeString();
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp,
      message,
      data
    };
    console.log(message, data ?? "");
    setWebrtcLogs((current) => [...current.slice(-79), entry]);
  }

  function getIncomingRingtone() {
    if (!incomingRingtoneRef.current) {
      incomingRingtoneRef.current = new Audio(INCOMING_RINGTONE_PATH);
      incomingRingtoneRef.current.loop = true;
      incomingRingtoneRef.current.preload = "auto";
    }
    return incomingRingtoneRef.current;
  }

  function getOutgoingRingback() {
    if (!outgoingRingbackRef.current) {
      outgoingRingbackRef.current = new Audio(OUTGOING_RINGBACK_PATH);
      outgoingRingbackRef.current.loop = true;
      outgoingRingbackRef.current.preload = "auto";
    }
    return outgoingRingbackRef.current;
  }

  function resetAudio(audio) {
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
  }

  function stopIncomingRingtone() {
    if (incomingRingtoneRef.current) {
      console.log("Stopping incoming ringtone");
    }
    resetAudio(incomingRingtoneRef.current);
  }

  function stopOutgoingRingback() {
    console.log("Stopping outgoing ringback");
    resetAudio(outgoingRingbackRef.current);
  }

  function playIncomingRingtone() {
    if (!audioUnlockedRef.current) return;
    stopOutgoingRingback();
    const audio = getIncomingRingtone();
    try {
      console.log("Playing incoming ringtone");
      audio.currentTime = 0;
      const playPromise = audio.play();
      if (playPromise?.catch) {
        playPromise.catch((err) => {
          console.error("audio.play() error if blocked", err);
        });
      }
    } catch (err) {
      console.error("audio.play() error if blocked", err);
      // Browser autoplay policies can block call sounds until the user interacts.
    }
  }

  function playOutgoingRingback() {
    stopIncomingRingtone();
    const audio = getOutgoingRingback();
    try {
      console.log("Playing outgoing ringback");
      audio.currentTime = 0;
      const playPromise = audio.play();
      if (playPromise?.catch) {
        playPromise.catch((err) => {
          console.error("audio.play() error if blocked", err);
        });
      }
    } catch (err) {
      console.error("audio.play() error if blocked", err);
      // Browser autoplay policies can block call sounds until the user interacts.
    }
  }

  async function unlockCallAudio() {
    const incomingAudio = getIncomingRingtone();
    const outgoingAudio = getOutgoingRingback();
    const audioItems = [
      incomingAudio,
      outgoingAudio,
      remoteAudioRef.current?.srcObject ? remoteAudioRef.current : null
    ].filter(Boolean);
    const previousSettings = audioItems.map((audio) => ({
      audio,
      muted: audio.muted,
      volume: audio.volume
    }));

    try {
      audioItems.forEach((audio) => {
        audio.muted = true;
        audio.volume = 0.01;
        audio.currentTime = 0;
      });

      await Promise.all(audioItems.map((audio) => audio.play()));

      audioItems.forEach((audio) => {
        audio.pause();
        audio.currentTime = 0;
      });
      previousSettings.forEach(({ audio, muted, volume }) => {
        audio.muted = muted;
        audio.volume = volume;
      });

      setAudioUnlocked(true);
      audioUnlockedRef.current = true;
      try {
        localStorage.setItem(CALL_AUDIO_UNLOCKED_KEY, "true");
      } catch {
        // Audio unlock is still valid for this page even if storage is unavailable.
      }
      console.log("Call audio unlocked");
      if (incomingCallRef.current && !callRef.current) {
        playIncomingRingtone();
      }
      return true;
    } catch (err) {
      audioItems.forEach((audio) => {
        audio.pause();
        audio.currentTime = 0;
      });
      previousSettings.forEach(({ audio, muted, volume }) => {
        audio.muted = muted;
        audio.volume = volume;
      });
      setAudioUnlocked(false);
      audioUnlockedRef.current = false;
      try {
        localStorage.removeItem(CALL_AUDIO_UNLOCKED_KEY);
      } catch {
        // Ignore storage errors while reporting the actual audio unlock failure.
      }
      console.error("Call audio unlock failed", err);
      return false;
    }
  }

  useEffect(() => {
    audioUnlockedRef.current = audioUnlocked;
  }, [audioUnlocked]);

  useEffect(() => {
    if (!WEBRTC_DEBUG_ENABLED) return;
    addWebRtcLog("ZEE_WEBRTC_NEW_CODE_RUNNING", { platform: Capacitor.getPlatform?.() || "web" });
    addWebRtcLog("API URL", API_BASE_URL || "(missing)");
    addWebRtcLog("Socket URL", SOCKET_URL || "(missing)");
    addWebRtcLog("TURN URL loaded", TURN_URL || "not configured");
  }, []);

  async function registerPushSubscription(registration) {
    if (!registration?.pushManager || !session.token) return;

    try {
      const key =
        VAPID_PUBLIC_KEY ||
        (await api("/api/push/vapid-public-key", {}, session.token)
          .then((data) => data.publicKey)
          .catch(() => ""));
      if (!key) return;

      const existingSubscription = await registration.pushManager.getSubscription();
      const subscription =
        existingSubscription ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key)
        }));

      await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription }) }, session.token);
    } catch (err) {
      console.warn("Push subscription unavailable", err);
    }
  }

  async function setupCallNotifications() {
    if (!("serviceWorker" in navigator)) return;

    try {
      const registration = await navigator.serviceWorker.register("/sw.js");
      serviceWorkerRegistrationRef.current = registration;

      if ("Notification" in window) {
        const permission =
          Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
        setNotificationPermission(permission);
        if (permission === "granted") {
          await registerPushSubscription(registration);
        }
      }
    } catch (err) {
      console.warn("Service worker registration failed", err);
    }
  }

  async function showIncomingCallNotification(callPayload) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;

    const call = normalizeIncomingCallPayload(callPayload);

    try {
      const registration = serviceWorkerRegistrationRef.current || (await navigator.serviceWorker?.ready);
      if (registration?.active) {
        registration.active.postMessage({ type: "show-incoming-call-notification", call });
        return;
      }
      if (registration?.showNotification) {
        await registration.showNotification("Incoming call", {
          body: call.fromUser?.name || "Zivico user",
          tag: `incoming-call-${call.from || "unknown"}`,
          renotify: true,
          requireInteraction: true,
          data: { type: "incoming-call", call }
        });
        return;
      }

      const notification = new Notification("Incoming call", {
        body: call.fromUser?.name || "Zivico user"
      });
      notification.onclick = () => {
        window.focus();
        setIncomingCall(call);
      };
    } catch (err) {
      console.warn("Incoming call notification failed", err);
    }
  }

  function showIncomingCall(callPayload, { shouldRing = isAppForegrounded() } = {}) {
    const nextIncomingCall = normalizeIncomingCallPayload(callPayload);
    setIncomingCall(nextIncomingCall);
    setActiveView("chats");

    if (shouldRing) {
      playIncomingRingtone();
    } else {
      // PWAs can show a background notification, but browsers do not allow true
      // WhatsApp-style continuous background ringing from web code. Production
      // Android/iOS apps need native push plus call notification APIs for that.
      showIncomingCallNotification(nextIncomingCall);
    }
  }

  useEffect(() => {
    if (!currentUser) return;

    setupCallNotifications();

    const pendingCall = readIncomingCallFromUrl();
    if (pendingCall) {
      showIncomingCall(pendingCall, { shouldRing: false });
    }
  }, [currentUser?.id]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    function handleServiceWorkerMessage(event) {
      if (event.data?.type !== "incoming-call-notification-click" || !event.data.call) return;
      showIncomingCall(event.data.call, { shouldRing: false });
    }

    navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", handleServiceWorkerMessage);
    };
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    setProfileForm({
      name: currentUser.name || "",
      phone: currentUser.phone || "",
      about: currentUser.about || ""
    });
    setSettingsForm({
      notifyMessages: currentUser.notifyMessages !== false,
      notifyCalls: currentUser.notifyCalls !== false,
      notifyContacts: currentUser.notifyContacts !== false,
      showOnline: currentUser.showOnline !== false,
      showLastSeen: currentUser.showLastSeen !== false,
      readReceipts: currentUser.readReceipts !== false
    });
  }, [currentUser?.id]);

  useEffect(() => {
    selectedUserRef.current = selectedUser;
    setReplyToMessage(null);
  }, [selectedUser]);

  useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);

  useEffect(() => {
    callRef.current = call;

    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }

    if (remoteVideoRef.current && remoteStreamRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
    }
  }, [call]);

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  useEffect(() => {
    if (session.token) {
      localStorage.setItem("zivico-session", JSON.stringify(session));
    } else {
      localStorage.removeItem("zivico-session");
    }
  }, [session]);

  useEffect(() => {
    if (!session.token) return;

    refreshContacts();
    refreshContactRequests();
    refreshConversationSummaries();
    const role = normalizeRole(session.user?.role);
    if (role === "support" || role === "admin" || role === "manager") {
      refreshNotifications();
      refreshCalls();
    }
    if (role === "admin" || role === "manager") {
      refreshDashboard();
      refreshAdminData();
    }

    const socket = createSocket(session.token);
    socketRef.current = socket;

    function handleConnect() {
      console.log("socket connected", socket.id);
    }

    function handlePresence(onlineUsers) {
      setOnlineIds(new Set(onlineUsers.map((user) => user.id)));
    }

    function handleIncomingMessage(message) {
      console.log("received message", message);
      const normalizedMessage = normalizeMessage(message);
      if (processedSocketMessagesRef.current.has(String(normalizedMessage.id))) return;
      processedSocketMessagesRef.current.add(String(normalizedMessage.id));
      const peer = selectedUserRef.current;
      const currentUserId = String(session.user.id);
      const senderId = String(normalizedMessage.senderId);
      const receiverId = String(normalizedMessage.receiverId);
      const peerId = senderId === currentUserId ? receiverId : senderId;
      const selectedPeerId = peer ? String(peer.id) : "";

      const belongsToOpenChat =
        peer &&
        ((senderId === currentUserId && receiverId === selectedPeerId) ||
          (senderId === selectedPeerId && receiverId === currentUserId));

      setLatestMessages((current) => ({
        ...current,
        [peerId]: getPreviewText(normalizedMessage)
      }));

      if (senderId === currentUserId && normalizedMessage.status === "delivered") {
        console.log("message delivered", normalizedMessage.id);
      }

      if (belongsToOpenChat) {
        addMessageIfNotExists(normalizedMessage);
        if (senderId !== currentUserId) {
          markMessagesRead(peerId, [normalizedMessage]);
          setUnreadCounts((current) => ({
            ...current,
            [peerId]: 0
          }));
        }
      } else if (senderId !== currentUserId) {
        setUnreadCounts((current) => ({
          ...current,
          [peerId]: (current[peerId] || 0) + 1
        }));
      }
    }

    socket.on("private-message", handleIncomingMessage);
    socket.on("receive-message", handleIncomingMessage);

    function handleMessageStatusUpdated(message) {
      console.log("status updated", message);
      addMessageIfNotExists(message);
    }

    function handleMessageUpdated(message) {
      addMessageIfNotExists(message);
      refreshConversationSummaries();
    }

    function handleMessageDeleted(message) {
      addMessageIfNotExists(message);
      refreshConversationSummaries();
    }

    function handleNotificationCreated(notification) {
      setNotifications((current) => [notification, ...current.filter((item) => String(item.id) !== String(notification.id))]);
      setToast(notification.title);
      setTimeout(() => setToast(""), 2200);
    }

    function handleTyping({ from, name, isTyping }) {
      setTypingPeer(isTyping ? { id: from, name } : null);
    }

    function handleMessagesRead({ messageIds = [] }) {
      console.log("message read", messageIds);
      setMessages((current) =>
        current.map((message) =>
          messageIds.some((messageId) => String(messageId) === String(message.id)) ? { ...message, status: "read" } : message
        )
      );
    }

    function handleMessageReaction({ reaction, action }) {
      setMessages((current) => applyReactionToMessages(current, reaction, action));
    }

    function handleMessageReactionAdded(payload) {
      handleMessageReaction({ ...payload, action: "added" });
    }

    function handleMessageReactionUpdated(payload) {
      handleMessageReaction({ ...payload, action: "updated" });
    }

    function handleMessageReactionRemoved(payload) {
      handleMessageReaction({ ...payload, action: "removed" });
    }

    function handleContactRequestReceived(request) {
      console.log("contact request received", request);
      setContactRequests((current) =>
        current.some((item) => String(item.id) === String(request.id)) ? current : [request, ...current]
      );
    }

    function handleContactRequestAccepted() {
      refreshContacts();
      refreshContactRequests();
    }

    function handleContactRequestRejected() {
      refreshContactRequests();
    }

    function handleCallEventCreated(event) {
      console.log("call event received", event);
      const peer = selectedUserRef.current;
      const currentUserId = String(session.user.id);
      const peerId = String(event.callerId) === currentUserId ? String(event.receiverId) : String(event.callerId);
      setLatestMessages((current) => ({ ...current, [peerId]: getPreviewText(event) }));
      if (peer && String(peer.id) === peerId) {
        setMessages((current) =>
          current.some((item) => String(item.id) === String(event.id)) ? current : [...current, event]
        );
      }
    }

    function handleCallUser({ from, fromUser, callType }) {
      console.log("Incoming call received");
      console.log("incoming call type received", callType);
      showIncomingCall({ from, fromUser, callType });
    }

    async function handleCallAccepted({ from, callType }) {
      const activeCall = callRef.current;
      if (!activeCall || String(activeCall.peer.id) !== String(from) || !pcRef.current) return;

      stopOutgoingRingback();
      setCall({ ...activeCall, status: "connected" });
      const offer = await pcRef.current.createOffer();
      addWebRtcLog("Offer created", { callType });
      await pcRef.current.setLocalDescription(offer);
      console.log("webrtc signaling state after local offer", pcRef.current.signalingState);
      addWebRtcLog("Offer sent", { to: from, callType });
      socket.emit("offer", { to: from, callerId: currentUser.id, receiverId: from, offer, callType });
    }

    async function handleOffer({ from, callerId, receiverId, offer, callType }) {
      addWebRtcLog("Offer received", { from, callerId, receiverId, callType });
      let activeCall = callRef.current;
      if (!pcRef.current) {
        const fromUser = contacts.find((user) => String(user.id) === String(from)) || { id: from, name: "Caller", email: "" };
        await prepareLocalMedia(callType, { receivingScreen: callType === "screen" });
        createPeerConnection(from, callType);
        activeCall = { peer: fromUser, type: callType, status: "connected", isCaller: false };
        setCall(activeCall);
      }

      await pcRef.current.setRemoteDescription(new RTCSessionDescription(offer));
      addWebRtcLog("Remote description set", { type: "offer", signalingState: pcRef.current.signalingState });
      console.log("webrtc remote offer set", pcRef.current.signalingState);
      await flushPendingIceCandidates();
      const answer = await pcRef.current.createAnswer();
      addWebRtcLog("Answer created", { callType });
      await pcRef.current.setLocalDescription(answer);
      console.log("webrtc signaling state after local answer", pcRef.current.signalingState);
      addWebRtcLog("Answer sent", { to: from, callType });
      socket.emit("answer", { to: from, callerId: from, receiverId: currentUser.id, answer, callType });
    }

    async function handleAnswer({ from, callerId, receiverId, answer, callType }) {
      addWebRtcLog("Answer received", { from, callerId, receiverId, callType });
      if (pcRef.current) {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(answer));
        addWebRtcLog("Remote description set", { type: "answer", signalingState: pcRef.current.signalingState });
        console.log("webrtc remote answer set", pcRef.current.signalingState);
        await flushPendingIceCandidates();
      }
    }

    async function handleIceCandidate({ from, callerId, receiverId, candidate, callType }) {
      addWebRtcLog("ICE candidate received", { from, callerId, receiverId, callType });
      addWebRtcLog("Received ICE candidate", { from, callerId, receiverId, callType });
      console.log("webrtc ice candidate received", candidate?.candidate || candidate?.type || "candidate");
      await addOrQueueIceCandidate(candidate);
    }

    function handleEndCall({ from, callType, callStatus }) {
      const pendingIncoming = incomingCallRef.current;
      if (pendingIncoming && String(pendingIncoming.from) === String(from) && !callStatus) {
        saveCallEvent({
          callType: callType || pendingIncoming.callType || "voice",
          status: "missed",
          callerId: from,
          receiverId: currentUser.id
        });
      }
      endCallLocally();
    }

    function handleCallRejected({ from }) {
      const activeCall = callRef.current;
      if (!activeCall || String(activeCall.peer.id) !== String(from)) return;
      endCallLocally();
    }

    socket.on("connect", handleConnect);
    socket.on("presence", handlePresence);
    socket.on("message-status-updated", handleMessageStatusUpdated);
    socket.on("message-updated", handleMessageUpdated);
    socket.on("message-deleted", handleMessageDeleted);
    socket.on("notification-created", handleNotificationCreated);
    socket.on("typing", handleTyping);
    socket.on("message-read", handleMessagesRead);
    socket.on("messages-read", handleMessagesRead);
    socket.on("message-reaction-added", handleMessageReactionAdded);
    socket.on("message-reaction-updated", handleMessageReactionUpdated);
    socket.on("message-reaction-removed", handleMessageReactionRemoved);
    socket.on("contact-request-received", handleContactRequestReceived);
    socket.on("contact-request-accepted", handleContactRequestAccepted);
    socket.on("contact-request-rejected", handleContactRequestRejected);
    socket.on("call-event-created", handleCallEventCreated);
    socket.on("call-user", handleCallUser);
    socket.on("call-accepted", handleCallAccepted);
    socket.on("offer", handleOffer);
    socket.on("answer", handleAnswer);
    socket.on("ice-candidate", handleIceCandidate);
    socket.on("call-rejected", handleCallRejected);
    socket.on("end-call", handleEndCall);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("presence", handlePresence);
      socket.off("private-message", handleIncomingMessage);
      socket.off("receive-message", handleIncomingMessage);
      socket.off("message-status-updated", handleMessageStatusUpdated);
      socket.off("message-updated", handleMessageUpdated);
      socket.off("message-deleted", handleMessageDeleted);
      socket.off("notification-created", handleNotificationCreated);
      socket.off("typing", handleTyping);
      socket.off("message-read", handleMessagesRead);
      socket.off("messages-read", handleMessagesRead);
      socket.off("message-reaction-added", handleMessageReactionAdded);
      socket.off("message-reaction-updated", handleMessageReactionUpdated);
      socket.off("message-reaction-removed", handleMessageReactionRemoved);
      socket.off("contact-request-received", handleContactRequestReceived);
      socket.off("contact-request-accepted", handleContactRequestAccepted);
      socket.off("contact-request-rejected", handleContactRequestRejected);
      socket.off("call-event-created", handleCallEventCreated);
      socket.off("call-user", handleCallUser);
      socket.off("call-accepted", handleCallAccepted);
      socket.off("offer", handleOffer);
      socket.off("answer", handleAnswer);
      socket.off("ice-candidate", handleIceCandidate);
      socket.off("call-rejected", handleCallRejected);
      socket.off("end-call", handleEndCall);
      socket.disconnect();
      endCallLocally();
    };
  }, [session.token]);

  useEffect(() => {
    if (!selectedUser || !session.token) return;
    api(`/api/conversations/${selectedUser.id}/timeline`, {}, session.token)
      .then((timeline) => {
        const normalizedTimeline = timeline.map(normalizeMessage);
        setMessages(normalizedTimeline);
        markMessagesRead(selectedUser.id, normalizedTimeline);
        const latestItem = normalizedTimeline.at(-1);
        if (latestItem) {
          setLatestMessages((current) => ({
            ...current,
            [String(selectedUser.id)]: getPreviewText(latestItem)
          }));
        }
      })
      .catch(console.error);
  }, [selectedUser, session.token]);

  const sortedUsers = useMemo(
    () => {
      const query = sidebarSearch.trim().toLowerCase();
      return [...contacts]
        .filter(
          (contact) =>
            !query ||
            contact.name?.toLowerCase().includes(query) ||
            contact.email?.toLowerCase().includes(query) ||
            String(contact.phone || "").toLowerCase().includes(query)
        )
        .sort(
          (a, b) =>
            Number(b.isOfficialSupport || b.role === "support") - Number(a.isOfficialSupport || a.role === "support") ||
            Number(unreadCounts[String(b.id)] || 0) - Number(unreadCounts[String(a.id)] || 0) ||
            Number(onlineIds.has(b.id)) - Number(onlineIds.has(a.id)) ||
            a.name.localeCompare(b.name)
        );
    },
    [contacts, onlineIds, sidebarSearch, unreadCounts]
  );

  function handleAuth(nextSession) {
    setSession(nextSession);
  }

  function refreshContacts() {
    if (!session.token) return;
    api("/api/contacts", {}, session.token).then(setContacts).catch(console.error);
  }

  function refreshContactRequests() {
    if (!session.token) return;
    api("/api/contact-requests", {}, session.token).then(setContactRequests).catch(console.error);
  }

  function refreshConversationSummaries() {
    if (!session.token) return;
    api("/api/conversations/summary", {}, session.token)
      .then((summaries) => {
        const nextState = conversationStateFromSummaries(summaries);
        setUnreadCounts(nextState.unreadCounts);
        setLatestMessages(nextState.latestMessages);
      })
      .catch(console.error);
  }

  function refreshDashboard() {
    if (!session.token) return;
    api("/api/dashboard", {}, session.token).then(setDashboardMetrics).catch(console.error);
  }

  function refreshNotifications() {
    if (!session.token) return;
    api("/api/notifications", {}, session.token).then(setNotifications).catch(console.error);
  }

  function refreshCalls() {
    if (!session.token) return;
    api("/api/call-events", {}, session.token).then(setCalls).catch(console.error);
  }

  function refreshAdminData() {
    if (!session.token) return;
    Promise.all([
      api("/api/admin/metrics", {}, session.token),
      api("/api/admin/users", {}, session.token),
      api("/api/admin/call-logs", {}, session.token),
      api("/api/admin/message-stats", {}, session.token),
      api("/api/admin/media-files", {}, session.token)
    ])
      .then(([metrics, users, callLogs, messageStats, mediaFiles]) => {
        setAdminMetrics(metrics);
        setAdminUsers(users);
        setAdminCalls(callLogs);
        setAdminMessageStats(messageStats);
        setAdminMediaFiles(mediaFiles);
      })
      .catch(console.error);
  }

  function addMessageIfNotExists(message) {
    setMessages((current) => mergeMessageById(current, message));
  }

  function selectUser(user) {
    setSelectedUser(user);
    setUnreadCounts((current) => ({
      ...current,
      [String(user.id)]: 0
    }));
  }

  function openContactChat(user) {
    const contact = contacts.find((item) => String(item.id) === String(user.id)) || user;
    selectUser(contact);
    setActiveView("chats");
    setShowAddContact(false);
  }

  function logout() {
    endCall();
    setSession(emptySession);
    setContacts([]);
    setContactRequests([]);
    setSelectedUser(null);
    setMessages([]);
    setUnreadCounts({});
    setLatestMessages({});
    setReplyToMessage(null);
    setDashboardMetrics(null);
    setNotifications([]);
    setCalls([]);
    setActiveView("chats");
  }

  function markMessagesRead(peerId, chatMessages = messages) {
    if (!socketRef.current || !session.user) return;

    const currentUserId = String(session.user.id);
    const selectedPeerId = String(peerId);
    const unreadMessageIds = chatMessages
      .filter(
        (message) =>
          String(message.senderId) === selectedPeerId &&
          String(message.receiverId) === currentUserId &&
          message.status !== "read"
      )
      .map((message) => message.id)
      .filter(Boolean);

    if (unreadMessageIds.length === 0) return;

    console.log("message read", unreadMessageIds);
    socketRef.current.emit("message-read", { peerId, messageIds: unreadMessageIds });
    setUnreadCounts((current) => ({
      ...current,
      [String(peerId)]: 0
    }));
    setMessages((current) =>
      current.map((message) =>
        unreadMessageIds.some((messageId) => String(messageId) === String(message.id))
          ? { ...message, status: "read" }
          : message
      )
    );
  }

  async function searchContacts(event) {
    event.preventDefault();
    const query = contactQuery.trim();
    if (!query) return;

    setContactSearchMessage("");
    const results = await api(`/api/users/search?q=${encodeURIComponent(query)}`, {}, session.token);
    setContactResults(results);
    if (results.length === 0) {
      setContactSearchMessage("No user found.");
    }
  }

  async function sendContactRequest(receiverId) {
    try {
      const request = await api(
        "/api/contact-requests",
        { method: "POST", body: JSON.stringify({ receiverId }) },
        session.token
      );
      setContactSearchMessage("Request pending");
      setContactResults((current) =>
        current.map((user) =>
          String(user.id) === String(receiverId)
            ? { ...user, relationshipStatus: "pending_sent", requestStatus: "pending", contactRequestId: request.id }
            : user
        )
      );
      console.log("contact-request-sent", request);
    } catch (err) {
      setContactSearchMessage(err.message);
    }
  }

  async function respondToContactRequest(requestId, action) {
    const result = await api(`/api/contact-requests/${requestId}/${action}`, { method: "POST" }, session.token);
    setContactRequests((current) => current.filter((request) => String(request.id) !== String(requestId)));
    setContactResults((current) =>
      current.map((user) =>
        String(user.contactRequestId) === String(requestId)
          ? {
              ...user,
              relationshipStatus: action === "accept" ? "accepted" : "rejected",
              requestStatus: action === "accept" ? "accepted" : "rejected",
              contactRequestId: null
            }
          : user
      )
    );
    refreshContacts();
    console.log(`contact-request-${action}`, result);
  }

  async function saveCallEvent(event) {
    if (!session.token) return null;
    try {
      return await api("/api/call-events", { method: "POST", body: JSON.stringify(event) }, session.token);
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  function sendMessage(event) {
    event.preventDefault();
    const text = messageText.trim();
    if (!text || !selectedUser || !socketRef.current) return;

    const clientId = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `client-${Date.now()}`;
    const optimisticMessage = {
      id: clientId,
      clientId,
      senderId: currentUser.id,
      receiverId: selectedUser.id,
      text,
      replyToMessageId: replyToMessage?.id || null,
      replyToMessage: replyToMessage || null,
      createdAt: new Date().toISOString(),
      status: "sent"
    };

    console.log("message sent", optimisticMessage);
    addMessageIfNotExists(optimisticMessage);
    setLatestMessages((current) => ({
      ...current,
      [String(selectedUser.id)]: text
    }));
    socketRef.current.emit("send-message", {
      receiverId: selectedUser.id,
      text,
      clientId,
      replyToMessageId: replyToMessage?.id || null
    });
    setMessageText("");
    socketRef.current.emit("typing", { to: selectedUser.id, isTyping: false });
    setReplyToMessage(null);
  }

  function updateMessageDraft(value) {
    setMessageText(value);
    if (selectedUser && socketRef.current) {
      socketRef.current.emit("typing", { to: selectedUser.id, isTyping: Boolean(value.trim()) });
    }
  }

  async function uploadMedia(file, purpose) {
    const form = new FormData();
    form.append("file", file);
    if (purpose) form.append("purpose", purpose);
    return api("/api/uploads", { method: "POST", body: form }, session.token);
  }

  async function uploadAvatar(file) {
    if (!file) return;
    try {
      setAvatarUploading(true);
      const media = await uploadMedia(file, "avatar");
      setSession((current) => ({
        ...current,
        user: { ...current.user, avatarUrl: media.url }
      }));
    } catch (err) {
      alert(err.message || "Could not update profile image");
    } finally {
      setAvatarUploading(false);
    }
  }

  async function sendMediaMessage(file, explicitType, options = {}) {
    if (!file || !selectedUser || !socketRef.current) return;

    try {
      const media = await uploadMedia(file);
      const type = explicitType || (file.type.startsWith("image/") ? "image" : "file");
      const clientId = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `client-${Date.now()}`;
      const optimisticMessage = {
        id: clientId,
        clientId,
        senderId: currentUser.id,
        receiverId: selectedUser.id,
        type,
        text: "",
        mediaUrl: media.url,
        mediaName: media.fileName,
        mediaMimeType: media.mimeType,
        mediaDurationSeconds: options.mediaDurationSeconds || null,
        replyToMessageId: replyToMessage?.id || null,
        replyToMessage: replyToMessage || null,
        createdAt: new Date().toISOString(),
        status: "sent"
      };

      addMessageIfNotExists(optimisticMessage);
      setLatestMessages((current) => ({
        ...current,
        [String(selectedUser.id)]: getPreviewText(optimisticMessage)
      }));
      socketRef.current.emit("send-message", {
        receiverId: selectedUser.id,
        type,
        text: "",
        mediaUrl: media.url,
        mediaName: media.fileName,
        mediaMimeType: media.mimeType,
        mediaDurationSeconds: options.mediaDurationSeconds || null,
        replyToMessageId: replyToMessage?.id || null,
        clientId
      });
      setReplyToMessage(null);
    } catch (err) {
      throw err;
    }
  }

  async function forwardMessage(message, receiverIds) {
    if (!message?.id || receiverIds.length === 0) return;

    const forwardedMessages = await api(
      `/api/messages/${message.id}/forward`,
      { method: "POST", body: JSON.stringify({ receiverIds }) },
      session.token
    );

    forwardedMessages.forEach((forwardedMessage) => {
      const peerId =
        String(forwardedMessage.senderId) === String(currentUser.id)
          ? String(forwardedMessage.receiverId)
          : String(forwardedMessage.senderId);
      setLatestMessages((current) => ({
        ...current,
        [peerId]: getPreviewText(forwardedMessage)
      }));
      if (selectedUser && String(selectedUser.id) === peerId) {
        addMessageIfNotExists(forwardedMessage);
      }
    });
  }

  async function reactToMessage(message, emoji) {
    if (!message?.id || !session.token) return;

    const currentReaction = (message.reactions || []).find((reaction) => String(reaction.userId) === String(currentUser.id));
    const optimisticReaction = {
      id: currentReaction?.id || `reaction-${message.id}-${currentUser.id}`,
      messageId: message.id,
      userId: currentUser.id,
      emoji,
      createdAt: currentReaction?.createdAt || new Date().toISOString()
    };
    const optimisticAction = currentReaction?.emoji === emoji ? "removed" : currentReaction ? "updated" : "added";

    setMessages((current) => applyReactionToMessages(current, optimisticReaction, optimisticAction));

    try {
      if (currentReaction?.emoji === emoji) {
        await api(`/api/messages/${message.id}/reactions`, { method: "DELETE" }, session.token);
      } else {
        await api(
          `/api/messages/${message.id}/reactions`,
          { method: "POST", body: JSON.stringify({ emoji }) },
          session.token
        );
      }
    } catch (err) {
      console.error(err);
      setMessages((current) => applyReactionToMessages(current, optimisticReaction, currentReaction ? "updated" : "removed"));
    }
  }

  async function editMessage(message, text) {
    const updated = await api(
      `/api/messages/${message.id}`,
      { method: "PATCH", body: JSON.stringify({ text }) },
      session.token
    );
    addMessageIfNotExists(updated);
  }

  async function deleteMessage(message, scope) {
    const result = await api(`/api/messages/${message.id}?scope=${scope}`, { method: "DELETE" }, session.token);
    if (result.scope === "me") {
      setMessages((current) => current.filter((item) => String(item.id) !== String(message.id)));
    } else {
      addMessageIfNotExists(result.message);
    }
  }

  async function getCallStream(type, options = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera and microphone are not available in this WebView.");
    }

    async function requestUserMedia(constraints, label) {
      try {
        if (isAndroidApp()) {
          addWebRtcLog("Requesting camera/microphone permission", { label, constraints });
        }
        addWebRtcLog("Requesting camera/microphone permission", { label, constraints });
        console.log("webrtc getUserMedia requested", { label, constraints });
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        addWebRtcLog("getUserMedia success", {
          label,
          tracks: stream.getTracks().map((track) => `${track.kind}:${track.readyState}`)
        });
        if (label === "audio call") {
          addWebRtcLog("Audio call getUserMedia success");
        }
        console.log(
          "webrtc getUserMedia success",
          label,
          stream.getTracks().map((track) => `${track.kind}:${track.readyState}`)
        );
        return stream;
      } catch (err) {
        addWebRtcLog("getUserMedia failed", { label, name: err?.name, message: err?.message });
        if (label === "audio call") {
          addWebRtcLog("Audio call getUserMedia failed", { name: err?.name, message: err?.message });
        }
        console.error("webrtc getUserMedia failure", label, err);
        if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
          throw new Error("Camera or microphone permission was denied. Please allow Camera and Microphone permissions in Android app settings and try again.");
        }
        if (err?.name === "NotFoundError" || err?.name === "DevicesNotFoundError") {
          throw new Error("Camera or microphone was not found on this device.");
        }
        throw err;
      }
    }

    if (type === "screen" && options.receivingScreen) {
      console.log("webrtc requesting receiver mic permission for screen call");
      return requestUserMedia({ audio: true, video: false }, "screen receiver microphone").catch(() => new MediaStream());
    }

    if (type === "screen") {
      if (!navigator.mediaDevices.getDisplayMedia) {
        console.warn("webrtc getDisplayMedia unsupported");
        throw new Error(SCREEN_SHARE_UNSUPPORTED_MESSAGE);
      }
      console.log("webrtc requesting display media");
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: SCREEN_SHARE_VIDEO_CONSTRAINTS,
        audio: false
      });
      const micStream = await requestUserMedia({ audio: true, video: false }, "screen share microphone").catch(() => null);
      const tracks = [...displayStream.getVideoTracks()];
      if (micStream) tracks.push(...micStream.getAudioTracks());
      return new MediaStream(tracks);
    }

    const constraints = {
      audio: true,
      video: type === "video"
    };
    if (type === "voice") {
      addWebRtcLog("Requesting audio media", constraints);
      addWebRtcLog("Requesting audio call media", constraints);
    } else if (type === "video") {
      addWebRtcLog("Requesting video media", constraints);
    }
    console.log("webrtc requesting camera/mic permission", { type, constraints });
    return requestUserMedia(constraints, type === "video" ? "video call" : "audio call");
  }

  async function prepareLocalMedia(type, options = {}) {
    const stream = await getCallStream(type, options);
    localStreamRef.current = stream;
    if (type !== "screen" || options.receivingScreen) {
      cameraStreamRef.current = stream;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }
    console.log(
      "webrtc local stream added",
      stream.getTracks().map((track) => `${track.kind}:${track.readyState}`)
    );
    addWebRtcLog("Local media stream ready", {
      type,
      tracks: stream.getTracks().map((track) => `${track.kind}:${track.readyState}`)
    });
    if (type === "screen" && !options.receivingScreen) {
      stream.getVideoTracks().forEach((track) => {
        track.onended = () => {
          if (stoppingCallRef.current) return;
          endCall();
        };
      });
    }
    setMuted(false);
    setCameraOff(type === "voice");
    setScreenSharing(type === "screen" && !options.receivingScreen);
    return stream;
  }

  function attachRemoteStream() {
    const stream = remoteStreamRef.current;
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = stream;
      remoteVideoRef.current.muted = true;
      remoteVideoRef.current.play?.().catch((err) => {
        console.warn("webrtc remote video autoplay blocked", err);
      });
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = stream;
      remoteAudioRef.current.muted = false;
      remoteAudioRef.current.play?.().catch((err) => {
        console.warn("webrtc remote audio autoplay blocked; user gesture required", err);
        setAudioUnlocked(false);
        audioUnlockedRef.current = false;
      });
    }
    setRemoteStream(stream);
    addWebRtcLog(
      "Remote stream attached",
      stream.getTracks().map((track) => `${track.kind}:${track.readyState}`)
    );
  }

  async function logSelectedIceCandidatePair(pc) {
    if (!pc?.getStats) return;
    try {
      const stats = await pc.getStats();
      let selectedPair = null;
      stats.forEach((report) => {
        if (report.type === "candidate-pair" && (report.selected || report.nominated) && report.state === "succeeded") {
          selectedPair = report;
        }
      });
      if (!selectedPair) return;

      const localCandidate = stats.get(selectedPair.localCandidateId);
      const remoteCandidate = stats.get(selectedPair.remoteCandidateId);
      addWebRtcLog("Selected ICE candidate pair", {
        local: localCandidate
          ? {
              type: localCandidate.candidateType,
              protocol: localCandidate.protocol,
              address: localCandidate.address || localCandidate.ip,
              port: localCandidate.port
            }
          : null,
        remote: remoteCandidate
          ? {
              type: remoteCandidate.candidateType,
              protocol: remoteCandidate.protocol,
              address: remoteCandidate.address || remoteCandidate.ip,
              port: remoteCandidate.port
            }
          : null
      });
    } catch (err) {
      console.warn("webrtc selected ICE candidate pair unavailable", err);
    }
  }

  async function addOrQueueIceCandidate(candidate) {
    if (!candidate || !pcRef.current) return;

    if (!pcRef.current.remoteDescription) {
      pendingIceCandidatesRef.current.push(candidate);
      addWebRtcLog("ICE candidate queued", pendingIceCandidatesRef.current.length);
      addWebRtcLog("Queued ICE candidate", pendingIceCandidatesRef.current.length);
      console.log("webrtc ice candidate queued", pendingIceCandidatesRef.current.length);
      return;
    }

    await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
    addWebRtcLog("ICE candidate added");
    addWebRtcLog("Added ICE candidate");
    console.log("webrtc ice candidate added");
  }

  async function flushPendingIceCandidates() {
    if (!pcRef.current?.remoteDescription || pendingIceCandidatesRef.current.length === 0) return;

    const candidates = [...pendingIceCandidatesRef.current];
    pendingIceCandidatesRef.current = [];
    for (const candidate of candidates) {
      await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      addWebRtcLog("ICE candidate added");
      addWebRtcLog("Added ICE candidate");
      console.log("webrtc queued ice candidate added");
    }
  }

  function createPeerConnection(peerId, callType = "voice") {
    pcRef.current?.close();
    remoteStreamRef.current = new MediaStream();
    pendingIceCandidatesRef.current = [];
    setRemoteStream(remoteStreamRef.current);

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStreamRef.current;
      remoteAudioRef.current.muted = false;
    }

    addWebRtcLog("Creating peer connection", {
      peerId,
      callType,
      iceServers: ICE_SERVERS.map((server) => server.urls)
    });
    const pc = new RTCPeerConnection(ICE_CONFIG);
    console.log("webrtc peer connection created", { peerId, callType, iceServerCount: ICE_SERVERS.length });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        addWebRtcLog("ICE candidate generated", event.candidate.candidate);
        addWebRtcLog("Sending ICE candidate", { to: peerId, callType: callRef.current?.type || callType });
        addWebRtcLog("ICE candidate sent", { to: peerId, callType: callRef.current?.type || callType });
        socketRef.current?.emit("ice-candidate", {
          to: peerId,
          callerId: currentUser.id,
          receiverId: peerId,
          candidate: event.candidate.toJSON(),
          callType: callRef.current?.type || callType
        });
      }
    };

    pc.ontrack = (event) => {
      addWebRtcLog("Remote track received", {
        kind: event.track.kind,
        id: event.track.id,
        readyState: event.track.readyState
      });
      console.log("webrtc remote track received", event.track.kind, event.streams?.[0]?.id);
      if (event.track.kind === "audio") {
        addWebRtcLog("Remote audio track received");
      }
      if (!remoteStreamRef.current.getTracks().some((track) => track.id === event.track.id)) {
        remoteStreamRef.current.addTrack(event.track);
      }
      console.log(
        "webrtc remote stream tracks",
        remoteStreamRef.current.getTracks().map((track) => `${track.kind}:${track.readyState}`)
      );
      attachRemoteStream();
    };

    pc.onicegatheringstatechange = () => {
      addWebRtcLog("ICE gathering state", pc.iceGatheringState);
    };
    pc.oniceconnectionstatechange = () => {
      addWebRtcLog("ICE connection state", pc.iceConnectionState);
      if (["connected", "completed"].includes(pc.iceConnectionState)) {
        logSelectedIceCandidatePair(pc);
      }
      if (["failed", "disconnected", "closed"].includes(pc.iceConnectionState)) {
        console.warn("webrtc ICE connection state warning", pc.iceConnectionState);
        if (!stoppingCallRef.current) {
          addWebRtcLog("Call error", `ICE connection state: ${pc.iceConnectionState}`);
          setToast("Call connection failed. TURN server may be required.");
          setTimeout(() => setToast(""), 4000);
        }
      }
    };
    pc.onconnectionstatechange = () => {
      addWebRtcLog("Peer connection state", pc.connectionState);
      if (["connected"].includes(pc.connectionState)) {
        logSelectedIceCandidatePair(pc);
      }
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        console.warn("webrtc connection state warning", pc.connectionState);
        if (!stoppingCallRef.current) {
          addWebRtcLog("Call error", `Peer connection state: ${pc.connectionState}`);
          setToast("Call connection failed. TURN server may be required.");
          setTimeout(() => setToast(""), 4000);
        }
        stopIncomingRingtone();
        stopOutgoingRingback();
      }
    };
    pc.onsignalingstatechange = () => {
      addWebRtcLog("Signaling state", pc.signalingState);
    };

    const localTracks = localStreamRef.current?.getTracks() || [];
    localTracks.forEach((track) => {
      pc.addTrack(track, localStreamRef.current);
      console.log("webrtc local track added", track.kind, track.readyState);
    });
    addWebRtcLog("Local tracks added", localTracks.map((track) => `${track.kind}:${track.readyState}`));
    if (!localStreamRef.current?.getVideoTracks().length) {
      pc.addTransceiver("video", { direction: "sendrecv" });
      console.log("webrtc video transceiver added for future screen/camera track");
    }
    pcRef.current = pc;
    return pc;
  }

  async function startCall(type) {
    if (!selectedUser || !socketRef.current) return;

    try {
      addWebRtcLog("Call type selected", { type, peerId: selectedUser.id });
      if (!audioUnlockedRef.current) {
        await unlockCallAudio();
      }
      playOutgoingRingback();
      await prepareLocalMedia(type);
      createPeerConnection(selectedUser.id, type);
      setCall({ peer: selectedUser, type, status: "ringing", isCaller: true });
      callStartedAtRef.current = Date.now();
      console.log("call type sent", type);
      socketRef.current.emit("call-user", {
        to: selectedUser.id,
        callerId: currentUser.id,
        receiverId: selectedUser.id,
        callType: type
      });
    } catch (err) {
      addWebRtcLog("Call error", { action: "startCall", name: err?.name, message: err?.message });
      alert(err.message || "Could not start call");
      endCallLocally();
    }
  }

  async function acceptIncomingCall() {
    if (!incomingCall || !socketRef.current) return;

    try {
      stopIncomingRingtone();
      addWebRtcLog("Call type selected", { type: incomingCall.callType, peerId: incomingCall.from, incoming: true });
      await prepareLocalMedia(incomingCall.callType, { receivingScreen: incomingCall.callType === "screen" });
      createPeerConnection(incomingCall.from, incomingCall.callType);
      setCall({
        peer: incomingCall.fromUser,
        type: incomingCall.callType,
        status: "connected",
        isCaller: false
      });
      callStartedAtRef.current = Date.now();
      socketRef.current.emit("call-accepted", {
        to: incomingCall.from,
        callerId: incomingCall.from,
        receiverId: currentUser.id,
        callType: incomingCall.callType
      });
      setIncomingCall(null);
    } catch (err) {
      addWebRtcLog("Call error", { action: "acceptIncomingCall", name: err?.name, message: err?.message });
      alert(err.message || "Could not accept call");
      rejectIncomingCall();
    }
  }

  function rejectIncomingCall() {
    stopIncomingRingtone();
    if (incomingCall && socketRef.current) {
      saveCallEvent({
        callType: incomingCall.callType || "voice",
        status: "declined",
        callerId: incomingCall.from,
        receiverId: currentUser.id
      });
      socketRef.current.emit("end-call", {
        to: incomingCall.from,
        callerId: incomingCall.from,
        receiverId: currentUser.id,
        callType: incomingCall.callType || "voice",
        callStatus: "declined"
      });
      socketRef.current.emit("call-rejected", {
        to: incomingCall.from,
        callerId: incomingCall.from,
        receiverId: currentUser.id,
        callType: incomingCall.callType || "voice"
      });
    }
    setIncomingCall(null);
  }

  async function replaceOutgoingVideoTrack(track) {
    const videoTransceiver = pcRef.current?.getTransceivers().find((item) => item.sender?.track?.kind === "video" || item.receiver?.track?.kind === "video");
    const sender = videoTransceiver?.sender || pcRef.current?.getSenders().find((item) => item.track?.kind === "video");
    if (sender) {
      await sender.replaceTrack(track || null);
      console.log("webrtc screen track replaced", track?.kind || "none");
    } else if (track && pcRef.current && localStreamRef.current) {
      pcRef.current.addTrack(track, localStreamRef.current);
      console.log("webrtc screen track added", track.kind);
    }
  }

  async function restoreCameraAfterScreenShare() {
    const currentAudioTracks = localStreamRef.current?.getAudioTracks() || [];
    let cameraStream = cameraStreamRef.current || null;
    if (!cameraStream && callRef.current?.type !== "voice") {
      const constraints = { audio: false, video: CAMERA_VIDEO_CONSTRAINTS };
      try {
        console.log("webrtc getUserMedia requested", { label: "restore camera after screen share", constraints });
        cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
        console.log(
          "webrtc getUserMedia success",
          "restore camera after screen share",
          cameraStream.getTracks().map((track) => `${track.kind}:${track.readyState}`)
        );
      } catch (err) {
        console.error("webrtc getUserMedia failure", "restore camera after screen share", err);
        throw err;
      }
    }
    localStreamRef.current?.getVideoTracks().forEach((track) => {
      if (!cameraStream?.getVideoTracks().includes(track)) track.stop();
    });
    const cameraTrack = cameraStream?.getVideoTracks()[0] || null;
    await replaceOutgoingVideoTrack(cameraTrack);
    localStreamRef.current = new MediaStream([...(cameraTrack ? [cameraTrack] : []), ...currentAudioTracks]);
    if (cameraStream) cameraStreamRef.current = cameraStream;
    if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
    setScreenSharing(false);
    console.log("webrtc screen share restored camera track");
  }

  function toggleMute() {
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = muted;
    });
    setMuted((value) => !value);
  }

  function toggleCamera() {
    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = cameraOff;
    });
    setCameraOff((value) => !value);
  }

  async function toggleScreenShare() {
    if (screenSharing) {
      await restoreCameraAfterScreenShare();
      return;
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      console.warn("webrtc getDisplayMedia unsupported");
      alert(SCREEN_SHARE_UNSUPPORTED_MESSAGE);
      return;
    }

    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: SCREEN_SHARE_VIDEO_CONSTRAINTS,
        audio: false
      });
      const screenTrack = displayStream.getVideoTracks()[0];
      await replaceOutgoingVideoTrack(screenTrack);
      const audioTracks = localStreamRef.current?.getAudioTracks() || [];
      localStreamRef.current = new MediaStream([screenTrack, ...audioTracks]);
      if (localVideoRef.current) localVideoRef.current.srcObject = displayStream;
      screenTrack.onended = () => {
        if (stoppingCallRef.current) return;
        restoreCameraAfterScreenShare().catch(console.error);
      };
      setScreenSharing(true);
    } catch (err) {
      console.error("webrtc screen share failure", err);
      alert(err.message || "Could not start screen sharing");
    }
  }

  async function stopScreenShare() {
    await toggleScreenShare();
  }

  function endCallLocally() {
    stopIncomingRingtone();
    stopOutgoingRingback();
    stoppingCallRef.current = true;
    pcRef.current?.close();
    pcRef.current = null;
    pendingIceCandidatesRef.current = [];
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
    stoppingCallRef.current = false;
    localStreamRef.current = null;
    cameraStreamRef.current = null;
    remoteStreamRef.current = new MediaStream();
    setRemoteStream(null);
    callStartedAtRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setCall(null);
    setIncomingCall(null);
    setMuted(false);
    setCameraOff(false);
    setScreenSharing(false);
  }

  function endCall() {
    const peerId = call?.peer?.id || incomingCall?.from;
    if (peerId) {
      const callStatus = call?.status === "ringing" ? "missed" : call ? "ended" : "declined";
      if (call) {
        saveCallEvent({
          callType: call.type || "voice",
          status: callStatus,
          callerId: call.isCaller ? currentUser.id : call.peer.id,
          receiverId: call.isCaller ? peerId : currentUser.id,
          durationSeconds: callStartedAtRef.current ? Math.round((Date.now() - callStartedAtRef.current) / 1000) : 0
        });
      }
      socketRef.current?.emit("end-call", {
        to: peerId,
        callerId: call?.isCaller ? currentUser.id : peerId,
        receiverId: call?.isCaller ? peerId : currentUser.id,
        callType: call?.type || incomingCall?.callType || "voice",
        callStatus
      });
    }
    endCallLocally();
  }

  async function markNotificationRead(notificationId) {
    const next = await api(`/api/notifications/${notificationId}/read`, { method: "POST" }, session.token);
    setNotifications(next);
  }

  async function clearAllNotifications() {
    const next = await api("/api/notifications/clear", { method: "POST" }, session.token);
    setNotifications(next);
  }

  async function saveProfile(event) {
    event.preventDefault();
    const user = await api("/api/profile", { method: "PATCH", body: JSON.stringify(profileForm) }, session.token);
    setSession((current) => ({ ...current, user }));
    setToast("Profile updated");
    setTimeout(() => setToast(""), 2200);
  }

  async function saveSettings(event) {
    event.preventDefault();
    const user = await api("/api/profile/settings", { method: "PATCH", body: JSON.stringify(settingsForm) }, session.token);
    setSession((current) => ({ ...current, user }));
    setToast("Settings updated");
    setTimeout(() => setToast(""), 2200);
  }

  async function toggleBlockedUser(user) {
    const action = user.isBlocked ? "unblock" : "block";
    await api(`/api/admin/users/${user.id}/${action}`, { method: "POST" }, session.token);
    refreshAdminData();
  }

  function callBackUser(user, type = "voice") {
    setSelectedUser(user);
    setActiveView("chats");
    setToast(`Open ${user.name} to start a ${type} call`);
    setTimeout(() => setToast(""), 2200);
  }

  const unreadNotificationCount = notifications.filter((item) => !item.isRead).length;
  const unreadTotal = Object.values(unreadCounts).reduce((total, count) => total + Number(count || 0), 0);
  const missedCalls = calls.filter((item) => item.status === "missed" && String(item.receiverId) === String(currentUser?.id)).length;
  const todayKey = new Date().toDateString();
  const todayCalls = calls.filter((item) => new Date(item.createdAt).toDateString() === todayKey).length;
  const currentRole = normalizeRole(currentUser?.role);
  const isClient = currentRole === "client";
  const isSupport = currentRole === "support";
  const isAdmin = currentRole === "admin" || currentUser?.isAdmin;
  const isManager = currentRole === "manager";
  const canViewDashboard = isAdmin || isManager;
  const canViewCalls = isSupport || isAdmin || isManager;
  const canViewAdminTools = isAdmin || isManager;
  const canViewNotifications = !isClient;
  const showWorkspaceStats = !isClient;

  useEffect(() => {
    if (!currentUser) return;

    const allowedViews = new Set(["chats", "profile", "settings"]);
    if (canViewCalls) allowedViews.add("calls");
    if (canViewDashboard) allowedViews.add("dashboard");
    if (canViewAdminTools) allowedViews.add("admin");

    if (!allowedViews.has(activeView)) {
      setActiveView("chats");
    }

    if (isClient && ["/dashboard", "/admin", "/calls", "/reports", "/users"].includes(window.location.pathname)) {
      window.history.replaceState(null, "", "/chats");
      setActiveView("chats");
    }
  }, [activeView, canViewAdminTools, canViewCalls, canViewDashboard, currentUser, isClient]);

  if (!currentUser) {
    return <AuthPanel onAuth={handleAuth} />;
  }

  return (
    <main className={`app-shell premium-shell view-${activeView} ${selectedUser && activeView === "chats" ? "mobile-chat-open" : ""}`}>
      <header className="topbar">
        <input
          ref={avatarInputRef}
          hidden
          type="file"
          accept="image/*"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) uploadAvatar(file);
            event.target.value = "";
          }}
        />
        <div className="brand-top">
          <span className="brand-mark small">ZT</span>
          <span>
            <strong>Zee Talk</strong>
            <small>{currentUser.name}</small>
          </span>
        </div>
        {!audioUnlocked && (
          <div className="call-audio-banner">
            <span>Tap to enable audio</span>
            <button type="button" onClick={unlockCallAudio}>
              Tap to enable audio
            </button>
          </div>
        )}
        <span className="topbar-actions">
          {canViewNotifications && (
            <button className="icon-button" type="button" title="Notifications" onClick={() => setShowNotifications((value) => !value)}>
              {unreadNotificationCount > 0 ? <BellRing size={20} /> : <Bell size={20} />}
              {unreadNotificationCount > 0 && <span className="topbar-badge">{unreadNotificationCount}</span>}
            </button>
          )}
          <button className="icon-button" type="button" title="Settings" onClick={() => setActiveView("settings")}>
            <Settings size={20} />
          </button>
          <button
            className="profile-image-button"
            type="button"
            title="Update profile image"
            disabled={avatarUploading}
            onClick={() => avatarInputRef.current?.click()}
          >
            {currentUserAvatar(currentUser)}
            <Camera size={14} />
          </button>
          <button type="button" onClick={logout}>
            <LogOut size={16} />
          </button>
        </span>
        {canViewNotifications && showNotifications && (
          <NotificationsPanel notifications={notifications} onRead={markNotificationRead} onClear={clearAllNotifications} />
        )}
      </header>

      <div className="workspace">
        <nav className="rail-nav" aria-label="Main navigation">
          <button className={activeView === "chats" ? "active" : ""} type="button" title="Chats" onClick={() => setActiveView("chats")}>
            <MessageSquare size={20} />
          </button>
          {canViewDashboard && (
            <button className={activeView === "dashboard" ? "active" : ""} type="button" title="Dashboard" onClick={() => setActiveView("dashboard")}>
              <LayoutDashboard size={20} />
            </button>
          )}
          {canViewCalls && (
            <button className={activeView === "calls" ? "active" : ""} type="button" title="Calls" onClick={() => setActiveView("calls")}>
              <Phone size={20} />
            </button>
          )}
          <button className={activeView === "profile" ? "active" : ""} type="button" title="Profile" onClick={() => setActiveView("profile")}>
            <UserCircle size={20} />
          </button>
          {canViewAdminTools && (
            <button className={activeView === "admin" ? "active" : ""} type="button" title="Admin" onClick={() => setActiveView("admin")}>
              <Shield size={20} />
            </button>
          )}
        </nav>
        <UserList
          apiUrl={API_BASE_URL}
          users={sortedUsers}
          selectedUser={selectedUser}
          onlineIds={onlineIds}
          unreadCounts={unreadCounts}
          latestMessages={latestMessages}
          pendingRequestCount={contactRequests.length}
          searchValue={sidebarSearch}
          onAddContact={() => setShowAddContact(true)}
          onSearch={setSidebarSearch}
          onShowRequests={() => setShowRequests(true)}
          onSelect={selectUser}
        />
        {activeView === "chats" && selectedUser && (
          <ChatWindow
            currentUser={currentUser}
            selectedUser={selectedUser}
            messages={messages}
            messageText={messageText}
            contacts={contacts}
            replyToMessage={replyToMessage}
            isTyping={typingPeer && String(typingPeer.id) === String(selectedUser.id) ? typingPeer : null}
            onMessageText={updateMessageDraft}
            onSend={sendMessage}
            onSendMedia={sendMediaMessage}
            onReactToMessage={reactToMessage}
            onEditMessage={editMessage}
            onDeleteMessage={deleteMessage}
            onReplyToMessage={setReplyToMessage}
            onCancelReply={() => setReplyToMessage(null)}
            onForwardMessage={forwardMessage}
            onStartCall={startCall}
            onBack={() => setSelectedUser(null)}
            apiUrl={API_BASE_URL}
          />
        )}
        {activeView === "chats" && !selectedUser && (
          showWorkspaceStats ? (
            <DashboardView
              metrics={dashboardMetrics}
              contacts={contacts}
              unreadTotal={unreadTotal}
              missedCalls={missedCalls}
              todayCalls={todayCalls}
            />
          ) : (
            <ChatStartView role={currentRole} />
          )
        )}
        {activeView === "dashboard" && canViewDashboard && (
          <DashboardView
            metrics={dashboardMetrics}
            contacts={contacts}
            unreadTotal={unreadTotal}
            missedCalls={missedCalls}
            todayCalls={todayCalls}
          />
        )}
        {activeView === "calls" && canViewCalls && (
          <CallsView calls={calls} filter={callFilter} onFilter={setCallFilter} currentUser={currentUser} onCallBack={callBackUser} />
        )}
        {activeView === "profile" && (
          <SimpleTablePage title="Profile" eyebrow="Account">
            <form className="settings-form" onSubmit={saveProfile}>
              <label>Name<input value={profileForm.name} onChange={(event) => setProfileForm((current) => ({ ...current, name: event.target.value }))} /></label>
              <label>Phone<input value={profileForm.phone} onChange={(event) => setProfileForm((current) => ({ ...current, phone: event.target.value }))} /></label>
              <label>Status/About<input value={profileForm.about} onChange={(event) => setProfileForm((current) => ({ ...current, about: event.target.value }))} /></label>
              <label>Email<input value={currentUser.email} readOnly /></label>
              <button type="submit">Save Profile</button>
            </form>
          </SimpleTablePage>
        )}
        {activeView === "settings" && (
          <SimpleTablePage title="Settings" eyebrow="Preferences">
            <form className="settings-form" onSubmit={saveSettings}>
              {["notifyMessages", "notifyCalls", "notifyContacts", "showOnline", "showLastSeen", "readReceipts"].map((key) => (
                <label className="toggle-row" key={key}>
                  <span>{key.replace(/([A-Z])/g, " $1")}</span>
                  <input type="checkbox" checked={settingsForm[key] !== false} onChange={(event) => setSettingsForm((current) => ({ ...current, [key]: event.target.checked }))} />
                </label>
              ))}
              <button type="submit">Save Settings</button>
            </form>
          </SimpleTablePage>
        )}
        {activeView === "admin" && canViewAdminTools && (
          <SimpleTablePage title="Admin Dashboard" eyebrow="Operations">
            <div className="stats-grid compact">
              {[
                ["Total Users", adminMetrics?.totalUsers || 0, Users],
                ["Online Users", adminMetrics?.onlineUsers || 0, CheckCircle2],
                ["Messages", adminMetrics?.totalMessages || 0, MessageSquare],
                ["Calls", adminMetrics?.totalCalls || 0, Phone],
                ["Missed Calls", adminMetrics?.missedCalls || 0, Bell],
                ["Media Files", adminMetrics?.mediaFiles || 0, FileText],
                ["Pending Requests", adminMetrics?.pendingContactRequests || 0, Users]
              ].map(([label, value, icon]) => <StatCard key={label} label={label} value={value} icon={icon} />)}
            </div>
            <h2>Users</h2>
            {adminUsers.map((user) => (
              <article className="admin-row" key={user.id}>
                <div><strong>{user.name}</strong><small>{user.email}</small></div>
                <small>{user.role}</small>
                <button type="button" onClick={() => toggleBlockedUser(user)}>{user.isBlocked ? "Unblock" : "Block"}</button>
              </article>
            ))}
            <h2>Call Logs</h2>
            {adminCalls.slice(0, 8).map((callLog) => (
              <article className="admin-row" key={callLog.id}>
                <div><strong>{callLog.caller?.name} to {callLog.receiver?.name}</strong><small>{callLog.callType} - {callLog.status}</small></div>
                <small>{new Date(callLog.createdAt).toLocaleString()}</small>
              </article>
            ))}
            <h2>Message Stats</h2>
            <pre className="stats-json">{JSON.stringify(adminMessageStats || {}, null, 2)}</pre>
            <h2>Media Files</h2>
            {adminMediaFiles.slice(0, 8).map((file) => (
              <article className="admin-row" key={file.id}>
                <div><strong>{file.fileName}</strong><small>{file.uploader?.email}</small></div>
                <small>{file.mimeType}</small>
              </article>
            ))}
          </SimpleTablePage>
        )}
        {showWorkspaceStats && (
          <aside className="info-panel">
            <span className="eyebrow">Workspace</span>
            <strong>{selectedUser?.name || "No chat selected"}</strong>
            <small>{contacts.length} contacts - {unreadTotal} unread - {missedCalls} missed calls</small>
          </aside>
        )}
      </div>
      <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
        <button
          className={activeView === "chats" ? "active" : ""}
          type="button"
          onClick={() => {
            setActiveView("chats");
            setSelectedUser(null);
          }}
        >
          <MessageSquare size={20} />
          <span>Chats</span>
        </button>
        <button type="button" onClick={() => setShowAddContact(true)}>
          <Users size={20} />
          <span>Contacts</span>
        </button>
        <button type="button" onClick={() => setShowRequests(true)}>
          <Bell size={20} />
          <span>Requests</span>
          {contactRequests.length > 0 && <span className="mobile-nav-badge">{contactRequests.length}</span>}
        </button>
        <button className={activeView === "profile" ? "active" : ""} type="button" onClick={() => setActiveView("profile")}>
          <UserCircle size={20} />
          <span>Profile</span>
        </button>
        <button type="button" onClick={logout}>
          <LogOut size={20} />
          <span>Logout</span>
        </button>
      </nav>
      {toast && <div className="toast">{toast}</div>}
      {WEBRTC_DEBUG_ENABLED && showWebrtcDebug && (
        <section className="webrtc-debug-panel" aria-label="WebRTC debug panel">
          <header>
            <strong>WebRTC Debug</strong>
            <span>
              <button type="button" onClick={() => setWebrtcLogs([])}>Clear</button>
              <button type="button" onClick={() => setShowWebrtcDebug(false)}>Hide</button>
            </span>
          </header>
          <div className="webrtc-debug-log">
            {webrtcLogs.length === 0 ? (
              <small>No WebRTC logs yet.</small>
            ) : (
              webrtcLogs.map((entry) => (
                <article key={entry.id}>
                  <time>{entry.timestamp}</time>
                  <strong>{entry.message}</strong>
                  {entry.data !== undefined && (
                    <pre>{typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data, null, 2)}</pre>
                  )}
                </article>
              ))
            )}
          </div>
        </section>
      )}
      {WEBRTC_DEBUG_ENABLED && !showWebrtcDebug && (
        <button className="webrtc-debug-tab" type="button" onClick={() => setShowWebrtcDebug(true)}>
          WebRTC
        </button>
      )}
      <audio
        ref={remoteAudioRef}
        autoPlay
        playsInline
        controls={false}
        muted={false}
        onCanPlay={() => remoteAudioRef.current?.play?.().catch((err) => {
          console.warn("webrtc remote audio play blocked until user gesture", err);
          setAudioUnlocked(false);
          audioUnlockedRef.current = false;
        })}
      />

      <VideoCallModal
        call={call}
        incomingCall={incomingCall}
        localVideoRef={localVideoRef}
        remoteVideoRef={remoteVideoRef}
        muted={muted}
        cameraOff={cameraOff}
        screenSharing={screenSharing}
        onAccept={acceptIncomingCall}
        onReject={rejectIncomingCall}
        onToggleMute={toggleMute}
        onToggleCamera={toggleCamera}
        onToggleScreen={toggleScreenShare}
        onStopScreenShare={stopScreenShare}
        onEnd={endCall}
      />

      {showAddContact && (
        <div className="modal-backdrop">
          <section className="contact-modal">
            <header className="modal-header">
              <h2>Add Contact</h2>
              <button type="button" onClick={() => setShowAddContact(false)}>
                Close
              </button>
            </header>
            <form className="contact-search" onSubmit={searchContacts}>
              <input
                value={contactQuery}
                onChange={(event) => setContactQuery(event.target.value)}
                placeholder="Search by name, email, or phone"
              />
              <button type="submit">Search</button>
            </form>
            {contactSearchMessage && <p className="empty-copy">{contactSearchMessage}</p>}
            <div className="contact-results">
              {contactResults.map((user) => {
                const relationshipStatus = getRelationshipStatus(user);
                const isAccepted = relationshipStatus === "accepted";
                const isPendingSent = relationshipStatus === "pending_sent";
                const isPendingReceived = relationshipStatus === "pending_received";

                return (
                  <article className="contact-result" key={user.id}>
                    <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
                    <div>
                      <strong>{user.name}</strong>
                      <small>{user.email || user.phone}</small>
                    </div>
                    {isAccepted && (
                      <span className="request-actions">
                        <span className="contact-status-badge added">Added</span>
                        <button type="button" onClick={() => openContactChat(user)}>
                          Open Chat
                        </button>
                      </span>
                    )}
                    {isPendingSent && <span className="contact-status-badge">Request pending</span>}
                    {isPendingReceived && user.contactRequestId && (
                      <span className="request-actions">
                        <button type="button" onClick={() => respondToContactRequest(user.contactRequestId, "accept")}>
                          Accept
                        </button>
                        <button type="button" onClick={() => respondToContactRequest(user.contactRequestId, "reject")}>
                          Reject
                        </button>
                      </span>
                    )}
                    {isPendingReceived && !user.contactRequestId && (
                      <span className="contact-status-badge">Respond to request</span>
                    )}
                    {!isAccepted && !isPendingSent && !isPendingReceived && (
                      <button type="button" onClick={() => sendContactRequest(user.id)}>
                        Send Request
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {showRequests && (
        <div className="modal-backdrop">
          <section className="contact-modal">
            <header className="modal-header">
              <h2>Contact Requests</h2>
              <button type="button" onClick={() => setShowRequests(false)}>
                Close
              </button>
            </header>
            {contactRequests.length === 0 && <p className="empty-copy">No pending requests.</p>}
            <div className="contact-results">
              {contactRequests.map((request) => (
                <article className="contact-result" key={request.id}>
                  <span className="avatar">{request.requester?.name?.slice(0, 1).toUpperCase() || "?"}</span>
                  <div>
                    <strong>{request.requester?.name || "Zivico user"}</strong>
                    <small>{request.requester?.email || request.requester?.phone}</small>
                  </div>
                  <span className="request-actions">
                    <button type="button" onClick={() => respondToContactRequest(request.id, "accept")}>
                      Accept
                    </button>
                    <button type="button" onClick={() => respondToContactRequest(request.id, "reject")}>
                      Reject
                    </button>
                  </span>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

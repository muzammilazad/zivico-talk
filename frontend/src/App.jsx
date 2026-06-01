import { useEffect, useMemo, useRef, useState } from "react";
import { Camera } from "lucide-react";
import AuthPanel from "./components/AuthPanel";
import ChatWindow from "./components/ChatWindow";
import UserList from "./components/UserList";
import VideoCallModal from "./components/VideoCallModal";
import { API_URL, api } from "./lib/api";
import { createSocket } from "./lib/socket";

const emptySession = { token: "", user: null };

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
  return url.startsWith("http") ? url : `${API_URL}${url}`;
}

function currentUserAvatar(user) {
  if (user.avatarUrl) {
    return <img className="topbar-avatar image-avatar" src={mediaSrc(user.avatarUrl)} alt={user.name} />;
  }
  return <span className="topbar-avatar">{user.name.slice(0, 1).toUpperCase()}</span>;
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

function mergeMessage(currentMessages, nextMessage) {
  const message = normalizeMessage(nextMessage);
  const exists = currentMessages.some(
    (item) =>
      String(item.id) === String(message.id) ||
      (item.clientId && message.clientId && String(item.clientId) === String(message.clientId))
  );

  if (!exists) return [...currentMessages, message];

  return currentMessages.map((item) => {
    const sameId = String(item.id) === String(message.id);
    const sameClientId = item.clientId && message.clientId && String(item.clientId) === String(message.clientId);
    return sameId || sameClientId ? { ...item, ...message } : item;
  });
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
  const [onlineIds, setOnlineIds] = useState(new Set());
  const [selectedUser, setSelectedUser] = useState(null);
  const [messages, setMessages] = useState([]);
  const [unreadCounts, setUnreadCounts] = useState({});
  const [latestMessages, setLatestMessages] = useState({});
  const [messageText, setMessageText] = useState("");
  const [replyToMessage, setReplyToMessage] = useState(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [call, setCall] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);

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
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  const currentUser = session.user;

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

    const socket = createSocket(session.token);
    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("socket connected", socket.id);
    });

    socket.on("presence", (onlineUsers) => {
      setOnlineIds(new Set(onlineUsers.map((user) => user.id)));
    });

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
        setMessages((current) => mergeMessage(current, normalizedMessage));
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

    socket.on("message-status-updated", (message) => {
      console.log("status updated", message);
      setMessages((current) => mergeMessage(current, normalizeMessage(message)));
    });

    function handleMessagesRead({ messageIds = [] }) {
      console.log("message read", messageIds);
      setMessages((current) =>
        current.map((message) =>
          messageIds.some((messageId) => String(messageId) === String(message.id)) ? { ...message, status: "read" } : message
        )
      );
    }

    socket.on("message-read", handleMessagesRead);
    socket.on("messages-read", handleMessagesRead);

    function handleMessageReaction({ reaction, action }) {
      setMessages((current) => applyReactionToMessages(current, reaction, action));
    }

    socket.on("message-reaction-added", (payload) => handleMessageReaction({ ...payload, action: "added" }));
    socket.on("message-reaction-updated", (payload) => handleMessageReaction({ ...payload, action: "updated" }));
    socket.on("message-reaction-removed", (payload) => handleMessageReaction({ ...payload, action: "removed" }));

    socket.on("contact-request-received", (request) => {
      console.log("contact request received", request);
      setContactRequests((current) =>
        current.some((item) => String(item.id) === String(request.id)) ? current : [request, ...current]
      );
    });

    socket.on("contact-request-accepted", () => {
      refreshContacts();
      refreshContactRequests();
    });

    socket.on("contact-request-rejected", () => {
      refreshContactRequests();
    });

    socket.on("call-event-created", (event) => {
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
    });

    socket.on("call-user", ({ from, fromUser, callType }) => {
      console.log("incoming call type received", callType);
      setIncomingCall({ from, fromUser, callType });
    });

    socket.on("call-accepted", async ({ from, callType }) => {
      const activeCall = callRef.current;
      if (!activeCall || String(activeCall.peer.id) !== String(from) || !pcRef.current) return;

      setCall({ ...activeCall, status: "connected" });
      const offer = await pcRef.current.createOffer();
      await pcRef.current.setLocalDescription(offer);
      socket.emit("offer", { to: from, offer, callType });
    });

    socket.on("offer", async ({ from, offer, callType }) => {
      let activeCall = callRef.current;
      if (!pcRef.current) {
        const fromUser = contacts.find((user) => String(user.id) === String(from)) || { id: from, name: "Caller", email: "" };
        await prepareLocalMedia(callType, { receivingScreen: callType === "screen" });
        createPeerConnection(from);
        activeCall = { peer: fromUser, type: callType, status: "connected", isCaller: false };
        setCall(activeCall);
      }

      await pcRef.current.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pcRef.current.createAnswer();
      await pcRef.current.setLocalDescription(answer);
      socket.emit("answer", { to: from, answer, callType });
    });

    socket.on("answer", async ({ answer }) => {
      if (pcRef.current) {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(answer));
      }
    });

    socket.on("ice-candidate", async ({ candidate }) => {
      if (pcRef.current && candidate) {
        await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    socket.on("end-call", ({ from, callType, callStatus }) => {
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
    });

    return () => {
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
          (a, b) => Number(onlineIds.has(b.id)) - Number(onlineIds.has(a.id)) || a.name.localeCompare(b.name)
        );
    },
    [contacts, onlineIds, sidebarSearch]
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

  function selectUser(user) {
    setSelectedUser(user);
    setUnreadCounts((current) => ({
      ...current,
      [String(user.id)]: 0
    }));
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
        current.map((user) => (String(user.id) === String(receiverId) ? { ...user, requestStatus: "pending" } : user))
      );
      console.log("contact-request-sent", request);
    } catch (err) {
      setContactSearchMessage(err.message);
    }
  }

  async function respondToContactRequest(requestId, action) {
    const result = await api(`/api/contact-requests/${requestId}/${action}`, { method: "POST" }, session.token);
    setContactRequests((current) => current.filter((request) => String(request.id) !== String(requestId)));
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
    setMessages((current) => mergeMessage(current, optimisticMessage));
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
    setReplyToMessage(null);
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

      setMessages((current) => mergeMessage(current, optimisticMessage));
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
        setMessages((current) => mergeMessage(current, forwardedMessage));
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

  async function getCallStream(type, options = {}) {
    if (type === "screen" && options.receivingScreen) {
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false }).catch(() => new MediaStream());
    }

    if (type === "screen") {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }).catch(() => null);
      const tracks = [...displayStream.getVideoTracks(), ...displayStream.getAudioTracks()];
      if (micStream) tracks.push(...micStream.getAudioTracks());
      return new MediaStream(tracks);
    }

    return navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === "video"
    });
  }

  async function prepareLocalMedia(type, options = {}) {
    const stream = await getCallStream(type, options);
    localStreamRef.current = stream;
    cameraStreamRef.current = stream;
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }
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

  function createPeerConnection(peerId) {
    pcRef.current?.close();
    remoteStreamRef.current = new MediaStream();

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.emit("ice-candidate", {
          to: peerId,
          candidate: event.candidate,
          callType: callRef.current?.type || "voice"
        });
      }
    };

    pc.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => remoteStreamRef.current.addTrack(track));
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStreamRef.current;
      }
    };

    localStreamRef.current?.getTracks().forEach((track) => pc.addTrack(track, localStreamRef.current));
    pcRef.current = pc;
    return pc;
  }

  async function startCall(type) {
    if (!selectedUser || !socketRef.current) return;

    try {
      await prepareLocalMedia(type);
      createPeerConnection(selectedUser.id);
      setCall({ peer: selectedUser, type, status: "ringing", isCaller: true });
      callStartedAtRef.current = Date.now();
      console.log("call type sent", type);
      socketRef.current.emit("call-user", { to: selectedUser.id, callType: type });
    } catch (err) {
      alert(err.message || "Could not start call");
      endCallLocally();
    }
  }

  async function acceptIncomingCall() {
    if (!incomingCall || !socketRef.current) return;

    try {
      await prepareLocalMedia(incomingCall.callType, { receivingScreen: incomingCall.callType === "screen" });
      createPeerConnection(incomingCall.from);
      setCall({
        peer: incomingCall.fromUser,
        type: incomingCall.callType,
        status: "connected",
        isCaller: false
      });
      callStartedAtRef.current = Date.now();
      socketRef.current.emit("call-accepted", { to: incomingCall.from, callType: incomingCall.callType });
      setIncomingCall(null);
    } catch (err) {
      alert(err.message || "Could not accept call");
      rejectIncomingCall();
    }
  }

  function rejectIncomingCall() {
    if (incomingCall && socketRef.current) {
      saveCallEvent({
        callType: incomingCall.callType || "voice",
        status: "declined",
        callerId: incomingCall.from,
        receiverId: currentUser.id
      });
      socketRef.current.emit("end-call", {
        to: incomingCall.from,
        callType: incomingCall.callType || "voice",
        callStatus: "declined"
      });
    }
    setIncomingCall(null);
  }

  function replaceOutgoingVideoTrack(track) {
    const sender = pcRef.current?.getSenders().find((item) => item.track?.kind === "video");
    if (sender) {
      sender.replaceTrack(track);
    } else if (track && pcRef.current && localStreamRef.current) {
      pcRef.current.addTrack(track, localStreamRef.current);
    }
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
      const cameraStream =
        cameraStreamRef.current || (await navigator.mediaDevices.getUserMedia({ video: call?.type !== "voice", audio: true }));
      localStreamRef.current?.getVideoTracks().forEach((track) => {
        if (!cameraStream.getVideoTracks().includes(track)) track.stop();
      });
      localStreamRef.current = cameraStream;
      cameraStreamRef.current = cameraStream;
      replaceOutgoingVideoTrack(cameraStream.getVideoTracks()[0]);
      if (localVideoRef.current) localVideoRef.current.srcObject = cameraStream;
      setScreenSharing(false);
      return;
    }

    const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const screenTrack = displayStream.getVideoTracks()[0];
    replaceOutgoingVideoTrack(screenTrack);
    localStreamRef.current = displayStream;
    if (localVideoRef.current) localVideoRef.current.srcObject = displayStream;
    screenTrack.onended = () => {
      if (stoppingCallRef.current) return;
      if (callRef.current?.type === "screen") {
        endCall();
      } else {
        setScreenSharing(false);
      }
    };
    setScreenSharing(true);
  }

  function stopScreenShare() {
    if (call?.type === "screen") {
      endCall();
      return;
    }

    toggleScreenShare();
  }

  function endCallLocally() {
    pcRef.current?.close();
    pcRef.current = null;
    stoppingCallRef.current = true;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
    stoppingCallRef.current = false;
    localStreamRef.current = null;
    cameraStreamRef.current = null;
    remoteStreamRef.current = new MediaStream();
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
        callType: call?.type || incomingCall?.callType || "voice",
        callStatus
      });
    }
    endCallLocally();
  }

  if (!currentUser) {
    return <AuthPanel onAuth={handleAuth} />;
  }

  return (
    <main className="app-shell">
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
        <div>
          <strong>Zivico Talk</strong>
          <span>{currentUser.name}</span>
        </div>
        <span className="topbar-actions">
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
            Logout
          </button>
        </span>
      </header>

      <div className="workspace">
        <UserList
          apiUrl={API_URL}
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
        <ChatWindow
          currentUser={currentUser}
          selectedUser={selectedUser}
          messages={messages}
          messageText={messageText}
          contacts={contacts}
          replyToMessage={replyToMessage}
          onMessageText={setMessageText}
          onSend={sendMessage}
          onSendMedia={sendMediaMessage}
          onReactToMessage={reactToMessage}
          onReplyToMessage={setReplyToMessage}
          onCancelReply={() => setReplyToMessage(null)}
          onForwardMessage={forwardMessage}
          onStartCall={startCall}
          apiUrl={API_URL}
        />
      </div>

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
                placeholder="Search by email or phone"
              />
              <button type="submit">Search</button>
            </form>
            {contactSearchMessage && <p className="empty-copy">{contactSearchMessage}</p>}
            <div className="contact-results">
              {contactResults.map((user) => (
                <article className="contact-result" key={user.id}>
                  <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
                  <div>
                    <strong>{user.name}</strong>
                    <small>{user.email || user.phone}</small>
                  </div>
                  <button
                    type="button"
                    disabled={user.requestStatus === "pending"}
                    onClick={() => sendContactRequest(user.id)}
                  >
                    {user.requestStatus === "pending" ? "Request pending" : "Send Request"}
                  </button>
                </article>
              ))}
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

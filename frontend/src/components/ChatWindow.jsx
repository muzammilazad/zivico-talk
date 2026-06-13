import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  CheckCheck,
  Copy,
  Edit3,
  FileUp,
  Forward,
  Image,
  Mic,
  MoreVertical,
  Paperclip,
  Phone,
  Reply,
  Search,
  Send,
  Smile,
  SmilePlus,
  Square,
  Trash2,
  Video,
  X
} from "lucide-react";

const composerEmojis = ["😀", "😃", "😄", "😁", "😂", "😊", "😍", "😘", "😎", "😢", "😭", "😡", "👍", "👎", "🙏", "👏", "❤️", "💔", "🔥", "🎉", "✅", "❌", "📞", "🎥", "🖥️"];
const reactionEmojis = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

function formatDuration(seconds) {
  if (!seconds) return "";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}

function callEventLabel(event) {
  const labels = { voice: "voice call", video: "video call", screen: "screen share" };
  const label = labels[event.callType] || "call";
  const statuses = {
    started: `${label} started`,
    missed: `Missed ${label}`,
    declined: `Declined ${label}`,
    ended: `${label} ended`
  };

  return statuses[event.status] || label;
}

function mediaSrc(apiUrl, url) {
  if (!url) return "";
  return url.startsWith("http") ? url : `${apiUrl}${url}`;
}

function dateSeparatorLabel(value) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString();
}

function avatarFor(user, apiUrl) {
  if (user.avatarUrl) {
    return <img className="avatar image-avatar" src={mediaSrc(apiUrl, user.avatarUrl)} alt={user.name} />;
  }
  return <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>;
}

function messagePreview(message) {
  if (!message) return "Original message unavailable";
  if (message.type === "image") return "Photo";
  if (message.type === "voice") return "Voice message";
  if (message.type === "file") return message.mediaName || "File";
  return message.text || message.message || "";
}

function replySenderName(message, currentUser, selectedUser) {
  if (!message) return "Original message";
  if (message.senderName) return message.senderName;
  return String(message.senderId) === String(currentUser.id) ? "You" : selectedUser?.name || "Zivico user";
}

function MessageStatus({ status }) {
  const normalizedStatus = status || "sent";
  const label = normalizedStatus === "read" ? "Read" : normalizedStatus === "delivered" ? "Delivered" : "Sent";

  return (
    <span className={`message-status ${normalizedStatus}`} title={label} aria-label={label}>
      {normalizedStatus === "sent" ? <Check size={15} /> : <CheckCheck size={15} />}
    </span>
  );
}

export default function ChatWindow({
  apiUrl,
  currentUser,
  selectedUser,
  contacts,
  messages,
  messageText,
  isTyping,
  replyToMessage,
  onMessageText,
  onSend,
  onSendMedia,
  onReactToMessage,
  onEditMessage,
  onDeleteMessage,
  onReplyToMessage,
  onCancelReply,
  onForwardMessage,
  onStartCall,
  onBack
}) {
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [uploadError, setUploadError] = useState("");
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState("");
  const [actionMenuMessageId, setActionMenuMessageId] = useState("");
  const [forwardMessage, setForwardMessage] = useState(null);
  const [forwardQuery, setForwardQuery] = useState("");
  const [forwardReceiverIds, setForwardReceiverIds] = useState([]);
  const [highlightedMessageId, setHighlightedMessageId] = useState("");
  const [chatSearch, setChatSearch] = useState("");
  const [editingMessage, setEditingMessage] = useState(null);
  const [editText, setEditText] = useState("");
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const recordingStartedAtRef = useRef(0);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const composerRef = useRef(null);
  const messagesRef = useRef(null);
  const messageRefs = useRef(new Map());

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    function handleOutsideClick(event) {
      if (composerRef.current?.contains(event.target)) return;
      setEmojiPickerOpen(false);
    }

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  const filteredForwardContacts = contacts.filter((contact) => {
    const query = forwardQuery.trim().toLowerCase();
    return (
      !query ||
      contact.name?.toLowerCase().includes(query) ||
      contact.email?.toLowerCase().includes(query) ||
      String(contact.phone || "").toLowerCase().includes(query)
    );
  });
  const visibleMessages = chatSearch.trim()
    ? messages.filter((message) =>
        String(message.text || message.message || message.mediaName || "")
          .toLowerCase()
          .includes(chatSearch.trim().toLowerCase())
      )
    : messages;

  if (!selectedUser) {
    return (
      <section className="chat-empty">
        <h2>Zee Talk</h2>
        <p>Select a user to start a private conversation.</p>
      </section>
    );
  }

  async function startRecording() {
    try {
      setUploadError("");
      if (!window.MediaRecorder) {
        setUploadError("Voice notes are not supported in this browser.");
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const file = new File([blob], `voice-note-${Date.now()}.webm`, { type: blob.type });
        const mediaDurationSeconds = Math.max(1, Math.round((Date.now() - recordingStartedAtRef.current) / 1000));
        await sendSelectedMedia(file, "voice", { mediaDurationSeconds });
        chunksRef.current = [];
      };
      recorder.start();
      setRecording(true);
      setRecordingSeconds(0);
      recordingStartedAtRef.current = Date.now();
      timerRef.current = setInterval(() => setRecordingSeconds((value) => value + 1), 1000);
    } catch (err) {
      setUploadError(err.message || "Could not start voice recording.");
    }
  }

  function stopRecording({ send }) {
    clearInterval(timerRef.current);
    timerRef.current = null;
    setRecording(false);

    const recorder = recorderRef.current;
    if (!recorder) return;
    if (!send) {
      recorder.onstop = () => {
        recorder.stream?.getTracks().forEach((track) => track.stop());
        chunksRef.current = [];
      };
    }
    recorder.stop();
    recorderRef.current = null;
  }

  async function sendSelectedMedia(file, explicitType, options = {}) {
    if (!file) return;
    try {
      setUploadError("");
      await onSendMedia(file, explicitType, options);
    } catch (err) {
      setUploadError(err.message || "Upload failed.");
    }
  }

  function insertEmoji(emoji) {
    onMessageText(`${messageText}${emoji}`);
    setEmojiPickerOpen(false);
  }

  function handleReaction(message, emoji) {
    onReactToMessage(message, emoji);
    setReactionPickerMessageId("");
    setActionMenuMessageId("");
  }

  function handleSend(event) {
    setEmojiPickerOpen(false);
    onSend(event);
  }

  function handleReply(message) {
    onReplyToMessage({
      id: message.id,
      senderId: message.senderId,
      senderName: replySenderName(message, currentUser, selectedUser),
      type: message.type,
      text: message.text || message.message || "",
      mediaName: message.mediaName,
      mediaUrl: message.mediaUrl,
      mediaMimeType: message.mediaMimeType,
      mediaDurationSeconds: message.mediaDurationSeconds
    });
    setActionMenuMessageId("");
  }

  function openForwardModal(message) {
    setForwardMessage(message);
    setForwardQuery("");
    setForwardReceiverIds([]);
    setActionMenuMessageId("");
  }

  function startEdit(message) {
    setEditingMessage(message);
    setEditText(message.text || message.message || "");
    setActionMenuMessageId("");
  }

  async function submitEdit(event) {
    event.preventDefault();
    if (!editingMessage || !editText.trim()) return;
    await onEditMessage(editingMessage, editText.trim());
    setEditingMessage(null);
    setEditText("");
  }

  async function removeMessage(message, scope) {
    await onDeleteMessage(message, scope);
    setActionMenuMessageId("");
  }

  function toggleForwardReceiver(receiverId) {
    setForwardReceiverIds((current) =>
      current.some((id) => String(id) === String(receiverId))
        ? current.filter((id) => String(id) !== String(receiverId))
        : [...current, receiverId]
    );
  }

  async function submitForward() {
    await onForwardMessage(forwardMessage, forwardReceiverIds);
    setForwardMessage(null);
    setForwardReceiverIds([]);
  }

  function scrollToMessage(messageId) {
    const target = messageRefs.current.get(String(messageId));
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedMessageId(String(messageId));
    setTimeout(() => setHighlightedMessageId(""), 1200);
  }

  function renderMessageContent(message) {
    const url = mediaSrc(apiUrl, message.mediaUrl || message.fileUrl || message.audioUrl || message.media?.url);
    const fileName = message.fileName || message.mediaName;
    const durationSeconds = message.durationSeconds || message.mediaDurationSeconds;
    if (message.type === "image" && url) {
      return (
        <>
          <img className="message-image" src={url} alt={fileName || "Shared image"} />
          {message.text && <p>{message.text}</p>}
        </>
      );
    }
    if (message.type === "voice" && url) {
      return (
        <span className="voice-message">
          <audio className="voice-note" controls src={url} />
          {durationSeconds ? <small>{formatDuration(durationSeconds)}</small> : null}
        </span>
      );
    }
    if (message.type === "file" && url) {
      return (
        <a className="file-message" href={url} target="_blank" rel="noreferrer">
          <FileUp size={18} />
          <span>{fileName || "Open file"}</span>
        </a>
      );
    }
    return <p>{message.text || message.message || ""}</p>;
  }

  return (
    <section className="chat-window">
      <header className="chat-header">
        <div className="chat-peer">
          <button className="mobile-chat-back" title="Back to chats" type="button" onClick={onBack}>
            <ArrowLeft size={22} />
          </button>
          {avatarFor(selectedUser, apiUrl)}
          <div>
            <h2>{selectedUser.name}</h2>
            <p>{isTyping ? `${isTyping.name} is typing...` : selectedUser.online ? "online" : "last seen recently"}</p>
          </div>
        </div>
        <div className="chat-actions">
          <label className="chat-search">
            <Search size={16} />
            <input value={chatSearch} onChange={(event) => setChatSearch(event.target.value)} placeholder="Search chat" />
          </label>
          <button title="Voice call" type="button" onClick={() => onStartCall("voice")}>
            <Phone size={20} />
          </button>
          <button title="Video call" type="button" onClick={() => onStartCall("video")}>
            <Video size={20} />
          </button>
        </div>
      </header>

      <div className="messages" ref={messagesRef}>
        {messages.length === 0 && <p className="empty-copy timeline-empty">No messages yet.</p>}
        {visibleMessages.map((message, index) => {
          const previous = visibleMessages[index - 1];
          const createdAt = message.createdAt || message.timestamp;
          const showSeparator =
            !previous || new Date(previous.createdAt || previous.timestamp).toDateString() !== new Date(createdAt).toDateString();
          if (message.type === "call_event") {
            const emphasizedForCurrentUser =
              ["missed", "declined"].includes(message.status) && String(message.receiverId) === String(currentUser.id);
            const duration = message.status === "ended" ? formatDuration(message.durationSeconds) : "";

            return (
              <span key={message.id}>
                {showSeparator && <span className="date-separator">{dateSeparatorLabel(createdAt)}</span>}
                <article className={`call-event-card ${emphasizedForCurrentUser ? "missed" : ""}`}>
                  <strong>{callEventLabel(message)}</strong>
                  <span>
                    {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {duration ? ` - ${duration}` : ""}
                  </span>
                </article>
              </span>
            );
          }

          const mine = String(message.senderId) === String(currentUser.id);
          const reactions = message.reactions || [];
          const showActionMenu = String(actionMenuMessageId) === String(message.id);

          return (
            <span key={message.id}>
              {showSeparator && <span className="date-separator">{dateSeparatorLabel(createdAt)}</span>}
              <article
                ref={(node) => {
                  if (node) messageRefs.current.set(String(message.id), node);
                  else messageRefs.current.delete(String(message.id));
                }}
                className={`message ${mine ? "mine" : "theirs"} ${
                  String(highlightedMessageId) === String(message.id) ? "highlighted" : ""
                }`}
              >
              <button
                className="message-action-trigger"
                title="Message actions"
                type="button"
                onClick={() =>
                  setActionMenuMessageId((current) => (String(current) === String(message.id) ? "" : String(message.id)))
                }
              >
                <MoreVertical size={15} />
              </button>
              {showActionMenu && (
                <span className="message-action-menu">
                  <button type="button" onClick={() => handleReply(message)}>
                    <Reply size={14} />
                    Reply
                  </button>
                  <button type="button" onClick={() => openForwardModal(message)}>
                    <Forward size={14} />
                    Forward
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setReactionPickerMessageId(String(message.id));
                      setActionMenuMessageId("");
                    }}
                  >
                    <SmilePlus size={14} />
                    React
                  </button>
                  {(message.text || message.message) && (
                    <>
                    {mine && (
                      <button type="button" onClick={() => startEdit(message)}>
                        <Edit3 size={14} />
                        Edit
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(message.text || message.message || "");
                        setActionMenuMessageId("");
                      }}
                    >
                      <Copy size={14} />
                      Copy
                    </button>
                    </>
                  )}
                  <button type="button" onClick={() => removeMessage(message, "me")}>
                    <Trash2 size={14} />
                    Delete for me
                  </button>
                  {mine && (
                    <button type="button" onClick={() => removeMessage(message, "everyone")}>
                      <Trash2 size={14} />
                      Delete for everyone
                    </button>
                  )}
                </span>
              )}
              <button
                className="reaction-trigger"
                title="React"
                type="button"
                onClick={() =>
                  setReactionPickerMessageId((current) => (String(current) === String(message.id) ? "" : String(message.id)))
                }
              >
                <SmilePlus size={15} />
              </button>
              {String(reactionPickerMessageId) === String(message.id) && (
                <span className="reaction-picker">
                  {reactionEmojis.map((emoji) => (
                    <button key={emoji} type="button" onClick={() => handleReaction(message, emoji)}>
                      {emoji}
                    </button>
                  ))}
                </span>
              )}
              {message.isForwarded && <span className="forwarded-label">Forwarded</span>}
              {message.replyToMessageId && (
                <button
                  className="quoted-reply"
                  type="button"
                  onClick={() => scrollToMessage(message.replyToMessageId)}
                >
                  <strong>{replySenderName(message.replyToMessage, currentUser, selectedUser)}</strong>
                  <small>{messagePreview(message.replyToMessage)}</small>
                </button>
              )}
              {message.isDeletedForEveryone ? <p className="deleted-message">This message was deleted</p> : renderMessageContent(message)}
              {reactions.length > 0 && (
                <span className="message-reactions">
                  {reactions.map((reaction) => (
                    <button key={reaction.id || `${reaction.userId}-${reaction.emoji}`} type="button" onClick={() => handleReaction(message, reaction.emoji)}>
                      {reaction.emoji}
                    </button>
                  ))}
                </span>
              )}
              <span className="message-meta">
                {new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                {message.editedAt && " edited"}
                {mine && <MessageStatus status={message.status} />}
              </span>
              </article>
            </span>
          );
        })}
      </div>

      <form className="composer" ref={composerRef} onSubmit={handleSend}>
        <input
          ref={fileInputRef}
          hidden
          type="file"
          accept=".pdf,.doc,.docx,.txt,.zip,audio/*"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) sendSelectedMedia(file);
            event.target.value = "";
          }}
        />
        <input
          ref={imageInputRef}
          hidden
          type="file"
          accept="image/*"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) sendSelectedMedia(file, "image");
            event.target.value = "";
          }}
        />
        {replyToMessage && (
          <div className="reply-preview">
            <span>
              <strong>Replying to {replySenderName(replyToMessage, currentUser, selectedUser)}</strong>
              <small>{messagePreview(replyToMessage)}</small>
            </span>
            <button title="Cancel reply" type="button" onClick={onCancelReply}>
              <X size={16} />
            </button>
          </div>
        )}
        <button title="Send photo" type="button" onClick={() => imageInputRef.current?.click()}>
          <Image size={20} />
        </button>
        <button title="Attach file" type="button" onClick={() => fileInputRef.current?.click()}>
          <Paperclip size={20} />
        </button>
        <button title="Emoji" type="button" onClick={() => setEmojiPickerOpen((value) => !value)}>
          <Smile size={20} />
        </button>
        {emojiPickerOpen && (
          <div className="emoji-picker">
            {composerEmojis.map((emoji) => (
              <button key={emoji} type="button" onClick={() => insertEmoji(emoji)}>
                {emoji}
              </button>
            ))}
          </div>
        )}
        <input
          value={messageText}
          onChange={(event) => onMessageText(event.target.value)}
          placeholder="Type a message"
        />
        {recording ? (
          <span className="recording-controls">
            <span className="recording-dot" />
            <span>{formatDuration(recordingSeconds)}</span>
            <button title="Cancel voice note" type="button" onClick={() => stopRecording({ send: false })}>
              <Trash2 size={18} />
            </button>
            <button title="Send voice note" type="button" onClick={() => stopRecording({ send: true })}>
              <Square size={18} />
            </button>
          </span>
        ) : (
          <button title="Record voice note" type="button" onClick={startRecording}>
            <Mic size={20} />
          </button>
        )}
        {messageText.trim() && (
          <button title="Send message" type="submit">
            <Send size={20} />
          </button>
        )}
      </form>
      {uploadError && <p className="upload-error">{uploadError}</p>}
      {editingMessage && (
        <div className="modal-backdrop">
          <form className="contact-modal" onSubmit={submitEdit}>
            <header className="modal-header">
              <h2>Edit Message</h2>
              <button type="button" onClick={() => setEditingMessage(null)}>
                Close
              </button>
            </header>
            <input value={editText} onChange={(event) => setEditText(event.target.value)} />
            <button type="submit">Save</button>
          </form>
        </div>
      )}
      {forwardMessage && (
        <div className="modal-backdrop">
          <section className="contact-modal forward-modal">
            <header className="modal-header">
              <h2>Forward Message</h2>
              <button type="button" onClick={() => setForwardMessage(null)}>
                Close
              </button>
            </header>
            <div className="forward-source">
              <strong>{messagePreview(forwardMessage)}</strong>
            </div>
            <div className="contact-search">
              <input
                value={forwardQuery}
                onChange={(event) => setForwardQuery(event.target.value)}
                placeholder="Search contacts"
              />
              <button type="button" disabled={forwardReceiverIds.length === 0} onClick={submitForward}>
                Forward
              </button>
            </div>
            <div className="contact-results">
              {filteredForwardContacts.map((contact) => {
                const checked = forwardReceiverIds.some((id) => String(id) === String(contact.id));
                return (
                  <label className="contact-result forward-contact" key={contact.id}>
                    {avatarFor(contact, apiUrl)}
                    <span>
                      <strong>{contact.name}</strong>
                      <small>{contact.email || contact.phone}</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleForwardReceiver(contact.id)}
                    />
                  </label>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

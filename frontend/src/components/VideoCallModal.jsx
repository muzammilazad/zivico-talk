import { Mic, MicOff, MonitorUp, Phone, PhoneOff, Video, VideoOff } from "lucide-react";

function callTypeLabel(type) {
  const labels = {
    voice: "Voice call",
    video: "Video call",
    screen: "Screen share"
  };
  return labels[type] || "Call";
}

export default function VideoCallModal({
  call,
  incomingCall,
  localVideoRef,
  remoteVideoRef,
  muted,
  cameraOff,
  screenSharing,
  onAccept,
  onReject,
  onToggleMute,
  onToggleCamera,
  onToggleScreen,
  onStopScreenShare,
  onEnd
}) {
  const visible = call || incomingCall;

  if (!visible) {
    return null;
  }

  const peer = incomingCall?.fromUser || call?.peer;
  const type = incomingCall?.callType || call?.type || "voice";
  const isVoice = type === "voice";
  const isScreen = type === "screen";
  const screenVideoRef = call?.isCaller ? localVideoRef : remoteVideoRef;
  const typeLabel = callTypeLabel(type);
  const status = incomingCall
    ? `Incoming ${typeLabel.toLowerCase()}`
    : call.status === "ringing"
      ? `Calling - ${typeLabel.toLowerCase()}`
      : type === "screen"
        ? "Screen sharing"
        : typeLabel;

  return (
    <div className="modal-backdrop">
      <section className="call-modal">
        <header className="call-header">
          <div>
            <h2>{peer?.name || "Zivico user"}</h2>
            <p>{status}</p>
          </div>
          <span className={`call-type-pill ${type}`}>
            {type === "voice" && <Phone size={14} />}
            {type === "video" && <Video size={14} />}
            {type === "screen" && <MonitorUp size={14} />}
            {typeLabel}
          </span>
        </header>

        {isVoice ? (
          <div className="voice-call-panel">
            <span className="voice-call-avatar">
              <Phone size={34} />
            </span>
            <strong>{peer?.name || "Zivico user"}</strong>
            <p>{status}</p>
          </div>
        ) : isScreen ? (
          <div className="screen-share-stage">
            <video ref={screenVideoRef} autoPlay playsInline muted={call?.isCaller} />
            <span className="screen-share-label">
              {call?.isCaller ? "Your shared screen" : `${peer?.name || "Zivico user"}'s screen`}
            </span>
            <div className="screen-share-preview">
              <video ref={call?.isCaller ? remoteVideoRef : localVideoRef} autoPlay playsInline muted={!call?.isCaller} />
              <small>{call?.isCaller ? peer?.name || "Zivico user" : "You"}</small>
            </div>
          </div>
        ) : (
          <div className="video-grid">
            <div className="video-tile">
              <video ref={remoteVideoRef} autoPlay playsInline muted />
              <span>{type === "screen" ? "Shared screen" : "Remote"}</span>
            </div>
            <div className="video-tile local">
              <video ref={localVideoRef} autoPlay playsInline muted />
              <span>{type === "screen" ? "Your screen" : "You"}</span>
            </div>
          </div>
        )}

        {incomingCall ? (
          <div className="call-controls">
            <button className="accept" type="button" onClick={onAccept}>
              Accept
            </button>
            <button className="danger text-button" type="button" onClick={onReject}>
              Decline
            </button>
          </div>
        ) : (
          <div className="call-controls">
            <button title={muted ? "Unmute mic" : "Mute mic"} type="button" onClick={onToggleMute}>
              {muted ? <MicOff size={20} /> : <Mic size={20} />}
            </button>
            {type === "video" && (
              <button title={cameraOff ? "Turn camera on" : "Turn camera off"} type="button" onClick={onToggleCamera}>
                {cameraOff ? <VideoOff size={20} /> : <Video size={20} />}
              </button>
            )}
            {type === "screen" ? (
              <button className="danger text-button" type="button" onClick={onStopScreenShare}>
                Stop sharing
              </button>
            ) : (
              <button
                className={screenSharing ? "active-control" : ""}
                title={screenSharing ? "Stop screen share" : "Start screen share"}
                type="button"
                onClick={onToggleScreen}
              >
                <MonitorUp size={20} />
              </button>
            )}
            <button className="danger" title="End call" type="button" onClick={onEnd}>
              <PhoneOff size={20} />
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

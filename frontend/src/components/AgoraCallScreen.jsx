import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from "lucide-react";

export default function AgoraCallScreen({
  call,
  incomingCall,
  localVideoRef,
  remoteVideoRef,
  audioBlocked,
  ringtoneBlocked,
  muted,
  cameraOff,
  onAccept,
  onReject,
  onEnd,
  onToggleMute,
  onToggleCamera,
  onEnableAudio,
  onEnableRingtone
}) {
  const visibleCall = call || incomingCall;
  if (!visibleCall) return null;

  const peer = call?.peer || incomingCall?.fromUser;
  const isIncoming = Boolean(incomingCall && !call);
  const isVideoCall = visibleCall.isVideoCall || visibleCall.callType === "video";
  const status = isIncoming
    ? `Incoming ${isVideoCall ? "video" : "voice"} call`
    : call?.status === "calling"
      ? "Calling..."
      : call?.status === "connected"
        ? "Connected"
        : call?.status === "error"
          ? "Unable to connect"
          : "Connecting...";

  return (
    <div className="modal-backdrop">
      <section className="call-modal clean-call-modal agora-call-modal">
        <header className="call-header">
          <div>
            <h2>{peer?.name || "Zee Talk user"}</h2>
            <p>{status}</p>
          </div>
          <span className={`call-type-pill ${isVideoCall ? "video" : "voice"}`}>
            {isVideoCall ? <Video size={17} /> : <Phone size={17} />}
            {isVideoCall ? "Video call" : "Voice call"}
          </span>
        </header>

        {isVideoCall && !isIncoming ? (
          <div className="agora-video-stage">
            <div className="agora-remote-video" ref={remoteVideoRef}>
              <span>Waiting for video...</span>
            </div>
            <div className="agora-local-video" ref={localVideoRef}>
              <span>You</span>
            </div>
          </div>
        ) : (
          <div className="voice-call-panel">
            <span className="voice-call-avatar"><Phone size={34} /></span>
            <strong>{peer?.name || "Zee Talk user"}</strong>
            <p>{status}</p>
          </div>
        )}

        {audioBlocked && (
          <button className="enable-call-audio" type="button" onClick={onEnableAudio}>
            Tap to enable call audio
          </button>
        )}

        {isIncoming && ringtoneBlocked && (
          <button className="enable-call-audio" type="button" onClick={onEnableRingtone}>
            Tap to enable ringtone
          </button>
        )}

        <div className="call-controls">
          {isIncoming ? (
            <>
              <button className="accept text-button" type="button" onClick={onAccept}>Answer</button>
              <button className="danger text-button" type="button" onClick={onReject}>Reject</button>
            </>
          ) : (
            <>
              <button type="button" title={muted ? "Unmute" : "Mute"} onClick={onToggleMute}>
                {muted ? <MicOff size={20} /> : <Mic size={20} />}
              </button>
              {isVideoCall && (
                <button type="button" title={cameraOff ? "Camera on" : "Camera off"} onClick={onToggleCamera}>
                  {cameraOff ? <VideoOff size={20} /> : <Video size={20} />}
                </button>
              )}
              <button className="danger" type="button" title="End call" onClick={onEnd}>
                <PhoneOff size={20} />
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

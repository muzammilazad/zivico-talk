import { Bug, Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from "lucide-react";

export default function WebRTCCallModal({
  call,
  incomingCall,
  localVideoRef,
  remoteVideoRef,
  remoteAudioRef,
  logs,
  showDebug,
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
  onEnableRingtone,
  onToggleDebug,
  onClearLogs
}) {
  const visibleCall = call || incomingCall;
  if (!visibleCall) return null;

  const peer = call?.peer || incomingCall?.fromUser;
  const callType = call?.callType || incomingCall?.callType || "voice";
  const isIncoming = Boolean(incomingCall && !call);
  const hasVideo = callType === "video" || callType === "screen";
  const status = isIncoming
    ? incomingCall?.status === "connecting"
      ? "Connecting call"
      : `Incoming ${callType} call`
    : call?.status === "calling"
      ? `Calling ${peer?.name || "Zee Talk user"}`
      : "Connected";

  return (
    <div className="modal-backdrop">
      <section className="call-modal clean-call-modal">
        <header className="call-header">
          <div>
            <h2>{peer?.name || "Zee Talk user"}</h2>
            <p>{status}</p>
          </div>
          <button className="debug-toggle" type="button" title="WebRTC debug logs" onClick={onToggleDebug}>
            <Bug size={18} />
            Debug
          </button>
        </header>

        {callType === "voice" ? (
          <div className="voice-call-panel">
            <span className="voice-call-avatar"><Phone size={34} /></span>
            <strong>{peer?.name || "Zee Talk user"}</strong>
            <p>{status}</p>
          </div>
        ) : (
          <div className="video-grid">
            <div className="video-tile">
              <video ref={remoteVideoRef} autoPlay playsInline muted />
              <span>{callType === "screen" ? "Shared screen" : "Remote"}</span>
            </div>
            <div className="video-tile local">
              <video ref={localVideoRef} autoPlay playsInline muted />
              <span>You</span>
            </div>
          </div>
        )}

        <audio ref={remoteAudioRef} autoPlay playsInline />

        {audioBlocked && (
          <button className="enable-call-audio" type="button" onClick={onEnableAudio}>
            Tap to enable audio
          </button>
        )}

        {isIncoming && ringtoneBlocked && (
          <button className="enable-call-audio" type="button" onClick={onEnableRingtone}>
            Tap to enable ringtone
          </button>
        )}

        {showDebug && (
          <section className="call-debug-panel">
            <header>
              <strong>WebRTC Debug</strong>
              <button type="button" onClick={onClearLogs}>Clear</button>
            </header>
            <div>
              {logs.map((entry) => (
                <article key={entry.id}>
                  <time>{entry.timestamp}</time>
                  <strong>{entry.message}</strong>
                  {entry.data !== undefined && (
                    <pre>{typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data, null, 2)}</pre>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}

        <div className="call-controls">
          {isIncoming ? (
            <>
              <button className="accept text-button" type="button" onClick={onAccept}>Accept</button>
              <button className="danger text-button" type="button" onClick={onReject}>Reject</button>
            </>
          ) : (
            <>
              <button type="button" title={muted ? "Unmute" : "Mute"} onClick={onToggleMute}>
                {muted ? <MicOff size={20} /> : <Mic size={20} />}
              </button>
              {hasVideo && callType === "video" && (
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

import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";

const SCREEN_SHARE_UNSUPPORTED_MESSAGE = "Screen sharing is not supported on this mobile app yet.";
const TURN_URL = import.meta.env.VITE_TURN_URL || "";

const iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: TURN_URL,
    username: import.meta.env.VITE_TURN_USERNAME,
    credential: import.meta.env.VITE_TURN_CREDENTIAL
  }
].filter((server) => server.urls);

const peerConnectionConfig = {
  iceServers,
  iceCandidatePoolSize: 10
};

function trackSummary(stream) {
  return stream?.getTracks().map((track) => `${track.kind}:${track.readyState}`) || [];
}

function createCallId() {
  return globalThis.crypto?.randomUUID?.() || `call-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function useWebRTCCall({
  socket,
  currentUser,
  onIncomingCall,
  onOutgoingCall,
  onCallAnswered,
  onCallClosed,
  onError
}) {
  const [call, setCall] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);
  const [logs, setLogs] = useState([]);
  const [showDebug, setShowDebug] = useState(import.meta.env.VITE_WEBRTC_DEBUG !== "false");
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(new MediaStream());
  const pendingCandidatesRef = useRef([]);
  const offerWaitersRef = useRef([]);
  const callRef = useRef(null);
  const incomingCallRef = useRef(null);
  const callbacksRef = useRef({});
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const remoteAudioRef = useRef(null);

  useEffect(() => {
    callbacksRef.current = {
      onIncomingCall,
      onOutgoingCall,
      onCallAnswered,
      onCallClosed,
      onError
    };
  }, [onIncomingCall, onOutgoingCall, onCallAnswered, onCallClosed, onError]);

  const addWebRtcLog = useCallback((message, data) => {
    console.log(message, data ?? "");
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date().toLocaleTimeString(),
      message,
      data
    };
    setLogs((current) => [...current.slice(-99), entry]);
  }, []);

  const reportError = useCallback((action, error) => {
    const details = {
      action,
      name: error?.name || "Error",
      message: error?.message || String(error)
    };
    addWebRtcLog("Call error", details);
    callbacksRef.current.onError?.(details);
  }, [addWebRtcLog]);

  const attachLocalStream = useCallback((stream) => {
    if (!localVideoRef.current) return;
    localVideoRef.current.srcObject = stream;
    localVideoRef.current.muted = true;
    localVideoRef.current.play?.().catch(() => {});
  }, []);

  const enableRemoteAudio = useCallback(async () => {
    const audio = remoteAudioRef.current;
    if (!audio?.srcObject) return false;

    try {
      audio.muted = false;
      audio.volume = 1;
      await audio.play();
      setAudioBlocked(false);
      addWebRtcLog("Remote audio enabled");
      return true;
    } catch (error) {
      setAudioBlocked(true);
      reportError("enableRemoteAudio", error);
      return false;
    }
  }, [addWebRtcLog, reportError]);

  const attachRemoteStream = useCallback((callType) => {
    const stream = remoteStreamRef.current;

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = stream;
      remoteVideoRef.current.muted = true;
      if (callType !== "voice") {
        remoteVideoRef.current.play?.().catch(() => {});
      }
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = stream;
      remoteAudioRef.current.muted = false;
      remoteAudioRef.current.play?.().then(
        () => setAudioBlocked(false),
        () => setAudioBlocked(true)
      );
    }

    addWebRtcLog("Remote stream attached", trackSummary(stream));
  }, [addWebRtcLog]);

  const stopStreams = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    remoteStreamRef.current = new MediaStream();

    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
  }, []);

  const cleanup = useCallback((reason = "ended", notify = true) => {
    pcRef.current?.close();
    pcRef.current = null;
    pendingCandidatesRef.current = [];
    offerWaitersRef.current.splice(0).forEach((resolve) => resolve(null));
    stopStreams();

    const closedCall = callRef.current || incomingCallRef.current;
    callRef.current = null;
    incomingCallRef.current = null;
    setCall(null);
    setIncomingCall(null);
    setMuted(false);
    setCameraOff(false);
    setAudioBlocked(false);

    if (notify && closedCall) {
      callbacksRef.current.onCallClosed?.({ ...closedCall, reason });
    }
  }, [stopStreams]);

  const getLocalMedia = useCallback(async (callType, receiving = false) => {
    try {
      let stream;

      if (callType === "voice") {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false
        });
      } else if (callType === "video") {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: true
        });
      } else if (callType === "screen") {
        if (receiving) {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false
          });
        } else {
          if (Capacitor.getPlatform() === "android" || !navigator.mediaDevices?.getDisplayMedia) {
            throw new Error(SCREEN_SHARE_UNSUPPORTED_MESSAGE);
          }
          const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          stream = new MediaStream([
            ...displayStream.getVideoTracks(),
            ...micStream.getAudioTracks()
          ]);
        }
      } else {
        throw new Error(`Unsupported call type: ${callType}`);
      }

      localStreamRef.current = stream;
      attachLocalStream(stream);
      addWebRtcLog("getUserMedia success", { callType, tracks: trackSummary(stream) });
      return stream;
    } catch (error) {
      addWebRtcLog("getUserMedia failed", {
        callType,
        name: error?.name,
        message: error?.message
      });
      throw error;
    }
  }, [addWebRtcLog, attachLocalStream]);

  const flushCandidates = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc?.remoteDescription) return;

    const candidates = pendingCandidatesRef.current.splice(0);
    for (const candidate of candidates) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
      addWebRtcLog("ICE candidate added", candidate.candidate || "candidate");
    }
  }, [addWebRtcLog]);

  const addOrQueueCandidate = useCallback(async (candidate) => {
    if (!candidate) return;
    const pc = pcRef.current;

    if (!pc?.remoteDescription) {
      pendingCandidatesRef.current.push(candidate);
      addWebRtcLog("ICE candidate queued", candidate.candidate || "candidate");
      return;
    }

    await pc.addIceCandidate(new RTCIceCandidate(candidate));
    addWebRtcLog("ICE candidate added", candidate.candidate || "candidate");
  }, [addWebRtcLog]);

  const createPeerConnection = useCallback((peerId, callType) => {
    pcRef.current?.close();
    remoteStreamRef.current = new MediaStream();

    addWebRtcLog("creating peer connection", {
      peerId,
      callType,
      iceServers: iceServers.map((server) => server.urls)
    });

    const pc = new RTCPeerConnection(peerConnectionConfig);
    pcRef.current = pc;

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      addWebRtcLog("ICE candidate generated", event.candidate.candidate);
      socket?.emit("ice-candidate", {
        to: peerId,
        callId: callRef.current?.callId || incomingCallRef.current?.callId,
        from: currentUser?.id,
        callType,
        candidate: event.candidate.toJSON()
      });
      addWebRtcLog("ICE candidate sent", { to: peerId });
    };

    pc.ontrack = (event) => {
      if (!remoteStreamRef.current.getTracks().some((track) => track.id === event.track.id)) {
        remoteStreamRef.current.addTrack(event.track);
      }
      addWebRtcLog("remote track received", {
        kind: event.track.kind,
        tracks: trackSummary(remoteStreamRef.current)
      });
      attachRemoteStream(callType);
    };

    pc.oniceconnectionstatechange = () => {
      addWebRtcLog("ICE connection state:", pc.iceConnectionState);
    };

    pc.onconnectionstatechange = () => {
      addWebRtcLog("Peer connection state:", pc.connectionState);
      if (pc.connectionState === "failed") {
        reportError("connection", new Error("Call connection failed. Check the TURN server."));
      }
    };

    return pc;
  }, [addWebRtcLog, attachRemoteStream, currentUser?.id, reportError, socket]);

  const addLocalTracks = useCallback((pc, stream) => {
    stream.getTracks().forEach((track) => {
      pc.addTrack(track, stream);
    });
    addWebRtcLog("local tracks added", trackSummary(stream));
  }, [addWebRtcLog]);

  const startCall = useCallback(async (peer, callType) => {
    if (!socket || !currentUser || !peer) return;

    try {
      cleanup("replaced", false);
      pendingCandidatesRef.current = [];
      const callId = createCallId();
      addWebRtcLog("Starting call", { callId, peerId: peer.id, callType });
      addWebRtcLog("call type", callType);

      const nextCall = {
        callId,
        direction: "outgoing",
        peer,
        peerId: String(peer.id),
        callType,
        status: "calling",
        startedAt: Date.now()
      };
      callRef.current = nextCall;
      setCall(nextCall);
      callbacksRef.current.onOutgoingCall?.(nextCall);

      const startResult = await new Promise((resolve, reject) => {
        socket.timeout(5000).emit(
          "call-start",
          {
            to: peer.id,
            callId,
            callType
          },
          (error, response) => {
            if (error) {
              reject(new Error("Call signaling timed out."));
              return;
            }
            resolve(response);
          }
        );
      });

      if (!startResult?.ok) {
        const reason = startResult?.reason === "offline" ? "Receiver is offline." : "Could not start call.";
        throw new Error(reason);
      }

      const pc = createPeerConnection(peer.id, callType);
      const stream = await getLocalMedia(callType);
      if (callRef.current?.callId !== callId) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("Call is no longer active.");
      }
      addLocalTracks(pc, stream);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("call-offer", {
        to: peer.id,
        callId,
        from: currentUser.id,
        fromUser: {
          id: currentUser.id,
          name: currentUser.name,
          email: currentUser.email
        },
        callType,
        offer: pc.localDescription
      });
      addWebRtcLog("offer sent", { to: peer.id, callType });
    } catch (error) {
      const activeCall = callRef.current;
      if (activeCall?.callId) {
        socket.emit("call-end", {
          to: activeCall.peerId,
          callId: activeCall.callId,
          from: currentUser.id,
          callType: activeCall.callType
        });
      }
      reportError("startCall", error);
      cleanup("error");
      throw error;
    }
  }, [addLocalTracks, addWebRtcLog, cleanup, createPeerConnection, currentUser, getLocalMedia, reportError, socket]);

  const waitForOffer = useCallback(async () => {
    if (incomingCallRef.current?.offer) return incomingCallRef.current;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 5000);
      offerWaitersRef.current.push((pendingCall) => {
        clearTimeout(timeout);
        resolve(pendingCall);
      });
    });
  }, []);

  const acceptCall = useCallback(async () => {
    let pendingCall = incomingCallRef.current;
    if (!socket || !currentUser || !pendingCall) return;

    try {
      addWebRtcLog("Call accepted", { callId: pendingCall.callId });
      if (!pendingCall.offer) {
        const waitingCall = { ...pendingCall, status: "connecting" };
        incomingCallRef.current = waitingCall;
        setIncomingCall(waitingCall);
        pendingCall = await waitForOffer();
      }
      if (!pendingCall?.offer) {
        throw new Error("Call offer was not received.");
      }

      addWebRtcLog("call type", pendingCall.callType);
      const pc = createPeerConnection(pendingCall.from, pendingCall.callType);
      const stream = await getLocalMedia(pendingCall.callType, pendingCall.callType === "screen");
      if (incomingCallRef.current?.callId !== pendingCall.callId) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("Incoming call is no longer active.");
      }
      addLocalTracks(pc, stream);

      await pc.setRemoteDescription(new RTCSessionDescription(pendingCall.offer));
      addWebRtcLog("remote description set", "offer");
      await flushCandidates();

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("call-answer", {
        to: pendingCall.from,
        callId: pendingCall.callId,
        from: currentUser.id,
        callType: pendingCall.callType,
        answer: pc.localDescription
      });
      addWebRtcLog("answer sent", { to: pendingCall.from });

      const activeCall = {
        callId: pendingCall.callId,
        direction: "incoming",
        peer: pendingCall.fromUser,
        peerId: String(pendingCall.from),
        callType: pendingCall.callType,
        status: "connected",
        startedAt: Date.now()
      };
      callRef.current = activeCall;
      incomingCallRef.current = null;
      setCall(activeCall);
      setIncomingCall(null);
      callbacksRef.current.onCallAnswered?.(activeCall);
    } catch (error) {
      if (pendingCall?.callId) {
        socket.emit("call-reject", {
          to: pendingCall.from,
          callId: pendingCall.callId,
          from: currentUser.id,
          callType: pendingCall.callType
        });
      }
      reportError("acceptCall", error);
      cleanup("error");
      throw error;
    }
  }, [addLocalTracks, addWebRtcLog, cleanup, createPeerConnection, currentUser, flushCandidates, getLocalMedia, reportError, socket, waitForOffer]);

  const rejectCall = useCallback(() => {
    const pendingCall = incomingCallRef.current;
    if (!socket || !pendingCall) return;

    addWebRtcLog("Call rejected", { callId: pendingCall.callId });
    socket.emit("call-reject", {
      to: pendingCall.from,
      callId: pendingCall.callId,
      from: currentUser?.id,
      callType: pendingCall.callType
    });
    cleanup("rejected");
  }, [addWebRtcLog, cleanup, currentUser?.id, socket]);

  const endCall = useCallback(() => {
    const activeCall = callRef.current;
    const pendingCall = incomingCallRef.current;
    const target = activeCall?.peerId || pendingCall?.from;

    if (socket && target) {
      socket.emit("call-end", {
        to: target,
        callId: activeCall?.callId || pendingCall?.callId,
        from: currentUser?.id,
        callType: activeCall?.callType || pendingCall?.callType || "voice"
      });
    }
    cleanup(activeCall?.status === "calling" ? "cancelled" : "ended");
  }, [cleanup, currentUser?.id, socket]);

  const toggleMute = useCallback(() => {
    const nextMuted = !muted;
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setMuted(nextMuted);
  }, [muted]);

  const toggleCamera = useCallback(() => {
    const nextCameraOff = !cameraOff;
    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = !nextCameraOff;
    });
    setCameraOff(nextCameraOff);
  }, [cameraOff]);

  useEffect(() => {
    addWebRtcLog("NEW_WEBRTC_MODULE_RUNNING");
    addWebRtcLog("TURN URL loaded:", TURN_URL || "not configured");
    addWebRtcLog("TURN URL loaded", TURN_URL || "not configured");
  }, [addWebRtcLog]);

  useEffect(() => {
    if (!socket) return undefined;

    function handleIncomingCall(payload) {
      addWebRtcLog("Incoming call event received", {
        callId: payload.callId,
        from: payload.from,
        callType: payload.callType
      });
      addWebRtcLog("Opening incoming call modal", { callId: payload.callId });
      const pendingCall = {
        ...payload,
        status: "ringing",
        fromUser: payload.fromUser || {
          id: payload.from,
          name: "Zee Talk user",
          email: ""
        }
      };
      incomingCallRef.current = pendingCall;
      setIncomingCall(pendingCall);
      callbacksRef.current.onIncomingCall?.(pendingCall);
    }

    function handleOffer(payload) {
      addWebRtcLog("offer received", { from: payload.from, callType: payload.callType });
      const pendingCall = {
        ...(incomingCallRef.current || {}),
        ...payload,
        fromUser: payload.fromUser || incomingCallRef.current?.fromUser || {
          id: payload.from,
          name: "Zee Talk user",
          email: ""
        }
      };
      incomingCallRef.current = pendingCall;
      setIncomingCall(pendingCall);
      offerWaitersRef.current.splice(0).forEach((resolve) => resolve(pendingCall));
    }

    async function handleAnswer(payload) {
      try {
        addWebRtcLog("answer received", { from: payload.from });
        if (!pcRef.current) return;
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(payload.answer));
        addWebRtcLog("remote description set", "answer");
        await flushCandidates();

        const current = callRef.current;
        if (current) {
          const connectedCall = { ...current, status: "connected" };
          callRef.current = connectedCall;
          setCall(connectedCall);
          addWebRtcLog("Call accepted", { callId: connectedCall.callId });
          callbacksRef.current.onCallAnswered?.(connectedCall);
        }
      } catch (error) {
        reportError("handleAnswer", error);
      }
    }

    async function handleCandidate(payload) {
      try {
        addWebRtcLog("ICE candidate received", { from: payload.from });
        await addOrQueueCandidate(payload.candidate);
      } catch (error) {
        reportError("handleCandidate", error);
      }
    }

    function handleReject() {
      addWebRtcLog("Call rejected");
      cleanup("rejected");
    }

    function handleEnd() {
      cleanup("remote-ended");
    }

    function handleTimeout() {
      addWebRtcLog("Call timed out");
      callbacksRef.current.onError?.({ action: "timeout", message: "No answer" });
      cleanup("timeout");
    }

    function handleUnavailable(payload) {
      addWebRtcLog("Call timed out", payload?.reason || "unavailable");
      callbacksRef.current.onError?.({
        action: "unavailable",
        message: payload?.reason === "offline" ? "Receiver is offline" : "No answer"
      });
      cleanup(payload?.reason || "unavailable");
    }

    function handleMissedCall(payload) {
      addWebRtcLog("Missed call received", payload?.callId);
    }

    socket.on("incoming-call", handleIncomingCall);
    socket.on("call-offer", handleOffer);
    socket.on("call-answer", handleAnswer);
    socket.on("ice-candidate", handleCandidate);
    socket.on("call-reject", handleReject);
    socket.on("call-end", handleEnd);
    socket.on("call-timeout", handleTimeout);
    socket.on("call-unavailable", handleUnavailable);
    socket.on("missed-call", handleMissedCall);

    return () => {
      socket.off("incoming-call", handleIncomingCall);
      socket.off("call-offer", handleOffer);
      socket.off("call-answer", handleAnswer);
      socket.off("ice-candidate", handleCandidate);
      socket.off("call-reject", handleReject);
      socket.off("call-end", handleEnd);
      socket.off("call-timeout", handleTimeout);
      socket.off("call-unavailable", handleUnavailable);
      socket.off("missed-call", handleMissedCall);
    };
  }, [addOrQueueCandidate, addWebRtcLog, cleanup, flushCandidates, reportError, socket]);

  useEffect(() => () => cleanup("unmounted", false), [cleanup]);

  return {
    call,
    incomingCall,
    localVideoRef,
    remoteVideoRef,
    remoteAudioRef,
    logs,
    showDebug,
    audioBlocked,
    muted,
    cameraOff,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    cancelCall: endCall,
    toggleMute,
    toggleCamera,
    enableRemoteAudio,
    setShowDebug,
    clearLogs: () => setLogs([])
  };
}

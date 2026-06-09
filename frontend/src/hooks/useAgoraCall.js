import { useCallback, useEffect, useRef, useState } from "react";
import {
  enableAgoraRemoteAudio,
  initAgoraCall,
  leaveAgoraCall,
  setAgoraCameraOff,
  setAgoraMuted
} from "../services/agoraCallService";
import {
  agoraUidFromUserId,
  buildAgoraChannelName,
  isValidAgoraChannelName
} from "../utils/agoraChannel";

const CALL_TIMEOUT_MS = 30_000;

function createCallId() {
  return globalThis.crypto?.randomUUID?.() || `call-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeIncomingCall(payload = {}) {
  const from = payload.from || payload.callerId;
  const callType = payload.callType || (payload.isVideoCall ? "video" : "voice");
  return {
    ...payload,
    callId: payload.callId || payload.channelName,
    channelName: payload.channelName,
    from,
    callerId: from,
    callType,
    isVideoCall: callType === "video" || payload.isVideoCall === true,
    status: "ringing",
    fromUser: payload.fromUser || {
      id: from,
      name: payload.callerName || "Zee Talk user",
      email: payload.callerEmail || ""
    }
  };
}

export default function useAgoraCall({
  socket,
  currentUser,
  authToken,
  onIncomingCall,
  onOutgoingCall,
  onCallAnswered,
  onCallClosed,
  onError
}) {
  const [call, setCall] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);

  const callRef = useRef(null);
  const incomingCallRef = useRef(null);
  const callbacksRef = useRef({});
  const timeoutRef = useRef(null);
  const isLeavingRef = useRef(false);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  useEffect(() => {
    callbacksRef.current = {
      onIncomingCall,
      onOutgoingCall,
      onCallAnswered,
      onCallClosed,
      onError
    };
  }, [onIncomingCall, onOutgoingCall, onCallAnswered, onCallClosed, onError]);

  const clearCallTimer = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  const waitForVideoContainers = useCallback(async (isVideoCall) => {
    if (!isVideoCall) return {};
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (localVideoRef.current && remoteVideoRef.current) {
        return {
          localVideoContainer: localVideoRef.current,
          remoteVideoContainer: remoteVideoRef.current
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Video call screen could not be initialized.");
  }, []);

  const closeCall = useCallback(async (reason = "ended", notify = true) => {
    if (isLeavingRef.current) return;
    isLeavingRef.current = true;
    clearCallTimer();

    const closedCall = callRef.current || incomingCallRef.current;
    try {
      await leaveAgoraCall();
    } finally {
      callRef.current = null;
      incomingCallRef.current = null;
      setCall(null);
      setIncomingCall(null);
      setMuted(false);
      setCameraOff(false);
      setAudioBlocked(false);
      isLeavingRef.current = false;
      if (notify && closedCall) {
        callbacksRef.current.onCallClosed?.({ ...closedCall, reason });
      }
    }
  }, [clearCallTimer]);

  const updateCallStatus = useCallback((status) => {
    const current = callRef.current;
    if (!current) return;
    const next = {
      ...current,
      status: status === "Connected" ? "connected" : status.toLowerCase().replace(/\.+$/, "")
    };
    if (next.status === "connected") clearCallTimer();
    callRef.current = next;
    setCall(next);
  }, [clearCallTimer]);

  const joinAgora = useCallback(async (activeCall) => {
    const uid = agoraUidFromUserId(currentUser.id);
    console.log("Agora Web UID:", uid);
    const containers = await waitForVideoContainers(activeCall.isVideoCall);

    await initAgoraCall({
      channelName: activeCall.channelName,
      uid,
      authToken,
      isVideoCall: activeCall.isVideoCall,
      ...containers,
      onStatus: updateCallStatus,
      onRemoteUserJoined: () => updateCallStatus("Connected"),
      onRemoteUserLeft: async () => {
        await closeCall("Remote user left");
      },
      onError: (error) => {
        callbacksRef.current.onError?.({ action: "agora", message: error.message });
      }
    });
  }, [authToken, closeCall, currentUser?.id, updateCallStatus, waitForVideoContainers]);

  const emitCallEnded = useCallback((activeCall, reason) => {
    if (!socket || !activeCall) return;
    socket.emit("call_ended", {
      to: activeCall.peerId || activeCall.from,
      callerId: activeCall.callerId,
      receiverId: activeCall.receiverId,
      callId: activeCall.callId,
      channelName: activeCall.channelName,
      callType: activeCall.callType,
      isVideoCall: activeCall.isVideoCall,
      reason
    });
  }, [socket]);

  const endCallAndClose = useCallback(async (reason = "ended", emitSocketEvent = true) => {
    const activeCall = callRef.current || incomingCallRef.current;
    if (emitSocketEvent) emitCallEnded(activeCall, reason);
    await closeCall(reason);
  }, [closeCall, emitCallEnded]);

  const startCall = useCallback(async (peer, callType) => {
    if (!socket || !currentUser || !peer) return;
    if (callType !== "voice" && callType !== "video") {
      throw new Error("Agora calls support voice and video only.");
    }

    await closeCall("replaced", false);
    const channelName = buildAgoraChannelName(currentUser.id, peer.id);
    const callId = createCallId();
    const isVideoCall = callType === "video";
    const nextCall = {
      callId,
      channelName,
      direction: "outgoing",
      callerId: currentUser.id,
      receiverId: peer.id,
      peer,
      peerId: String(peer.id),
      callType,
      isVideoCall,
      status: "calling",
      startedAt: Date.now()
    };

    callRef.current = nextCall;
    setCall(nextCall);
    callbacksRef.current.onOutgoingCall?.(nextCall);

    try {
      const response = await new Promise((resolve, reject) => {
        socket.timeout(5000).emit(
          "incoming_call",
          {
            to: peer.id,
            callerId: currentUser.id,
            callerName: currentUser.name,
            receiverId: peer.id,
            receiverName: peer.name,
            callId,
            channelName,
            callType,
            isVideoCall
          },
          (error, result) => {
            if (error) reject(new Error("Call signaling timed out."));
            else resolve(result);
          }
        );
      });
      if (!response?.ok) {
        throw new Error(response?.reason === "offline" ? "Receiver is offline." : "Could not start call.");
      }

      await joinAgora(nextCall);
      timeoutRef.current = setTimeout(async () => {
        callbacksRef.current.onError?.({ action: "timeout", message: "No answer / Unable to connect" });
        await endCallAndClose("timeout", true);
      }, response.timeoutMs || CALL_TIMEOUT_MS);
    } catch (error) {
      emitCallEnded(nextCall, "error");
      callbacksRef.current.onError?.({ action: "startCall", message: error.message });
      await closeCall("error");
      throw error;
    }
  }, [closeCall, currentUser, emitCallEnded, endCallAndClose, joinAgora, socket]);

  const acceptCall = useCallback(async () => {
    const pendingCall = incomingCallRef.current;
    if (!socket || !currentUser || !pendingCall) return;
    if (!isValidAgoraChannelName(pendingCall.channelName)) {
      const error = new Error("Incoming call has an invalid or missing Agora channel.");
      callbacksRef.current.onError?.({ action: "acceptCall", message: error.message });
      throw error;
    }

    const activeCall = {
      ...pendingCall,
      direction: "incoming",
      peer: pendingCall.fromUser,
      peerId: String(pendingCall.from),
      receiverId: currentUser.id,
      status: "connecting",
      startedAt: Date.now()
    };
    callRef.current = activeCall;
    incomingCallRef.current = null;
    setCall(activeCall);
    setIncomingCall(null);

    try {
      await joinAgora(activeCall);
      socket.emit("call_answered", {
        to: pendingCall.from,
        callerId: pendingCall.from,
        receiverId: currentUser.id,
        callId: pendingCall.callId,
        channelName: pendingCall.channelName,
        callType: pendingCall.callType,
        isVideoCall: pendingCall.isVideoCall
      });
      callbacksRef.current.onCallAnswered?.(activeCall);
    } catch (error) {
      socket.emit("call_rejected", {
        to: pendingCall.from,
        callId: pendingCall.callId,
        channelName: pendingCall.channelName,
        callType: pendingCall.callType,
        reason: "unable-to-connect"
      });
      await closeCall("error");
      throw error;
    }
  }, [closeCall, currentUser, joinAgora, socket]);

  const rejectCall = useCallback(async () => {
    const pendingCall = incomingCallRef.current;
    if (!socket || !pendingCall) return;
    socket.emit("call_rejected", {
      to: pendingCall.from,
      callerId: pendingCall.from,
      receiverId: currentUser?.id,
      callId: pendingCall.callId,
      channelName: pendingCall.channelName,
      callType: pendingCall.callType,
      isVideoCall: pendingCall.isVideoCall
    });
    await closeCall("rejected");
  }, [closeCall, currentUser?.id, socket]);

  const toggleMute = useCallback(async () => {
    const nextMuted = !muted;
    await setAgoraMuted(nextMuted);
    setMuted(nextMuted);
  }, [muted]);

  const toggleCamera = useCallback(async () => {
    const nextCameraOff = !cameraOff;
    await setAgoraCameraOff(nextCameraOff);
    setCameraOff(nextCameraOff);
  }, [cameraOff]);

  const enableRemoteAudio = useCallback(async () => {
    const enabled = enableAgoraRemoteAudio();
    setAudioBlocked(!enabled);
    return enabled;
  }, []);

  useEffect(() => {
    if (!socket) return undefined;

    function handleIncomingCall(payload) {
      console.log("socket incoming_call received", payload);
      if (!payload?.channelName) {
        console.error("Incoming Agora call missing channelName", payload);
        return;
      }
      const pendingCall = normalizeIncomingCall(payload);
      incomingCallRef.current = pendingCall;
      setIncomingCall(pendingCall);
      callbacksRef.current.onIncomingCall?.(pendingCall);
    }

    function handleAnswered(payload) {
      if (payload?.callId && payload.callId !== callRef.current?.callId) return;
      clearCallTimer();
      updateCallStatus("Connecting...");
      callbacksRef.current.onCallAnswered?.(callRef.current);
    }

    async function handleRejected(payload) {
      if (payload?.callId && payload.callId !== callRef.current?.callId) return;
      callbacksRef.current.onError?.({ action: "rejected", message: "Call rejected" });
      await closeCall("rejected");
    }

    async function handleEnded(payload) {
      console.log("socket call_ended received", payload);
      const activeId = callRef.current?.callId || incomingCallRef.current?.callId;
      if (payload?.callId && activeId && payload.callId !== activeId) return;
      if (payload?.reason === "timeout") {
        callbacksRef.current.onError?.({ action: "timeout", message: "No answer / Unable to connect" });
      }
      await closeCall(payload?.reason || "remote-ended");
    }

    socket.on("incoming_call", handleIncomingCall);
    socket.on("call_answered", handleAnswered);
    socket.on("call_rejected", handleRejected);
    socket.on("call_ended", handleEnded);

    return () => {
      socket.off("incoming_call", handleIncomingCall);
      socket.off("call_answered", handleAnswered);
      socket.off("call_rejected", handleRejected);
      socket.off("call_ended", handleEnded);
    };
  }, [clearCallTimer, closeCall, socket, updateCallStatus]);

  useEffect(() => () => {
    clearCallTimer();
    leaveAgoraCall();
  }, [clearCallTimer]);

  return {
    call,
    incomingCall,
    localVideoRef,
    remoteVideoRef,
    audioBlocked,
    muted,
    cameraOff,
    startCall,
    acceptCall,
    rejectCall,
    endCall: () => endCallAndClose("ended", true),
    cancelCall: () => endCallAndClose("cancelled", true),
    toggleMute,
    toggleCamera,
    enableRemoteAudio
  };
}

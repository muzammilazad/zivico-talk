import AgoraRTC from "agora-rtc-sdk-ng";
import { AGORA_APP_ID, hasValidAgoraAppId } from "../config/agoraConfig";
import { api } from "../lib/api";
import { isValidAgoraChannelName } from "../utils/agoraChannel";

let client = null;
let localAudioTrack = null;
let localVideoTrack = null;
let remoteAudioTrack = null;
let leavingPromise = null;
let sessionGeneration = 0;

function log(message, details) {
  console.log(`[Agora] ${message}`, details ?? "");
}

function friendlyAgoraError(error) {
  const message = error?.message || String(error);
  if (message === "Unable to get Agora token from server.") {
    return new Error(message);
  }
  if (/token|certificate|dynamic key/i.test(message)) {
    return new Error("Unable to join Agora with the server token.");
  }
  if (/permission|notallowed|denied|device/i.test(message)) {
    return new Error("Microphone or camera permission denied");
  }
  return error instanceof Error ? error : new Error(message);
}

export async function initAgoraCall({
  channelName,
  uid,
  authToken,
  isVideoCall,
  localVideoContainer,
  remoteVideoContainer,
  onStatus,
  onRemoteUserJoined,
  onRemoteUserLeft,
  onError
}) {
  if (!hasValidAgoraAppId()) {
    throw new Error("Agora App ID missing. Paste the same App ID used in mobile app.");
  }
  if (!isValidAgoraChannelName(channelName)) {
    throw new Error("Invalid Agora channel name.");
  }

  await leaveAgoraCall();
  const generation = ++sessionGeneration;
  const assertCallIsActive = () => {
    if (generation !== sessionGeneration) {
      throw new Error("Call ended before Agora finished connecting.");
    }
  };

  try {
    console.log("Agora Web App ID loaded:", Boolean(AGORA_APP_ID));
    console.log("Agora Web App ID:", AGORA_APP_ID ? `${AGORA_APP_ID.substring(0, 6)}...` : "missing");
    console.log("Agora Web token mode: server RTC token");
    console.log("Agora Web channelName:", channelName);
    console.log("Agora Web uid:", uid);
    log("isVideoCall", isVideoCall);
    log("creating client");

    client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
    client.on("user-joined", (user) => {
      log("user-joined", user.uid);
      onRemoteUserJoined?.(user);
    });
    client.on("user-published", async (user, mediaType) => {
      try {
        log("user-published", { uid: user.uid, mediaType });
        await client.subscribe(user, mediaType);

        if (mediaType === "video" && remoteVideoContainer) {
          user.videoTrack?.play(remoteVideoContainer);
        }
        if (mediaType === "audio") {
          remoteAudioTrack = user.audioTrack;
          remoteAudioTrack?.play();
        }

        onStatus?.("Connected");
        onRemoteUserJoined?.(user);
      } catch (error) {
        const friendlyError = friendlyAgoraError(error);
        onError?.(friendlyError);
      }
    });
    client.on("user-unpublished", (user, mediaType) => {
      log("user-unpublished", { uid: user.uid, mediaType });
      if (mediaType === "audio") remoteAudioTrack = null;
    });
    client.on("user-left", (user) => {
      log("user-left", user.uid);
      onRemoteUserLeft?.(user);
    });

    onStatus?.("Connecting...");
    log("creating audio/video tracks", isVideoCall ? "microphone + camera" : "microphone");
    if (isVideoCall) {
      [localAudioTrack, localVideoTrack] = await AgoraRTC.createMicrophoneAndCameraTracks();
      assertCallIsActive();
      if (localVideoContainer) localVideoTrack.play(localVideoContainer);
    } else {
      localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
      assertCallIsActive();
    }

    log("fetching RTC token");
    let tokenFromServer;
    try {
      const tokenResponse = await api(
        `/api/agora/rtc-token?channelName=${encodeURIComponent(channelName)}&uid=${encodeURIComponent(uid)}`,
        {},
        authToken
      );
      tokenFromServer = String(tokenResponse?.token || "").trim();
      if (!tokenFromServer) throw new Error();
    } catch {
      throw new Error("Unable to get Agora token from server.");
    }
    assertCallIsActive();
    console.log("Agora Web token loaded:", Boolean(tokenFromServer));

    log("joining channel");
    // The App Certificate stays on the backend token server.
    // Do not put App Certificate in web frontend.
    await client.join(AGORA_APP_ID, channelName, tokenFromServer, uid);
    assertCallIsActive();
    log("joined channel");

    const tracks = [localAudioTrack, localVideoTrack].filter(Boolean);
    log("publishing tracks", tracks.map((track) => track.trackMediaType));
    await client.publish(tracks);
    return client;
  } catch (error) {
    const friendlyError = friendlyAgoraError(error);
    log("call setup failed", friendlyError.message);
    await leaveAgoraCall();
    onError?.(friendlyError);
    throw friendlyError;
  }
}

export async function leaveAgoraCall() {
  sessionGeneration += 1;
  if (leavingPromise) return leavingPromise;

  leavingPromise = (async () => {
    log("leave call");
    try {
      localAudioTrack?.stop();
      localAudioTrack?.close();
      localVideoTrack?.stop();
      localVideoTrack?.close();
      remoteAudioTrack?.stop();
      if (client) {
        client.removeAllListeners();
        await client.leave();
      }
    } catch (error) {
      console.warn("[Agora] cleanup failed", error);
    } finally {
      localAudioTrack = null;
      localVideoTrack = null;
      remoteAudioTrack = null;
      client = null;
      leavingPromise = null;
    }
  })();

  return leavingPromise;
}

export async function setAgoraMuted(muted) {
  if (!localAudioTrack) return;
  await localAudioTrack.setMuted(muted);
}

export async function setAgoraCameraOff(cameraOff) {
  if (!localVideoTrack) return;
  await localVideoTrack.setMuted(cameraOff);
}

export function enableAgoraRemoteAudio() {
  if (!remoteAudioTrack) return false;
  remoteAudioTrack.play();
  return true;
}

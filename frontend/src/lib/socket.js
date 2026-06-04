import { io } from "socket.io-client";
import { SOCKET_URL, assertSocketUrl } from "./config";

export function createSocket(token) {
  assertSocketUrl();

  return io(SOCKET_URL, {
    auth: { token },
    transports: ["websocket", "polling"]
  });
}

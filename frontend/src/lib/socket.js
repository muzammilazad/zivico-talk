import { io } from "socket.io-client";
import { SOCKET_URL } from "./config";

export function createSocket(token) {
  return io(SOCKET_URL, {
    auth: { token },
    transports: ["websocket", "polling"]
  });
}

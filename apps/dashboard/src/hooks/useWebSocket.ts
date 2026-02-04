"use client";

import { useContext } from "react";
import {
  WebSocketContext,
  type WebSocketContextValue,
} from "@/providers/WebSocketProvider";

export function useWebSocket(): WebSocketContextValue {
  const ctx = useContext(WebSocketContext);
  if (!ctx) {
    throw new Error("useWebSocket must be used within a WebSocketProvider");
  }
  return ctx;
}

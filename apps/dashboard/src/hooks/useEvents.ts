"use client";

import { useWebSocket } from "./useWebSocket";

export function useEvents() {
  const { events } = useWebSocket();
  return { events };
}

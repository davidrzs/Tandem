import type { HocuspocusProvider } from "@hocuspocus/provider";
import { useEffect, useState } from "react";

export interface PresencePeer {
  clientId: number;
  name: string;
  color: string;
}

/** Who else is looking at this document (awareness states minus our own). */
export function usePresence(provider: HocuspocusProvider) {
  const [peers, setPeers] = useState<PresencePeer[]>([]);
  useEffect(() => {
    const awareness = provider.awareness;
    if (!awareness) return;
    const refresh = () => {
      const states = [...awareness.getStates().entries()]
        .filter(([clientId]) => clientId !== awareness.clientID)
        .flatMap(([clientId, state]) => {
          const u = (state as { user?: { name?: string; color?: string } }).user;
          return u ? [{ clientId, name: u.name ?? "?", color: u.color ?? "#888" }] : [];
        });
      setPeers(states);
    };
    refresh();
    awareness.on("change", refresh);
    return () => awareness.off("change", refresh);
  }, [provider]);
  return peers;
}

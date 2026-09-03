"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BusStatus, DispatchResult, PublicService, ServerMessage, StateMap } from "../lib/types";

export interface Stats {
  conns: number;
  taps: Record<string, number>;
  dispatch: Record<string, DispatchResult | null>;
  bus: BusStatus;
}

interface Options {
  control?: boolean;
  token?: string;
}

const MAX_BACKOFF_MS = 8000;

/**
 * Live connection to the switchboard.
 *
 * Taps are applied locally the instant they happen so the switch never feels
 * laggy, then corrected by whatever the server broadcasts. Since every replica
 * applies changes in bus order, the server's value is always the one everyone
 * agrees on -- the optimistic value simply loses if they differ.
 */
export function useSwitchboard(services: PublicService[], options: Options = {}) {
  const { control = false, token } = options;

  const [state, setState] = useState<StateMap>(() =>
    Object.fromEntries(services.map((service) => [service.id, false])),
  );
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [armed, setArmed] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  // Read inside callbacks, where the state value would be a stale closure.
  const armedRef = useRef(false);
  const attemptRef = useRef(0);
  const retiredRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    retiredRef.current = false;

    const scheduleReconnect = (): void => {
      const attempt = attemptRef.current;
      attemptRef.current = attempt + 1;
      const delay = Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS) + Math.random() * 300;
      timerRef.current = setTimeout(connect, delay);
    };

    function connect(): void {
      if (retiredRef.current) return;

      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const query = control ? `?role=control&token=${encodeURIComponent(token ?? "")}` : "";
      const socket = new WebSocket(`${scheme}://${window.location.host}/ws${query}`);
      socketRef.current = socket;

      socket.onopen = () => {
        attemptRef.current = 0;
        setConnected(true);
      };

      socket.onmessage = (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data as string) as ServerMessage;
        } catch {
          return;
        }

        switch (message.t) {
          case "hello":
            setState(message.state);
            setArmed(message.armed);
            armedRef.current = message.armed;
            setReady(true);
            break;
          case "full":
            setState(message.state);
            setReady(true);
            break;
          case "armed":
            setArmed(message.v);
            armedRef.current = message.v;
            break;
          case "state":
            setState((prev) => ({ ...prev, [message.id]: message.v }));
            break;
          case "stats":
            setStats({
              conns: message.conns,
              taps: message.taps,
              dispatch: message.dispatch,
              bus: message.bus,
            });
            break;
          case "pong":
            break;
        }
      };

      socket.onclose = () => {
        setConnected(false);
        if (!retiredRef.current) scheduleReconnect();
      };

      socket.onerror = () => socket.close();
    }

    connect();

    return () => {
      retiredRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      socketRef.current?.close();
    };
  }, [control, token]);

  const send = useCallback((payload: unknown): void => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }, []);

  const toggle = useCallback(
    (id: string, value: boolean): void => {
      // The server enforces this too; this just avoids a pointless round trip
      // and an optimistic flip the server would immediately contradict.
      if (!armedRef.current) return;
      setState((prev) => ({ ...prev, [id]: value }));
      navigator.vibrate?.(10);
      send({ t: "toggle", id, v: value });
    },
    [send],
  );

  const force = useCallback(
    (id: string, value: boolean): void => {
      setState((prev) => ({ ...prev, [id]: value }));
      send({ t: "force", id, v: value });
    },
    [send],
  );

  /** Operator only: open or close the floor to the audience. */
  const arm = useCallback((value: boolean): void => send({ t: "arm", v: value }), [send]);

  return { state, ready, connected, armed, stats, toggle, force, arm };
}

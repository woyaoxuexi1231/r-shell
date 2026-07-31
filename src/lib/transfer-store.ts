// Module-level transfer queue store.
//
// Transfer records must survive component unmounts (hidden bottom panel,
// zen mode, layout switches), so the queues live outside React, keyed by
// connectionId. Components subscribe via useTransferQueue(), which is a thin
// useSyncExternalStore wrapper around the shared transferQueueReducer.

import { useCallback, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  transferQueueReducer,
  type TransferAction,
  type TransferItem,
} from "./transfer-queue-reducer";

/** Stable empty snapshot so useSyncExternalStore doesn't loop on `[]`. */
const EMPTY: TransferItem[] = [];

/** connectionId -> transfer queue */
const queues = new Map<string, TransferItem[]>();

/** connectionId -> subscriber callbacks */
const subscribers = new Map<string, Set<() => void>>();

/** connectionIds that currently have a transfer being processed. */
const processing = new Set<string>();

function notify(connectionId: string): void {
  const subs = subscribers.get(connectionId);
  if (subs) {
    for (const cb of subs) cb();
  }
}

/** Dispatch an action against a connection's queue (usable outside React). */
export function dispatchTransferAction(
  connectionId: string,
  action: TransferAction,
): void {
  const prev = queues.get(connectionId) ?? EMPTY;
  const next = transferQueueReducer(prev, action);
  if (next !== prev) {
    queues.set(connectionId, next);
    notify(connectionId);
  }
}

/**
 * React hook: subscribe to a connection's transfer queue.
 * Drop-in replacement for `useReducer(transferQueueReducer, [])`, but the
 * state survives component unmounts.
 */
export function useTransferQueue(
  connectionId: string,
): [TransferItem[], (action: TransferAction) => void] {
  const subscribe = useCallback(
    (callback: () => void) => {
      let subs = subscribers.get(connectionId);
      if (!subs) {
        subs = new Set();
        subscribers.set(connectionId, subs);
      }
      subs.add(callback);
      return () => {
        subs.delete(callback);
      };
    },
    [connectionId],
  );

  const getSnapshot = useCallback(
    () => queues.get(connectionId) ?? EMPTY,
    [connectionId],
  );

  const transfers = useSyncExternalStore(subscribe, getSnapshot);

  const dispatch = useCallback(
    (action: TransferAction) => dispatchTransferAction(connectionId, action),
    [connectionId],
  );

  return [transfers, dispatch];
}

/**
 * Mark a connection as processing a transfer. Returns false when a transfer
 * is already being processed for this connection (the caller must not start
 * another one). Replaces the per-component `processTransferRef` so duplicate
 * mounts of the browser can't double-start the same queue item.
 */
export function tryBeginProcessing(connectionId: string): boolean {
  if (processing.has(connectionId)) return false;
  processing.add(connectionId);
  return true;
}

/** Release the processing flag for a connection. */
export function endProcessing(connectionId: string): void {
  processing.delete(connectionId);
}

/** Payload of the Rust `transfer-progress` event (snake_case from serde). */
interface TransferProgressPayload {
  transfer_id: string;
  progress: number;
  bytes_transferred: number;
  total_bytes: number;
  speed: number;
}

let progressListenerStarted = false;

/**
 * Register the single, app-lifetime `transfer-progress` listener.
 * Idempotent — safe to call from every component mount. The backend already
 * throttles emission (~10 events/s per transfer), so each event can be
 * dispatched directly without further coalescing.
 */
export function ensureTransferProgressListener(): void {
  if (progressListenerStarted) return;
  progressListenerStarted = true;

  void listen<TransferProgressPayload>("transfer-progress", (event) => {
    const payload = event.payload;
    // Transfer ids are globally unique; find the owning connection queue.
    for (const [connectionId, items] of queues) {
      const item = items.find((i) => i.id === payload.transfer_id);
      if (!item) continue;
      // Ignore stragglers that arrive after the transfer settled.
      if (item.status !== "transferring") return;
      dispatchTransferAction(connectionId, {
        type: "PROGRESS",
        id: payload.transfer_id,
        progress: payload.progress,
        bytesTransferred: payload.bytes_transferred,
        speed: payload.speed,
      });
      return;
    }
  }).catch(() => {
    // Allow a retry on next mount if listener registration failed.
    progressListenerStarted = false;
  });
}

/** Reset all module state (for tests). */
export function resetTransferStore(): void {
  queues.clear();
  subscribers.clear();
  processing.clear();
}

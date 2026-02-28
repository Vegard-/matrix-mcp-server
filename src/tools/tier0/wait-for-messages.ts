import { z } from "zod";
import { RoomEvent, MatrixEvent, EventType } from "matrix-js-sdk";
import { createConfiguredMatrixClient, getAccessToken, getMatrixContext } from "../../utils/server-helpers.js";
import { removeClientFromCache } from "../../matrix/client.js";
import { ToolRegistrationFunction } from "../../types/tool-types.js";

const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
const DEBOUNCE_MS = 500;

// Internal cursor: tracks the last message we returned, so the catch-up scan
// works even when the caller doesn't pass a `since` token.
let lastSeenEventId: string | undefined;
let lastSeenTimestamp = 0;

function updateInternalCursor(eventId: string, timestamp: number) {
  if (timestamp > lastSeenTimestamp || (timestamp === lastSeenTimestamp && eventId !== lastSeenEventId)) {
    lastSeenEventId = eventId;
    lastSeenTimestamp = timestamp;
  }
}

interface CollectedMessage {
  roomId: string;
  roomName: string;
  sender: string;
  body: string;
  eventId: string;
  timestamp: number;
}

export const waitForMessagesHandler = async (
  { roomId, timeoutMs, since }: { roomId?: string; timeoutMs: number; since?: string },
  { requestInfo, authInfo }: any
) => {
  const { matrixUserId, homeserverUrl } = getMatrixContext(requestInfo?.headers);
  const accessToken = getAccessToken(requestInfo?.headers, authInfo?.token);

  const timeout = Math.max(timeoutMs, 1000);

  // Parse the continuation token: "eventId|timestamp"
  // Fall back to the internal cursor if the caller doesn't provide one.
  let sinceTimestamp = 0;
  let sinceEventId: string | undefined;
  if (since) {
    const parts = since.split("|");
    if (parts.length === 2) {
      sinceEventId = parts[0];
      sinceTimestamp = parseInt(parts[1], 10) || 0;
    }
  } else if (lastSeenTimestamp) {
    sinceTimestamp = lastSeenTimestamp;
    sinceEventId = lastSeenEventId;
  }

  try {
    const client = await createConfiguredMatrixClient(homeserverUrl, matrixUserId, accessToken);
    const ownUserId = client.getUserId();

    const collected: CollectedMessage[] = [];
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // --- Catch-up scan: check existing timeline for events newer than the since cursor ---
    // This closes the sync gap where messages arrive between poll cycles.
    if (sinceTimestamp) {
      const roomsToScan = roomId
        ? [client.getRoom(roomId)].filter(Boolean)
        : client.getRooms();

      for (const room of roomsToScan) {
        if (!room) continue;
        const events = room.getLiveTimeline().getEvents();
        for (const event of events) {
          if (event.getType() !== EventType.RoomMessage) continue;
          if (event.getSender() === ownUserId) continue;

          const ts = event.getTs();
          const eid = event.getId();
          if (ts < sinceTimestamp) continue;
          if (ts === sinceTimestamp && eid === sinceEventId) continue;

          const content = event.getContent();
          collected.push({
            roomId: event.getRoomId() || "",
            roomName: room.name || event.getRoomId() || "",
            sender: event.getSender() || "",
            body: String(content?.body || ""),
            eventId: eid || "",
            timestamp: ts,
          });
        }
      }

      // If we found catch-up messages, return them immediately
      if (collected.length > 0) {
        collected.sort((a, b) => a.timestamp - b.timestamp);
        const last = collected[collected.length - 1];
        updateInternalCursor(last.eventId, last.timestamp);
        const nextSince = `${last.eventId}|${last.timestamp}`;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "messages_received",
                messageCount: collected.length,
                messages: collected.map((m) => ({
                  room: m.roomName,
                  roomId: m.roomId,
                  sender: m.sender,
                  body: m.body,
                  eventId: m.eventId,
                  timestamp: new Date(m.timestamp).toISOString(),
                })),
                since: nextSince,
              }),
            },
          ],
        };
      }
    }

    const result = await new Promise<{ messages: CollectedMessage[]; timedOut: boolean }>((resolve) => {
      const onEvent = (event: MatrixEvent) => {
        // Only m.room.message events
        if (event.getType() !== EventType.RoomMessage) return;

        // Skip own messages
        if (event.getSender() === ownUserId) return;

        // Room filter
        const evtRoomId = event.getRoomId();
        if (roomId && evtRoomId !== roomId) return;

        // Skip events at or before the since cursor
        const ts = event.getTs();
        const eid = event.getId();
        if (sinceTimestamp && ts < sinceTimestamp) return;
        if (sinceTimestamp && ts === sinceTimestamp && eid === sinceEventId) return;

        const content = event.getContent();
        const room = evtRoomId ? client.getRoom(evtRoomId) : null;

        collected.push({
          roomId: evtRoomId || "",
          roomName: room?.name || evtRoomId || "",
          sender: event.getSender() || "",
          body: String(content?.body || ""),
          eventId: eid || "",
          timestamp: ts,
        });

        // Debounce: wait a bit for more messages to arrive
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          cleanup();
          resolve({ messages: collected, timedOut: false });
        }, DEBOUNCE_MS);
      };

      // Timeout handler
      const timeoutHandle = setTimeout(() => {
        cleanup();
        resolve({ messages: collected, timedOut: true });
      }, timeout);

      function cleanup() {
        client.removeListener(RoomEvent.Timeline, onEvent);
        clearTimeout(timeoutHandle);
        if (debounceTimer) clearTimeout(debounceTimer);
      }

      client.on(RoomEvent.Timeline, onEvent);
    });

    // Build continuation token from the last message
    let nextSince: string | undefined;
    if (result.messages.length > 0) {
      const last = result.messages[result.messages.length - 1];
      updateInternalCursor(last.eventId, last.timestamp);
      nextSince = `${last.eventId}|${last.timestamp}`;
    } else if (since) {
      nextSince = since; // No new messages, return same token
    }

    if (result.messages.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: result.timedOut ? "timeout" : "no_messages",
              messages: [],
              messageCount: 0,
              ...(nextSince ? { since: nextSince } : {}),
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            status: "messages_received",
            messageCount: result.messages.length,
            messages: result.messages.map((m) => ({
              room: m.roomName,
              roomId: m.roomId,
              sender: m.sender,
              body: m.body,
              eventId: m.eventId,
              timestamp: new Date(m.timestamp).toISOString(),
            })),
            since: nextSince,
          }),
        },
      ],
    };
  } catch (error: any) {
    console.error(`Failed in wait-for-messages: ${error.message}`);
    removeClientFromCache(matrixUserId, homeserverUrl);
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: Failed to wait for messages - ${error.message}`,
        },
      ],
      isError: true,
    };
  }
};

export const registerWaitForMessagesTools: ToolRegistrationFunction = (server) => {
  server.registerTool(
    "wait-for-messages",
    {
      title: "Wait for New Matrix Messages",
      description:
        "Wait for new incoming messages in real time, including direct messages. " +
        "Watches all joined rooms by default, or a specific room if roomId is provided. " +
        "Returns as soon as messages arrive (with batching) or when the timeout expires. " +
        "Use the returned `since` token on subsequent calls to avoid duplicates. " +
        "More efficient than polling get-room-messages repeatedly.",
      inputSchema: {
        roomId: z
          .string()
          .optional()
          .describe("Matrix room ID to watch. Omit to watch all joined rooms including DMs."),
        timeoutMs: z
          .number()
          .default(DEFAULT_TIMEOUT_MS)
          .describe("How long to wait in milliseconds (default 30 seconds, no upper limit)"),
        since: z
          .string()
          .optional()
          .describe("Continuation token from a previous wait-for-messages call"),
      },
    },
    waitForMessagesHandler
  );
};

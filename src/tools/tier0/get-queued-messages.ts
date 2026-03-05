import { z } from "zod";
import { ToolRegistrationFunction } from "../../types/tool-types.js";
import { getMessageQueue } from "../../matrix/messageQueue.js";

export const registerGetQueuedMessagesTools: ToolRegistrationFunction = (server) => {
  server.registerTool(
    "get-queued-messages",
    {
      title: "Get Queued Matrix Messages",
      description:
        "Retrieve queued messages, reactions, and invites. Non-blocking — returns whatever is currently queued. " +
        "Messages are marked as fetched after retrieval (won't be returned again). " +
        "Optionally filter by room ID.",
      inputSchema: {
        roomId: z
          .string()
          .optional()
          .describe("Optional room ID to fetch messages for a specific room only"),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ roomId }: { roomId?: string }) => {
      const queue = getMessageQueue();
      const contents = queue.dequeue(roomId);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            messageCount: contents.messages.length,
            reactionCount: contents.reactions.length,
            inviteCount: contents.invites.length,
            messages: contents.messages.map(m => ({
              eventId: m.eventId,
              room: m.roomName,
              roomId: m.roomId,
              sender: m.sender,
              body: m.body,
              timestamp: new Date(m.timestamp).toISOString(),
              isDM: m.isDM,
              ...(m.threadRootEventId ? { threadRootEventId: m.threadRootEventId } : {}),
              ...(m.replyToEventId ? { replyToEventId: m.replyToEventId } : {}),
              ...(m.decryptionFailed ? { decryptionFailed: true } : {}),
              ...(m.decryptionFailureReason ? { decryptionFailureReason: m.decryptionFailureReason } : {}),
            })),
            reactions: contents.reactions.map(r => ({
              eventId: r.eventId,
              room: r.roomName,
              roomId: r.roomId,
              sender: r.sender,
              emoji: r.emoji,
              reactedToEventId: r.reactedToEventId,
              timestamp: new Date(r.timestamp).toISOString(),
            })),
            invites: contents.invites.map(i => ({
              roomId: i.roomId,
              roomName: i.roomName,
              invitedBy: i.invitedBy,
              timestamp: new Date(i.timestamp).toISOString(),
            })),
          }),
        }],
      };
    }
  );
};

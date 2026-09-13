import { DevicApiError } from '../errors.js';
import type { DevicApiClient } from '../client.js';
import type { RealtimeChatHistory, AssistantSpecialization } from '../types.js';

export class ConversationFailure extends Error {}

export function requireActiveAssistant(assistant: AssistantSpecialization): void {
  if (assistant.state === 'inactive') throw new ConversationFailure(
    `Assistant "${assistant.name}" is archived. Unarchive it in Devic or choose an active assistant. /follow only reads the existing execution; it does not retry it.`,
  );
}

export async function explainFailure(client: DevicApiClient, identifier: string, snapshot: RealtimeChatHistory): Promise<ConversationFailure> {
  const error = snapshot.error;
  const detail = snapshot.limitExceeded?.message || snapshot.errorMessage ||
    (typeof error === 'string' ? error : error?.message) ||
    (snapshot.stopReason && snapshot.stopReason !== 'error' ? snapshot.stopReason : undefined);
  if (!detail) {
    try { requireActiveAssistant(await client.getAssistant(identifier)); }
    catch (error) { if (error instanceof ConversationFailure) return error; }
  }
  return new ConversationFailure(`${detail || 'The cloud execution failed. The API did not include a reason.'} /follow only reads its state. Use /status for the conversation ID; after fixing the cause, send a new message or use /new.`);
}

/** A resource 404 does not imply that the server lacks the compaction route. */
export function compactionNotFound(error: unknown): string | undefined {
  if (!(error instanceof DevicApiError) || error.statusCode !== 404) return;
  if (/^Cannot POST \/api\/v1\/assistants\/[^/]+\/chats\/[^/]+\/compact(?:\?.*)?$/i.test(error.message)) {
    return 'This API does not expose the compaction endpoint yet. It requires the updated backend.';
  }
  return `Compaction failed: ${error.message}. The conversation may not exist or may be outside the selected assistant or current account/user scope. Check /status or choose an accessible chat with /conversations.`;
}

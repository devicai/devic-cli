import { Command } from 'commander';
import { createClient, withAction, readJsonInput } from '../helpers.js';
import { md } from '../output.js';
import type { FeedbackEntry } from '../types.js';

function formatFeedback(f: FeedbackEntry): string {
  const sentiment = f.feedback === true ? '[OK] Positive' : f.feedback === false ? '[XX] Negative' : '[--] Neutral';
  const lines = [
    `- ${md.b(sentiment)} (message: ${md.code(f.requestId)})`,
  ];
  if (f.feedbackComment) lines.push(`  Comment: ${f.feedbackComment}`);
  if (f.creationTimestamp) lines.push(`  Date: ${new Date(f.creationTimestamp).toLocaleString()}`);
  return lines.join('\n');
}

function formatFeedbackList(items: FeedbackEntry[]): string {
  if (items.length === 0) return '_No feedback found._';
  const positive = items.filter(f => f.feedback === true).length;
  const negative = items.filter(f => f.feedback === false).length;
  return [
    md.h(2, 'Feedback'),
    '',
    `**Total:** ${items.length} | **Positive:** ${positive} | **Negative:** ${negative}`,
    '',
    ...items.map(formatFeedback),
  ].join('\n');
}

export function registerFeedbackCommands(program: Command): void {
  const feedback = program.command('feedback').description('Submit and view feedback');

  // feedback submit-chat <identifier> <chatUid>
  feedback
    .command('submit-chat <identifier> <chatUid>')
    .description('Submit feedback for a chat message')
    .requiredOption('--message-id <id>', 'Message UID to give feedback on')
    .option('--positive', 'Positive feedback (thumbs up)')
    .option('--negative', 'Negative feedback (thumbs down)')
    .option('--comment <text>', 'Feedback comment')
    .option('--from-json <file>', 'Read full feedback from JSON file (- for stdin)')
    .action(
      withAction(async (identifier: unknown, chatUid: unknown, opts: unknown) => {
        const o = opts as {
          messageId: string; positive?: boolean; negative?: boolean;
          comment?: string; fromJson?: string;
        };
        const client = createClient();

        let data: Record<string, unknown>;
        if (o.fromJson) {
          data = await readJsonInput(o.fromJson);
          if (!data.messageId) data.messageId = o.messageId;
        } else {
          data = { messageId: o.messageId };
          if (o.positive) data.feedback = true;
          if (o.negative) data.feedback = false;
          if (o.comment) data.feedbackComment = o.comment;
        }

        return client.submitChatFeedback(identifier as string, chatUid as string, data as any);
      }, (d) => {
        const f = d as FeedbackEntry;
        return [
          md.success('Feedback submitted for chat.'),
          '',
          formatFeedback(f),
        ].join('\n');
      }),
    );

  // feedback list-chat <identifier> <chatUid>
  feedback
    .command('list-chat <identifier> <chatUid>')
    .description('List feedback for a chat')
    .action(
      withAction(async (identifier: unknown, chatUid: unknown) => {
        const client = createClient();
        return client.getChatFeedback(identifier as string, chatUid as string);
      }, (d) => formatFeedbackList(d as FeedbackEntry[])),
    );

  // feedback submit-thread <threadId>
  feedback
    .command('submit-thread <threadId>')
    .description('Submit feedback for a thread message')
    .requiredOption('--message-id <id>', 'Message UID to give feedback on')
    .option('--positive', 'Positive feedback (thumbs up)')
    .option('--negative', 'Negative feedback (thumbs down)')
    .option('--comment <text>', 'Feedback comment')
    .option('--from-json <file>', 'Read full feedback from JSON file (- for stdin)')
    .action(
      withAction(async (threadId: unknown, opts: unknown) => {
        const o = opts as {
          messageId: string; positive?: boolean; negative?: boolean;
          comment?: string; fromJson?: string;
        };
        const client = createClient();

        let data: Record<string, unknown>;
        if (o.fromJson) {
          data = await readJsonInput(o.fromJson);
          if (!data.messageId) data.messageId = o.messageId;
        } else {
          data = { messageId: o.messageId };
          if (o.positive) data.feedback = true;
          if (o.negative) data.feedback = false;
          if (o.comment) data.feedbackComment = o.comment;
        }

        return client.submitThreadFeedback(threadId as string, data as any);
      }, (d) => {
        const f = d as FeedbackEntry;
        return [
          md.success('Feedback submitted for thread.'),
          '',
          formatFeedback(f),
        ].join('\n');
      }),
    );

  // feedback list-thread <threadId>
  feedback
    .command('list-thread <threadId>')
    .description('List feedback for a thread')
    .action(
      withAction(async (threadId: unknown) => {
        const client = createClient();
        return client.getThreadFeedback(threadId as string);
      }, (d) => formatFeedbackList(d as FeedbackEntry[])),
    );
}

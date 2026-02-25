import { Command } from 'commander';
import { createClient, withAction, addListOptions, parseListOpts, readJsonInput } from '../helpers.js';
import { pollThread } from '../polling.js';
import { md } from '../output.js';
import type { AgentDto, AgentThreadDto } from '../types.js';

function formatAgent(a: AgentDto): string {
  const lines = [
    md.h(2, `Agent: ${a.name}`),
    '',
    `**ID:** ${md.code(a._id || a.agentId || '-')}`,
    `**Name:** ${a.name}`,
  ];
  if (a.description) lines.push(`**Description:** ${a.description}`);
  if (a.provider) lines.push(`**Provider:** ${a.provider}`);
  if (a.llm) lines.push(`**LLM:** ${a.llm}`);
  if (a.disabled != null) lines.push(`**Disabled:** ${a.disabled ? 'Yes' : 'No'}`);
  if (a.archived != null) lines.push(`**Archived:** ${a.archived ? 'Yes' : 'No'}`);
  if (a.maxExecutionInputTokens) lines.push(`**Max Input Tokens:** ${a.maxExecutionInputTokens.toLocaleString()}`);
  if (a.maxExecutionToolCalls) lines.push(`**Max Tool Calls:** ${a.maxExecutionToolCalls}`);
  if (a.creationTimestampMs) lines.push(`**Created:** ${new Date(a.creationTimestampMs).toLocaleString()}`);
  if (a.assistantSpecialization) {
    lines.push('', md.h(3, 'Specialization'), md.codeBlock(JSON.stringify(a.assistantSpecialization, null, 2), 'json'));
  }
  return lines.join('\n');
}

function formatThread(t: AgentThreadDto): string {
  const lines = [
    md.h(2, `Thread: ${t.name || t._id || '-'}`),
    '',
    `**ID:** ${md.code(t._id || '-')}`,
    `**Agent:** ${md.code(t.agentId)}`,
    `**State:** ${md.status(t.state)} ${t.state}`,
  ];
  if (t.finishReason) lines.push(`**Finish Reason:** ${t.finishReason}`);
  if (t.pausedReason) lines.push(`**Paused Reason:** ${t.pausedReason}`);
  if (t.creationTimestampMs) lines.push(`**Created:** ${new Date(t.creationTimestampMs).toLocaleString()}`);
  if (t.lastEditTimestampMs) lines.push(`**Updated:** ${new Date(t.lastEditTimestampMs).toLocaleString()}`);
  if (t.isSubthread) {
    lines.push(`**Subthread:** Yes (parent: ${md.code(t.parentThreadId ?? '?')})`);
  }
  if (t.pendingHandOffSubThreadIds && t.pendingHandOffSubThreadIds.length > 0) {
    lines.push(`**Pending Subthreads:** ${t.pendingHandOffSubThreadIds.map(id => md.code(id)).join(', ')}`);
  }

  if (t.tasks && t.tasks.length > 0) {
    lines.push('', md.h(3, 'Tasks'));
    for (const task of t.tasks) {
      const check = task.completed ? '[x]' : '[ ]';
      lines.push(`- ${check} ${task.title || task.description || '(untitled)'}`);
    }
  }

  if (t.threadContent && t.threadContent.length > 0) {
    lines.push('', md.hr(), '', md.conversation(t.threadContent));
  }
  return lines.join('\n');
}

export function registerAgentCommands(program: Command): void {
  const agents = program.command('agents').description('Manage agents and threads');

  // agents list
  addListOptions(
    agents
      .command('list')
      .description('List all agents')
      .option('--archived', 'Include archived agents'),
  ).action(
    withAction(async (opts: unknown) => {
      const o = opts as { offset?: string; limit?: string; archived?: boolean };
      const client = createClient();
      return client.listAgents({ ...parseListOpts(o), archived: o.archived });
    }, (d) => {
      const data = d as any;
      const items = data.agents ?? (Array.isArray(data) ? data : []);
      if (items.length === 0) return '_No agents found._';
      const lines = [
        md.h(2, 'Agents'),
        '',
        md.table(items.map((a: any) => ({
          id: a._id || a.agentId,
          name: a.name,
          description: (a.description || '-').slice(0, 50),
          provider: a.provider || '-',
          llm: a.llm || '-',
          disabled: a.disabled ?? false,
        })), { columns: ['id', 'name', 'description', 'provider', 'llm', 'disabled'] }),
      ];
      if (data.total != null) lines.push(md.pagination(data));
      return lines.join('\n');
    }),
  );

  // agents get <agentId>
  agents
    .command('get <agentId>')
    .description('Get agent details')
    .action(withAction(async (agentId: unknown) => {
      const client = createClient();
      return client.getAgent(agentId as string);
    }, (d) => formatAgent(d as AgentDto)));

  // agents create
  agents
    .command('create')
    .description('Create a new agent')
    .option('--name <name>', 'Agent name')
    .option('--description <desc>', 'Agent description')
    .option('--from-json <file>', 'Read full agent config from JSON file (- for stdin)')
    .action(
      withAction(async (opts: unknown) => {
        const o = opts as { name?: string; description?: string; fromJson?: string };
        const client = createClient();
        let data: Record<string, unknown>;
        if (o.fromJson) {
          data = await readJsonInput(o.fromJson);
        } else {
          data = {};
          if (o.name) data.name = o.name;
          if (o.description) data.description = o.description;
        }
        return client.createAgent(data);
      }, (d) => {
        const a = d as AgentDto;
        return [md.success(`Agent created: ${md.b(a.name)}`), '', formatAgent(a)].join('\n');
      }),
    );

  // agents update <agentId>
  agents
    .command('update <agentId>')
    .description('Update an agent')
    .option('--name <name>', 'Agent name')
    .option('--description <desc>', 'Agent description')
    .option('--from-json <file>', 'Read update payload from JSON file (- for stdin)')
    .action(
      withAction(async (agentId: unknown, opts: unknown) => {
        const o = opts as { name?: string; description?: string; fromJson?: string };
        const client = createClient();
        let data: Record<string, unknown>;
        if (o.fromJson) {
          data = await readJsonInput(o.fromJson);
        } else {
          data = {};
          if (o.name) data.name = o.name;
          if (o.description) data.description = o.description;
        }
        return client.updateAgent(agentId as string, data);
      }, (d) => {
        const a = d as AgentDto;
        return [md.success(`Agent updated: ${md.b(a.name)}`), '', formatAgent(a)].join('\n');
      }),
    );

  // agents delete <agentId>
  agents
    .command('delete <agentId>')
    .description('Delete an agent')
    .action(
      withAction(async (agentId: unknown) => {
        const client = createClient();
        return client.deleteAgent(agentId as string);
      }, (d) => {
        const r = d as any;
        return md.success(r.message || `Agent ${md.code(r.deletedId || '')} deleted.`);
      }),
    );

  // ── Threads ──

  const threads = agents.command('threads').description('Manage agent execution threads');

  // agents threads create <agentId>
  threads
    .command('create <agentId>')
    .description('Create a new thread')
    .requiredOption('-m, --message <text>', 'Initial message/task')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--wait', 'Poll for thread completion')
    .option('--from-json <file>', 'Read thread config from JSON file (- for stdin)')
    .action(
      withAction(async (agentId: unknown, opts: unknown) => {
        const o = opts as { message: string; tags?: string; wait?: boolean; fromJson?: string };
        const client = createClient();

        let data: Record<string, unknown>;
        if (o.fromJson) {
          data = await readJsonInput(o.fromJson);
          if (!data.message) data.message = o.message;
        } else {
          data = {
            message: o.message,
            ...(o.tags && { tags: o.tags.split(',').map(t => t.trim()) }),
          };
        }

        const result = await client.createThread(agentId as string, data as any);

        if (o.wait) {
          const threadResult = result as { threadId?: string; _id?: string };
          const threadId = threadResult.threadId ?? threadResult._id;
          if (!threadId) return result;
          return pollThread(client, threadId);
        }

        return result;
      }, (d) => {
        const t = d as any;
        if (t.threadContent) return formatThread(t as AgentThreadDto);
        // Initial creation response
        const id = t.threadId ?? t._id ?? '-';
        return [
          md.success(`Thread created: ${md.code(id)}`),
          '',
          `**Agent:** ${md.code(t.agentId || '-')}`,
          `**State:** ${md.status(t.state || 'queued')} ${t.state || 'queued'}`,
        ].join('\n');
      }),
    );

  // agents threads list <agentId>
  addListOptions(
    threads
      .command('list <agentId>')
      .description('List threads for an agent')
      .option('--state <state>', 'Filter by thread state')
      .option('--start-date <date>', 'Start date filter')
      .option('--end-date <date>', 'End date filter')
      .option('--date-order <order>', 'Sort by date (asc|desc)')
      .option('--tags <tags>', 'Comma-separated tags'),
  ).action(
    withAction(async (agentId: unknown, opts: unknown) => {
      const o = opts as {
        offset?: string; limit?: string; state?: string;
        startDate?: string; endDate?: string; dateOrder?: string; tags?: string;
      };
      const client = createClient();
      return client.listThreads(agentId as string, {
        ...parseListOpts(o),
        state: o.state,
        startDate: o.startDate,
        endDate: o.endDate,
        dateOrder: o.dateOrder,
        tags: o.tags,
      });
    }, (d) => {
      const data = d as any;
      const items = data.threads ?? (Array.isArray(data) ? data : []);
      if (items.length === 0) return '_No threads found._';
      const lines = [
        md.h(2, 'Threads'),
        '',
        md.table(items.map((t: any) => ({
          id: t.threadId ?? t._id,
          state: `${md.status(t.state)} ${t.state}`,
          message: (t.message || t.name || '-').slice(0, 40),
          created: t.createdAt ?? (t.creationTimestampMs ? new Date(t.creationTimestampMs).toLocaleString() : '-'),
        })), { columns: ['id', 'state', 'message', 'created'] }),
      ];
      if (data.total != null) lines.push(md.pagination(data));
      return lines.join('\n');
    }),
  );

  // agents threads get <threadId>
  threads
    .command('get <threadId>')
    .description('Get thread details')
    .option('--with-tasks', 'Include tasks in response')
    .action(
      withAction(async (threadId: unknown, opts: unknown) => {
        const o = opts as { withTasks?: boolean };
        const client = createClient();
        return client.getThread(threadId as string, o.withTasks);
      }, (d) => formatThread(d as AgentThreadDto)),
    );

  // agents threads approve <threadId>
  threads
    .command('approve <threadId>')
    .description('Approve a thread waiting for approval')
    .option('-m, --message <text>', 'Approval message')
    .action(
      withAction(async (threadId: unknown, opts: unknown) => {
        const o = opts as { message?: string };
        const client = createClient();
        return client.handleApproval(threadId as string, true, o.message);
      }, () => md.success('Thread approved.')),
    );

  // agents threads reject <threadId>
  threads
    .command('reject <threadId>')
    .description('Reject a thread waiting for approval')
    .option('-m, --message <text>', 'Rejection message')
    .action(
      withAction(async (threadId: unknown, opts: unknown) => {
        const o = opts as { message?: string };
        const client = createClient();
        return client.handleApproval(threadId as string, false, o.message);
      }, () => md.success('Thread rejected.')),
    );

  // agents threads pause <threadId>
  threads
    .command('pause <threadId>')
    .description('Pause a running thread')
    .action(
      withAction(async (threadId: unknown) => {
        const client = createClient();
        return client.pauseThread(threadId as string);
      }, () => md.success('Thread paused.')),
    );

  // agents threads resume <threadId>
  threads
    .command('resume <threadId>')
    .description('Resume a paused thread')
    .action(
      withAction(async (threadId: unknown) => {
        const client = createClient();
        return client.resumeThread(threadId as string);
      }, () => md.success('Thread resumed.')),
    );

  // agents threads complete <threadId>
  threads
    .command('complete <threadId>')
    .description('Manually complete a thread')
    .requiredOption('--state <state>', 'Final state (COMPLETED|FAILED|CANCELLED|TERMINATED)')
    .action(
      withAction(async (threadId: unknown, opts: unknown) => {
        const o = opts as { state: string };
        const client = createClient();
        return client.completeThread(threadId as string, o.state);
      }, (_d, ...args: unknown[]) => md.success('Thread completed.')),
    );

  // agents threads evaluate <threadId>
  threads
    .command('evaluate <threadId>')
    .description('Trigger evaluation of a completed thread')
    .action(
      withAction(async (threadId: unknown) => {
        const client = createClient();
        return client.evaluateThread(threadId as string);
      }, (d) => {
        const data = d as any;
        const ev = data.evaluation ?? data;
        const lines = [md.h(2, 'Thread Evaluation'), ''];
        if (ev.overallScore != null) lines.push(`**Overall Score:** ${ev.overallScore}/10`);
        if (ev.generalFeedback) lines.push(`**Feedback:** ${ev.generalFeedback}`);
        if (ev.criteria) {
          lines.push('', md.h(3, 'Criteria'));
          for (const [name, c] of Object.entries(ev.criteria)) {
            const crit = c as any;
            lines.push(`- **${name}:** ${crit.score}/10 — ${crit.reasoning}`);
          }
        }
        return lines.join('\n');
      }),
    );

  // ── Costs ──

  const costs = agents.command('costs').description('Agent cost tracking');

  costs
    .command('daily <agentId>')
    .description('Get daily cost breakdown')
    .option('--start-date <date>', 'Start date (YYYY-MM-DD)')
    .option('--end-date <date>', 'End date (YYYY-MM-DD)')
    .action(
      withAction(async (agentId: unknown, opts: unknown) => {
        const o = opts as { startDate?: string; endDate?: string };
        const client = createClient();
        return client.getDailyCosts(agentId as string, o);
      }, (d) => {
        const items = Array.isArray(d) ? d : [];
        if (items.length === 0) return '_No cost data._';
        return [
          md.h(2, 'Daily Costs'),
          '',
          md.table(items, { columns: ['date', 'totalCost', 'inputTokens', 'outputTokens', 'threadCount'] }),
        ].join('\n');
      }),
    );

  costs
    .command('monthly <agentId>')
    .description('Get monthly cost breakdown')
    .option('--start-month <month>', 'Start month (YYYY-MM)')
    .option('--end-month <month>', 'End month (YYYY-MM)')
    .action(
      withAction(async (agentId: unknown, opts: unknown) => {
        const o = opts as { startMonth?: string; endMonth?: string };
        const client = createClient();
        return client.getMonthlyCosts(agentId as string, o);
      }, (d) => {
        const items = Array.isArray(d) ? d : [];
        if (items.length === 0) return '_No cost data._';
        return [
          md.h(2, 'Monthly Costs'),
          '',
          md.table(items),
        ].join('\n');
      }),
    );

  costs
    .command('summary <agentId>')
    .description('Get cost summary (today + current month)')
    .action(
      withAction(async (agentId: unknown) => {
        const client = createClient();
        return client.getCostSummary(agentId as string);
      }, (d) => {
        const data = d as any;
        const lines = [md.h(2, 'Cost Summary'), ''];
        if (data.today) {
          lines.push(
            md.h(3, 'Today'),
            `**Cost:** $${data.today.totalCost?.toFixed(2) ?? '0.00'}`,
            `**Tokens:** ${data.today.inputTokens ?? 0} in / ${data.today.outputTokens ?? 0} out`,
            `**Threads:** ${data.today.threadCount ?? 0}`,
            '',
          );
        }
        if (data.currentMonth) {
          lines.push(
            md.h(3, 'Current Month'),
            `**Cost:** $${data.currentMonth.totalCost?.toFixed(2) ?? '0.00'}`,
            `**Tokens:** ${data.currentMonth.inputTokens ?? 0} in / ${data.currentMonth.outputTokens ?? 0} out`,
            `**Threads:** ${data.currentMonth.threadCount ?? 0}`,
          );
        }
        return lines.join('\n');
      }),
    );
}

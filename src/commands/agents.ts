import { Command } from 'commander';
import { createClient, withAction, addListOptions, parseListOpts, readJsonInput } from '../helpers.js';
import { pollThread } from '../polling.js';

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
    }),
  );

  // agents get <agentId>
  agents
    .command('get <agentId>')
    .description('Get agent details')
    .action(
      withAction(async (agentId: unknown) => {
        const client = createClient();
        return client.getAgent(agentId as string);
      }),
    );

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
      }),
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
      }),
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
      }),
    );

  // agents threads pause <threadId>
  threads
    .command('pause <threadId>')
    .description('Pause a running thread')
    .action(
      withAction(async (threadId: unknown) => {
        const client = createClient();
        return client.pauseThread(threadId as string);
      }),
    );

  // agents threads resume <threadId>
  threads
    .command('resume <threadId>')
    .description('Resume a paused thread')
    .action(
      withAction(async (threadId: unknown) => {
        const client = createClient();
        return client.resumeThread(threadId as string);
      }),
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
      }),
    );

  // agents threads evaluate <threadId>
  threads
    .command('evaluate <threadId>')
    .description('Trigger evaluation of a completed thread')
    .action(
      withAction(async (threadId: unknown) => {
        const client = createClient();
        return client.evaluateThread(threadId as string);
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
      }),
    );

  costs
    .command('summary <agentId>')
    .description('Get cost summary (today + current month)')
    .action(
      withAction(async (agentId: unknown) => {
        const client = createClient();
        return client.getCostSummary(agentId as string);
      }),
    );
}

import { Command } from 'commander';
import { createClient, withAction } from '../helpers.js';
import { md } from '../output.js';
import { DevicCliError } from '../errors.js';
import { dataObject, itemsOf } from './workspace-shared.js';

function automationsTable(d: unknown): string {
  const items = itemsOf(d, 'automations');
  if (!items.length) return '_No automations._';
  return md.table(items.map((a: any) => ({
    id: a.id ?? a._id,
    name: a.name ?? a.title,
    status: a.status ?? (a.active === true ? 'active' : a.active === false ? 'paused' : undefined),
    schedule: typeof a.schedule === 'string' ? a.schedule : a.schedule?.cron ?? a.schedule?.description,
    nextRunAt: a.nextRunAt,
  })), { columns: ['id', 'name', 'status', 'schedule', 'nextRunAt'] });
}

function runsTable(d: unknown): string {
  const items = itemsOf(d, 'runs');
  if (!items.length) return '_No runs._';
  const lines = [md.table(items.map((r: any) => ({
    id: r.id ?? r._id,
    automation: r.automationId,
    status: r.status ? `${md.status(r.status)} ${r.status}` : undefined,
    trigger: r.trigger ?? r.reason,
    startedAt: r.startedAt ?? r.createdAt,
  })), { columns: ['id', 'automation', 'status', 'trigger', 'startedAt'] })];
  if (d && typeof d === 'object' && !Array.isArray(d)) lines.push(md.pagination(d as any));
  return lines.join('\n');
}

function intOption(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new DevicCliError(`${flag} must be a non-negative integer.`, 'INVALID_USAGE');
  return Number(value);
}

/** `--query key=value` pairs, passed through untouched. */
function collectQuery(value: string, prev: string[] = []): string[] {
  return [...prev, value];
}

export function registerWorkspaceAutomationCommands(ws: Command): void {
  const automations = ws.command('automations').description('Scheduled and on-demand automations of a workspace');

  automations
    .command('list <wid>')
    .description('List automations')
    .action(withAction(async (wid: unknown) => createClient().listWorkspaceAutomations(wid as string), automationsTable));

  automations
    .command('get <wid> <automationId>')
    .description('Show one automation')
    .action(withAction(async (wid: unknown, id: unknown) =>
      createClient().getWorkspaceAutomation(wid as string, id as string)));

  automations
    .command('create <wid>')
    .description('Create an empty draft (then: automations draft <wid> <id> --data plan.json)')
    .option('--name <name>', 'Name of the automation')
    .option('--source-thread <tid>', 'Thread of this workspace the request came from')
    .option('--data <json|file|->', 'Full body ({name, sourceThreadId})')
    .action(withAction(async (wid: unknown, opts: unknown) => {
      const o = opts as { name?: string; sourceThread?: string; data?: string };
      const body = await dataObject(o.data);
      if (o.name !== undefined) body.name = o.name;
      if (o.sourceThread !== undefined) body.sourceThreadId = o.sourceThread;
      return createClient().createWorkspaceAutomation(wid as string, body);
    },
    (d) => md.success(`Automation created: ${md.code(String((d as any)?.id ?? (d as any)?.automation?.id ?? '-'))}`)));

  automations
    .command('update <wid> <automationId>')
    .description('Change an automation\'s settings (PATCH .../settings)')
    .requiredOption('--data <json|file|->', 'Settings to change')
    .action(withAction(async (wid: unknown, id: unknown, opts: unknown) =>
      createClient().updateWorkspaceAutomationSettings(
        wid as string, id as string, await dataObject((opts as { data: string }).data),
      ), () => md.success('Automation updated.')));

  automations
    .command('delete <wid> <automationId>')
    .description('Delete an automation')
    .action(withAction(async (wid: unknown, id: unknown) =>
      createClient().deleteWorkspaceAutomation(wid as string, id as string),
    () => md.success('Automation deleted.')));

  automations
    .command('activate <wid> <automationId>')
    .description('Approve and turn on a draft version (a person\'s decision: review the plan first)')
    .option('--draft-version <n>', 'draftVersion to approve (default: the current one)')
    .option('--included', 'Use the included model from `automations capabilities`')
    .option('--provider <provider>', 'Model provider (with the account\'s own key)')
    .option('--model <model>', 'Model id')
    .option('--max-input-tokens <n>', 'Input limit per event / tool result')
    .option('--data <json|file|->', 'Full body ({version, modelAccess, provider, model, maxInputTokens})')
    .action(withAction(async (wid: unknown, id: unknown, opts: unknown) => {
      const o = opts as {
        draftVersion?: string; included?: boolean; provider?: string; model?: string; maxInputTokens?: string; data?: string;
      };
      const client = createClient();
      const body = await dataObject(o.data);
      if (o.included) {
        const caps = (await client.getWorkspaceAutomationCapabilities(wid as string)) as any;
        if (!caps?.includedModel) throw new DevicCliError('No included model on this account: pass --provider and --model.', 'INVALID_USAGE');
        Object.assign(body, caps.includedModel);
      }
      if (o.provider !== undefined) Object.assign(body, { provider: o.provider, modelAccess: body.modelAccess ?? 'byok' });
      if (o.model !== undefined) body.model = o.model;
      if (o.maxInputTokens !== undefined) body.maxInputTokens = intOption(o.maxInputTokens, '--max-input-tokens');
      if (o.draftVersion !== undefined) body.version = intOption(o.draftVersion, '--draft-version');
      if (body.version === undefined) {
        const current = (await client.getWorkspaceAutomation(wid as string, id as string)) as any;
        body.version = current?.draftVersion;
      }
      if (!body.provider || !body.model) throw new DevicCliError('Pass --included, or --provider and --model.', 'INVALID_USAGE');
      return client.runWorkspaceAutomationAction(wid as string, id as string, 'activate', body);
    }));

  for (const [action, help] of [
    ['pause', 'Pause an automation'],
    ['invoke', 'Run an active on-demand automation from a thread ({clientRequestId, threadId, input?})'],
    ['test', 'Run the approved version of an active scheduled automation now ({operationId}); a real run'],
  ] as const) {
    automations
      .command(`${action} <wid> <automationId>`)
      .description(help)
      .option('--data <json|file|->', 'Optional request body')
      .action(withAction(async (wid: unknown, id: unknown, opts: unknown) =>
        createClient().runWorkspaceAutomationAction(
          wid as string, id as string, action, await dataObject((opts as { data?: string }).data),
        )));
  }

  // ── Compose a draft: the designer's own read tools ──
  automations
    .command('capabilities <wid>')
    .description('Sources this account can use and the included model to activate with')
    .action(withAction(async (wid: unknown) => createClient().getWorkspaceAutomationCapabilities(wid as string)));

  automations
    .command('destinations <wid>')
    .description('Workspaces this automation may post to (targetWorkspaceId)')
    .action(withAction(async (wid: unknown) => createClient().listWorkspaceAutomationDestinations(wid as string)));

  automations
    .command('destination-assistants <wid> <target>')
    .description('Assistants of a destination, for targetAssistantId')
    .action(withAction(async (wid: unknown, target: unknown) =>
      createClient().listWorkspaceAutomationDestinationAssistants(wid as string, target as string)));

  automations
    .command('find-threads <wid> <target>')
    .description('Search threads of one destination (source ids in message text with --search-in messages --mode literal)')
    .option('--query <text>', 'Keywords, source id, literal text or regex')
    .option('--mode <mode>', 'keywords | literal | regex | list')
    .option('--search-in <where>', 'titles | messages | all')
    .option('--match <how>', 'all | any')
    .option('--limit <n>', '1-50')
    .option('--before <cursor>', 'nextCursor of the previous page')
    .action(withAction(async (wid: unknown, target: unknown, opts: unknown) => {
      const o = opts as { query?: string; mode?: string; searchIn?: string; match?: string; limit?: string; before?: string };
      return createClient().findWorkspaceAutomationThreads(wid as string, target as string, {
        query: o.query, mode: o.mode, searchIn: o.searchIn, match: o.match, limit: o.limit, before: o.before,
      });
    }));

  automations
    .command('read-thread <wid> <target> <tid>')
    .description('Latest public messages of a destination thread')
    .option('--query <text>', 'Literal filter (source id or phrase)')
    .option('--limit <n>', '1-50')
    .option('--before-seq <n>', 'Older page')
    .option('--after-seq <n>', 'Forward scan from this seq')
    .action(withAction(async (wid: unknown, target: unknown, tid: unknown, opts: unknown) => {
      const o = opts as { query?: string; limit?: string; beforeSeq?: string; afterSeq?: string };
      return createClient().readWorkspaceAutomationThread(wid as string, target as string, tid as string, {
        query: o.query, limit: o.limit, beforeSeq: o.beforeSeq, afterSeq: o.afterSeq,
      });
    }));

  automations
    .command('connections <wid>')
    .description('Connected accounts eligible for this workspace\'s automations')
    .action(withAction(async (wid: unknown) => createClient().listWorkspaceAutomationConnections(wid as string)));

  automations
    .command('connection-tools <wid> <connectionId>')
    .description('Exact tool names of an account, for connections[].externalTools')
    .action(withAction(async (wid: unknown, cid: unknown) =>
      createClient().listWorkspaceAutomationConnectionTools(wid as string, cid as string)));

  automations
    .command('triggers <wid>')
    .description('Search app events of one integration')
    .requiredOption('--integration <app>', 'App slug, e.g. gmail')
    .option('--query <text>', 'What the event is about')
    .option('--cursor <cursor>', 'Next page')
    .action(withAction(async (wid: unknown, opts: unknown) => {
      const o = opts as { integration: string; query?: string; cursor?: string };
      return createClient().searchWorkspaceAutomationTriggers(wid as string, {
        integration: o.integration, query: o.query, cursor: o.cursor,
      });
    }));

  automations
    .command('trigger <wid> <slug>')
    .description('Configuration and payload schema of an app event, with provider setup instructions')
    .action(withAction(async (wid: unknown, slug: unknown) =>
      createClient().getWorkspaceAutomationTrigger(wid as string, slug as string)));

  automations
    .command('draft <wid> <automationId>')
    .description('Validate a plan and save it as the next draft version (never activates)')
    .requiredOption('--data <json|file|->', 'Plan: name, instructions, targetWorkspaceId, source | trigger, connections')
    .option('--draft-version <n>', 'Current draftVersion; a concurrent edit returns 409')
    .action(withAction(async (wid: unknown, id: unknown, opts: unknown) => {
      const o = opts as { data: string; draftVersion?: string };
      const body = await dataObject(o.data);
      if (o.draftVersion !== undefined) body.version = intOption(o.draftVersion, '--draft-version');
      return createClient().saveWorkspaceAutomationDraft(wid as string, id as string, body);
    }, (d) => {
      const a = (d as any)?.automation ?? {};
      return md.success(`Draft v${a.draftVersion ?? '?'} saved for ${md.code(String(a.id ?? '-'))}. Not active until someone activates it.`);
    }));

  automations
    .command('schedule-preview <wid>')
    .description('Preview the next fire times of a schedule')
    .requiredOption('--data <json|file|->', 'Schedule body')
    .action(withAction(async (wid: unknown, opts: unknown) =>
      createClient().previewWorkspaceAutomationSchedule(wid as string, await dataObject((opts as { data: string }).data))));

  automations
    .command('runs <wid>')
    .description('List automation runs (filters are passed through)')
    .option('--automation <id>', 'Only runs of this automation (automationId)')
    .option('--status <status>', 'Only runs in this status')
    .option('--offset <n>', 'Items to skip')
    .option('--limit <n>', 'Items to return')
    .option('--query <key=value>', 'Any other query parameter (repeatable)', collectQuery)
    .action(withAction(async (wid: unknown, opts: unknown) => {
      const o = opts as { automation?: string; status?: string; offset?: string; limit?: string; query?: string[] };
      const query: Record<string, string | undefined> = {
        automationId: o.automation,
        status: o.status,
        offset: o.offset,
        limit: o.limit,
      };
      for (const pair of o.query ?? []) {
        const eq = pair.indexOf('=');
        if (eq <= 0) throw new DevicCliError(`--query "${pair}": expected key=value.`, 'INVALID_USAGE');
        query[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      return createClient().listWorkspaceAutomationRuns(wid as string, query);
    }, runsTable));

  automations
    .command('run <wid> <runId>')
    .description('Show one automation run (--summary for its summary)')
    .option('--summary', 'Fetch the run summary instead')
    .action(withAction(async (wid: unknown, runId: unknown, opts: unknown) => {
      const client = createClient();
      return (opts as { summary?: boolean }).summary
        ? client.getWorkspaceAutomationRunSummary(wid as string, runId as string)
        : client.getWorkspaceAutomationRun(wid as string, runId as string);
    }));

  automations
    .command('rerun <wid> <runId>')
    .description('Run an automation run again')
    .action(withAction(async (wid: unknown, runId: unknown) =>
      createClient().rerunWorkspaceAutomationRun(wid as string, runId as string)));
}

function connectionsTable(d: unknown): string {
  const items = itemsOf(d, 'items');
  if (!items.length) return '_No connections._';
  return md.table(items.map((c: any) => ({
    id: c.id,
    app: c.integration,
    name: c.name,
    account: c.accountLabel,
    scope: c.scope,
    status: c.status,
    enabledHere: c.granted,
  })), { columns: ['id', 'app', 'name', 'account', 'scope', 'status', 'enabledHere'] });
}

/** Authorization link printed for a person to open; never opened for them. */
function authorizationLink(d: unknown): string {
  const c = (d as any) ?? {};
  if (c.status === 'active') return md.success(`Connected: ${md.code(String(c.id ?? '-'))}.`);
  if (!c.redirectUrl) return md.success(`Connection ${md.code(String(c.id ?? '-'))} is ${c.status ?? 'pending'}.`);
  return [
    md.success(`Connection ${md.code(String(c.id ?? '-'))} created, pending authorization.`),
    `Open this link and complete the consent screen:\n\n${c.redirectUrl}`,
  ].join('\n\n');
}

export function registerWorkspaceConnectionCommands(ws: Command): void {
  ws.command('integrations')
    .description('Apps this workspace can connect')
    .command('search <wid> <query>')
    .description('Search the catalog by name (or by task with --semantic)')
    .option('--semantic', 'Search by what the app does')
    .action(withAction(async (wid: unknown, query: unknown, opts: unknown) =>
      createClient().searchWorkspaceIntegrations(wid as string, {
        search: query as string,
        semantic: (opts as { semantic?: boolean }).semantic ? 'true' : undefined,
      })));

  const connections = ws.command('connections').description('Connected app accounts of a workspace');

  connections
    .command('list <wid>')
    .description('Shared accounts and your own, with whether each is enabled here')
    .action(withAction(async (wid: unknown) => createClient().listWorkspaceConnections(wid as string), connectionsTable));

  connections
    .command('connect <wid> <integration>')
    .description('Start connecting an app and print its authorization link')
    .requiredOption('--scope <scope>', 'workspace (for everyone; owner or manager) | user (your own account)')
    .option('--name <label>', 'Label for this account')
    .option('--auth-scheme <scheme>', 'When the app offers several (e.g. OAUTH2, API_KEY)')
    .action(withAction(async (wid: unknown, integration: unknown, opts: unknown) => {
      const o = opts as { scope: string; name?: string; authScheme?: string };
      if (!['workspace', 'user'].includes(o.scope))
        throw new DevicCliError('--scope must be workspace or user.', 'INVALID_USAGE');
      return createClient().connectWorkspaceIntegration(wid as string, {
        integration: integration as string,
        scope: o.scope,
        ...(o.name !== undefined ? { name: o.name } : {}),
        ...(o.authScheme !== undefined ? { authScheme: o.authScheme } : {}),
      });
    }, authorizationLink));

  connections
    .command('reconnect <wid> <connectionId>')
    .description('A new authorization link for a pending or expired connection')
    .action(withAction(async (wid: unknown, cid: unknown) =>
      createClient().reconnectWorkspaceConnection(wid as string, cid as string), authorizationLink));

  for (const [action, enabled, help] of [
    ['enable', true, 'Use one of your own accounts in this workspace'],
    ['disable', false, 'Stop using one of your own accounts in this workspace'],
  ] as const) {
    connections
      .command(`${action} <wid> <connectionId>`)
      .description(help)
      .action(withAction(async (wid: unknown, cid: unknown) =>
        createClient().setWorkspaceConnectionGrant(wid as string, cid as string, enabled)));
  }
}

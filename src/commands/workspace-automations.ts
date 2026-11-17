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
    .description('Create an automation from a JSON body')
    .requiredOption('--data <json|file|->', 'Automation body')
    .action(withAction(async (wid: unknown, opts: unknown) =>
      createClient().createWorkspaceAutomation(wid as string, await dataObject((opts as { data: string }).data)),
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

  for (const [action, help] of [
    ['activate', 'Activate (resume) an automation'],
    ['pause', 'Pause an automation'],
    ['invoke', 'Run an automation now'],
    ['test', 'Dry-run an automation'],
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

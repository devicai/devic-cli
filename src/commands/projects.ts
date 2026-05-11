import { Command } from 'commander';
import {
  createClient,
  withAction,
  addListOptions,
  parseListOpts,
  readJsonInput,
} from '../helpers.js';
import { md } from '../output.js';

interface ProjectDto {
  _id?: string;
  name?: string;
  identifier?: string;
  description?: string;
  visibility?: string;
  archived?: boolean;
  imageUrl?: string;
  creationTimestampMs?: number;
  lastEditTimestampMs?: number;
  createdByUserUID?: string;
}

function formatProject(p: ProjectDto): string {
  const lines = [
    md.h(2, `Project: ${p.name ?? '-'}`),
    '',
    `**ID:** ${md.code(p._id ?? '-')}`,
    `**Identifier:** ${md.code(p.identifier ?? '-')}`,
  ];
  if (p.description) lines.push(`**Description:** ${p.description}`);
  if (p.visibility) lines.push(`**Visibility:** ${p.visibility}`);
  if (p.archived != null)
    lines.push(`**Archived:** ${p.archived ? 'Yes' : 'No'}`);
  if (p.creationTimestampMs)
    lines.push(`**Created:** ${new Date(p.creationTimestampMs).toLocaleString()}`);
  if (p.lastEditTimestampMs)
    lines.push(`**Updated:** ${new Date(p.lastEditTimestampMs).toLocaleString()}`);
  return lines.join('\n');
}

export function registerProjectCommands(program: Command): void {
  const projects = program.command('projects').description('Manage projects');

  // projects list
  addListOptions(
    projects
      .command('list')
      .description('List projects')
      .option('--archived', 'Include archived projects'),
  ).action(
    withAction(async (opts: unknown) => {
      const o = opts as { archived?: boolean; offset?: string; limit?: string };
      const client = createClient();
      return client.listProjects({
        archived: o.archived,
        ...parseListOpts(o),
      });
    }, (d) => {
      const data = d as any;
      const items = data?.projects ?? (Array.isArray(data) ? data : []);
      if (items.length === 0) return '_No projects found._';
      const lines = [
        md.h(2, 'Projects'),
        '',
        md.table(
          items.map((p: any) => ({
            id: p._id,
            identifier: p.identifier,
            name: p.name,
            visibility: p.visibility ?? 'private',
            archived: p.archived ?? false,
          })),
          { columns: ['id', 'identifier', 'name', 'visibility', 'archived'] },
        ),
      ];
      if (data?.total != null) lines.push(md.pagination(data));
      return lines.join('\n');
    }),
  );

  // projects get <id>
  projects
    .command('get <projectId>')
    .description('Get project details')
    .action(
      withAction(async (projectId: unknown) => {
        const client = createClient();
        return client.getProject(projectId as string);
      }, (d) => formatProject(d as ProjectDto)),
    );

  // projects create
  projects
    .command('create')
    .description('Create a project')
    .option('--name <name>', 'Project name')
    .option('--identifier <id>', 'URL-friendly identifier (lowercase + hyphens)')
    .option('--description <desc>', 'Project description')
    .option('--visibility <vis>', 'public | private', 'private')
    .option('--from-json <file>', 'Read full payload from JSON file (- for stdin)')
    .action(
      withAction(async (opts: unknown) => {
        const o = opts as {
          name?: string;
          identifier?: string;
          description?: string;
          visibility?: string;
          fromJson?: string;
        };
        const client = createClient();
        let data: Record<string, unknown>;
        if (o.fromJson) {
          data = await readJsonInput(o.fromJson);
        } else {
          if (!o.name) throw new Error('--name is required');
          if (!o.identifier) throw new Error('--identifier is required');
          data = { name: o.name, identifier: o.identifier };
          if (o.description) data.description = o.description;
          if (o.visibility) data.visibility = o.visibility;
        }
        return client.createProject(data);
      }, (d) => {
        const p = d as ProjectDto;
        return [
          md.success(`Project created: ${md.b(p.name ?? '-')}`),
          '',
          formatProject(p),
        ].join('\n');
      }),
    );

  // projects update <id>
  projects
    .command('update <projectId>')
    .description('Update a project')
    .option('--name <name>', 'New project name')
    .option('--description <desc>', 'New description')
    .option('--visibility <vis>', 'public | private')
    .option('--archived <bool>', 'Archive flag (true|false)')
    .option('--image-url <url>', 'Image URL')
    .option('--from-json <file>', 'Read full payload from JSON file (- for stdin)')
    .action(
      withAction(async (projectId: unknown, opts: unknown) => {
        const id = projectId as string;
        const o = opts as {
          name?: string;
          description?: string;
          visibility?: string;
          archived?: string;
          imageUrl?: string;
          fromJson?: string;
        };
        const client = createClient();
        let data: Record<string, unknown>;
        if (o.fromJson) {
          data = await readJsonInput(o.fromJson);
        } else {
          data = {};
          if (o.name) data.name = o.name;
          if (o.description) data.description = o.description;
          if (o.visibility) data.visibility = o.visibility;
          if (o.archived !== undefined) data.archived = o.archived === 'true';
          if (o.imageUrl) data.imageUrl = o.imageUrl;
        }
        return client.updateProject(id, data);
      }, (d) => {
        const p = d as ProjectDto;
        return [md.success(`Project updated: ${md.b(p.name ?? '-')}`), '', formatProject(p)].join('\n');
      }),
    );

  // projects archive <id>
  projects
    .command('archive <projectId>')
    .description('Archive a project (soft delete)')
    .action(
      withAction(async (projectId: unknown) => {
        const client = createClient();
        return client.archiveProject(projectId as string);
      }, () => md.success('Project archived.')),
    );

  // projects threads <id>
  addListOptions(
    projects
      .command('threads <projectId>')
      .description('List agent threads associated with a project'),
  ).action(
    withAction(async (projectId: unknown, opts: unknown) => {
      const o = opts as { offset?: string; limit?: string };
      const client = createClient();
      return client.getProjectThreads(projectId as string, parseListOpts(o));
    }, (d) => {
      const data = d as any;
      const items = data.threads ?? data.data ?? (Array.isArray(data) ? data : []);
      if (items.length === 0) return '_No threads found._';
      return [
        md.h(2, 'Project Threads'),
        '',
        md.table(
          items.map((t: any) => ({
            id: t._id ?? t.threadId,
            agent: t.agentId ?? '-',
            state: t.state ?? '-',
            created: t.creationTimestampMs
              ? new Date(t.creationTimestampMs).toLocaleString()
              : '-',
          })),
          { columns: ['id', 'agent', 'state', 'created'] },
        ),
      ].join('\n');
    }),
  );

  // projects conversations <id>
  addListOptions(
    projects
      .command('conversations <projectId>')
      .description('List assistant conversations associated with a project'),
  ).action(
    withAction(async (projectId: unknown, opts: unknown) => {
      const o = opts as { offset?: string; limit?: string };
      const client = createClient();
      return client.getProjectConversations(
        projectId as string,
        parseListOpts(o),
      );
    }, (d) => {
      const data = d as any;
      const items = data.conversations ?? data.histories ?? data.chats ?? (Array.isArray(data) ? data : []);
      if (items.length === 0) return '_No conversations found._';
      return [
        md.h(2, 'Project Conversations'),
        '',
        md.table(
          items.map((c: any) => ({
            chatUID: c.chatUID ?? c.chatUid ?? c._id,
            assistant: c.assistantSpecializationIdentifier ?? '-',
            name: c.name ?? '-',
            created: c.creationTimestampMs
              ? new Date(c.creationTimestampMs).toLocaleString()
              : '-',
          })),
        ),
      ].join('\n');
    }),
  );

  // projects stats <id>
  projects
    .command('stats <projectId>')
    .description('Show project stats summary')
    .action(
      withAction(async (projectId: unknown) => {
        const client = createClient();
        return client.getProjectStats(projectId as string);
      }),
    );

  // projects costs ...
  const costs = projects.command('costs').description('Project cost breakdown');

  costs
    .command('daily <projectId>')
    .description('Daily costs breakdown')
    .option('--start-date <date>', 'YYYY-MM-DD')
    .option('--end-date <date>', 'YYYY-MM-DD')
    .option('--tenant-id <id>', 'Tenant filter')
    .action(
      withAction(async (projectId: unknown, opts: unknown) => {
        const o = opts as {
          startDate?: string;
          endDate?: string;
          tenantId?: string;
        };
        const client = createClient();
        return client.getProjectDailyCosts(projectId as string, o);
      }, (d) => {
        const items = Array.isArray(d) ? d : [];
        if (items.length === 0) return '_No cost data._';
        return [md.h(2, 'Daily Costs'), '', md.table(items)].join('\n');
      }),
    );

  costs
    .command('monthly <projectId>')
    .description('Monthly costs breakdown')
    .option('--start-month <month>', 'YYYY-MM')
    .option('--end-month <month>', 'YYYY-MM')
    .option('--tenant-id <id>', 'Tenant filter')
    .action(
      withAction(async (projectId: unknown, opts: unknown) => {
        const o = opts as {
          startMonth?: string;
          endMonth?: string;
          tenantId?: string;
        };
        const client = createClient();
        return client.getProjectMonthlyCosts(projectId as string, o);
      }, (d) => {
        const items = Array.isArray(d) ? d : [];
        if (items.length === 0) return '_No cost data._';
        return [md.h(2, 'Monthly Costs'), '', md.table(items)].join('\n');
      }),
    );
}

import { Command } from 'commander';
import {
  createClient,
  withAction,
  addListOptions,
  parseListOpts,
  readAndValidateJson,
  addSkipValidationOption,
  resolveProjectId,
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
    .command('get <project>')
    .description('Get project details (accepts _id, identifier, or name)')
    .action(
      withAction(async (project: unknown) => {
        const client = createClient();
        const id = await resolveProjectId(client, project as string);
        return client.getProject(id);
      }, (d) => formatProject(d as ProjectDto)),
    );

  // projects create
  addSkipValidationOption(
    projects
      .command('create')
      .description('Create a project')
      .option('--name <name>', 'Project name')
      .option('--identifier <id>', 'URL-friendly identifier (lowercase + hyphens)')
      .option('--description <desc>', 'Project description')
      .option('--visibility <vis>', 'public | private', 'private')
      .option('--from-json <file>', 'Read full payload from JSON file (- for stdin)'),
  ).action(
      withAction(async (opts: unknown) => {
        const o = opts as {
          name?: string;
          identifier?: string;
          description?: string;
          visibility?: string;
          fromJson?: string;
          skipValidation?: boolean;
        };
        const client = createClient();
        let data: Record<string, unknown>;
        if (o.fromJson) {
          data = await readAndValidateJson(o.fromJson, 'project', { skip: o.skipValidation });
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
  addSkipValidationOption(
    projects
      .command('update <project>')
      .description('Update a project (accepts _id, identifier, or name)')
      .option('--name <name>', 'New project name')
      .option('--description <desc>', 'New description')
      .option('--visibility <vis>', 'public | private')
      .option('--archived <bool>', 'Archive flag (true|false)')
      .option('--image-url <url>', 'Image URL')
      .option('--from-json <file>', 'Read full payload from JSON file (- for stdin)'),
  ).action(
      withAction(async (project: unknown, opts: unknown) => {
        const client = createClient();
        const id = await resolveProjectId(client, project as string);
        const o = opts as {
          name?: string;
          description?: string;
          visibility?: string;
          archived?: string;
          imageUrl?: string;
          fromJson?: string;
          skipValidation?: boolean;
        };
        let data: Record<string, unknown>;
        if (o.fromJson) {
          data = await readAndValidateJson(o.fromJson, 'project', { skip: o.skipValidation });
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
    .command('archive <project>')
    .description('Archive a project (soft delete; accepts _id, identifier, or name)')
    .action(
      withAction(async (project: unknown) => {
        const client = createClient();
        const id = await resolveProjectId(client, project as string);
        return client.archiveProject(id);
      }, () => md.success('Project archived.')),
    );

  // projects threads <id>
  addListOptions(
    projects
      .command('threads <project>')
      .description('List agent threads associated with a project (accepts _id, identifier, or name)'),
  ).action(
    withAction(async (project: unknown, opts: unknown) => {
      const o = opts as { offset?: string; limit?: string };
      const client = createClient();
      const id = await resolveProjectId(client, project as string);
      return client.getProjectThreads(id, parseListOpts(o));
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
      .command('conversations <project>')
      .description('List assistant conversations associated with a project (accepts _id, identifier, or name)'),
  ).action(
    withAction(async (project: unknown, opts: unknown) => {
      const o = opts as { offset?: string; limit?: string };
      const client = createClient();
      const id = await resolveProjectId(client, project as string);
      return client.getProjectConversations(
        id,
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
    .command('stats <project>')
    .description('Show project stats summary (accepts _id, identifier, or name)')
    .action(
      withAction(async (project: unknown) => {
        const client = createClient();
        const id = await resolveProjectId(client, project as string);
        return client.getProjectStats(id);
      }),
    );

  // projects costs ...
  const costs = projects.command('costs').description('Project cost breakdown');

  costs
    .command('daily <project>')
    .description('Daily costs breakdown (accepts _id, identifier, or name)')
    .option('--start-date <date>', 'YYYY-MM-DD')
    .option('--end-date <date>', 'YYYY-MM-DD')
    .option('--tenant-id <id>', 'Tenant filter')
    .action(
      withAction(async (project: unknown, opts: unknown) => {
        const o = opts as {
          startDate?: string;
          endDate?: string;
          tenantId?: string;
        };
        const client = createClient();
        const id = await resolveProjectId(client, project as string);
        return client.getProjectDailyCosts(id, o);
      }, (d) => {
        const items = Array.isArray(d) ? d : [];
        if (items.length === 0) return '_No cost data._';
        return [md.h(2, 'Daily Costs'), '', md.table(items)].join('\n');
      }),
    );

  costs
    .command('monthly <project>')
    .description('Monthly costs breakdown (accepts _id, identifier, or name)')
    .option('--start-month <month>', 'YYYY-MM')
    .option('--end-month <month>', 'YYYY-MM')
    .option('--tenant-id <id>', 'Tenant filter')
    .action(
      withAction(async (project: unknown, opts: unknown) => {
        const o = opts as {
          startMonth?: string;
          endMonth?: string;
          tenantId?: string;
        };
        const client = createClient();
        const id = await resolveProjectId(client, project as string);
        return client.getProjectMonthlyCosts(id, o);
      }, (d) => {
        const items = Array.isArray(d) ? d : [];
        if (items.length === 0) return '_No cost data._';
        return [md.h(2, 'Monthly Costs'), '', md.table(items)].join('\n');
      }),
    );
}

import { Command } from 'commander';
import type { DevicApiClient } from '../client.js';
import { createClient, withAction } from '../helpers.js';
import { setGlobalActingUser } from '../config.js';
import { md } from '../output.js';
import { DevicCliError } from '../errors.js';
import { countOf, dataObject, intOpt, itemsOf, revisionOf, textInput } from './workspace-shared.js';
import { registerWorkspaceThreadCommands } from './workspace-threads.js';
import { registerWorkspaceAutomationCommands } from './workspace-automations.js';

const MEMBER_ROLES = ['owner', 'manager', 'member', 'viewer'];
const MEMORY_SECTIONS = ['persona', 'instructions', 'decisions', 'profile'];
const MEMORY_MAX_CHARS = 4000;

function workspacesTable(d: unknown): string {
  const data = d as any;
  const items = itemsOf(data, 'workspaces');
  if (!items.length) return '_No workspaces found._';
  const rows = items.map((w: any) => ({
    id: w.id,
    name: w.name,
    kind: w.kind,
    visibility: w.visibility,
    members: countOf(w.members) ?? countOf(w.memberCount),
    assistants: countOf(w.assistants) ?? countOf(w.assistantCount),
    archived: w.archived,
  }));
  return [
    md.h(2, 'Workspaces'),
    '',
    md.table(rows, { columns: ['id', 'name', 'kind', 'visibility', 'members', 'assistants', 'archived'] }),
    md.pagination(data),
  ].join('\n');
}

function formatWorkspace(d: unknown): string {
  const w = ((d as any)?.workspace ?? d) as Record<string, unknown>;
  const lines = [md.props(w, { title: String(w.name ?? 'Workspace'), omit: ['members', 'assistants'] })];
  const members = Array.isArray(w.members) ? (w.members as Record<string, unknown>[]) : [];
  if (members.length) lines.push('', md.h(3, 'Members'), md.table(members));
  const assistants = Array.isArray(w.assistants) ? (w.assistants as Record<string, unknown>[]) : [];
  if (assistants.length && typeof assistants[0] === 'object') lines.push('', md.h(3, 'Assistants'), md.table(assistants));
  return lines.join('\n');
}

function catalogTable(d: unknown): string {
  const items = itemsOf(d, 'skills', 'knowledge', 'documents', 'catalog');
  return items.length ? md.table(items) : md.props((d ?? {}) as Record<string, unknown>);
}

// ── Skills attached to a workspace = resources.knowledgeSkills ──

type SkillEntry = { id: string; type: 'document' | 'folder'; enabled?: boolean; preloadContent?: boolean };

/**
 * The server stores skill links as `{type: 'document' | 'folder', id}` and
 * returns them with display fields (name, description, unavailable) that are
 * not part of the link, so only the link itself is sent back.
 */
function skillLink(entry: any): SkillEntry | undefined {
  if (!entry || typeof entry.id !== 'string') return undefined;
  const link: SkillEntry = { id: entry.id, type: entry.type === 'folder' ? 'folder' : 'document' };
  if (typeof entry.enabled === 'boolean') link.enabled = entry.enabled;
  if (typeof entry.preloadContent === 'boolean') link.preloadContent = entry.preloadContent;
  return link;
}

/** `<id>` or `document:<id>` links a skill document; `folder:<id>` a skill folder. */
function parseSkillRef(ref: string): SkillEntry {
  const match = /^(document|folder):(.+)$/.exec(ref);
  return match ? { type: match[1] as SkillEntry['type'], id: match[2] } : { type: 'document', id: ref };
}

const linkKey = (s: SkillEntry) => `${s.type}:${s.id}`;

async function readKnowledgeSkills(
  client: DevicApiClient,
  wid: string,
): Promise<{ skills: SkillEntry[]; revision?: number }> {
  const res = (await client.getWorkspaceResources(wid)) as any;
  const holder = res && typeof res === 'object' && 'resources' in res && res.resources ? res.resources : res;
  const skills = (Array.isArray(holder?.knowledgeSkills) ? holder.knowledgeSkills : [])
    .map(skillLink)
    .filter(Boolean) as SkillEntry[];
  return { skills, revision: revisionOf(res) ?? revisionOf(holder) };
}

export function registerWorkspaceCommands(program: Command): void {
  const ws = program
    .command('workspaces')
    .alias('ws')
    .description('Workspaces: shared spaces where people and assistants work in threads')
    .option(
      '--as <user>',
      'Act as this person of the account (userUID or email; sent as X-Devic-User). Also DEVIC_USER.',
    )
    .hook('preAction', (_self, actionCommand) => {
      const as = actionCommand.optsWithGlobals().as as string | undefined;
      if (as) setGlobalActingUser(as);
    });

  ws.command('me')
    .description('Who the Workspaces API sees you as (person or the API integration)')
    .action(withAction(async () => createClient().getWorkspaceMe(), (d) =>
      md.props(d as Record<string, unknown>, { title: 'Workspaces identity' })));

  ws.command('list')
    .description('List the workspaces you can see')
    .option('--search <text>', 'Filter by name')
    .option('--archived', 'Include archived workspaces')
    .option('--summary', 'Include activity summary per workspace')
    .option('--offset <n>', 'Items to skip')
    .option('--limit <n>', 'Items to return (max 100, default 20)')
    .action(withAction(async (opts: unknown) => {
      const o = opts as { search?: string; archived?: boolean; summary?: boolean; offset?: string; limit?: string };
      return createClient().listWorkspaces({
        search: o.search,
        includeArchived: o.archived ? 'true' : undefined,
        withSummary: o.summary ? 'true' : undefined,
        offset: intOpt(o.offset, '--offset'),
        limit: intOpt(o.limit, '--limit'),
      });
    }, workspacesTable));

  ws.command('get <wid>')
    .description('Show a workspace')
    .action(withAction(async (wid: unknown) => createClient().getWorkspace(wid as string), formatWorkspace));

  ws.command('catalog')
    .description('What can be used when creating a workspace (kinds, assistants, ...)')
    .action(withAction(async () => createClient().getWorkspaceCatalog()));

  ws.command('create')
    .description('Create a workspace')
    .option('--data <json|file|->', 'Full body')
    .option('--name <name>', 'Name')
    .option('--description <text>', 'Description')
    .option('--visibility <visibility>', 'Visibility')
    .action(withAction(async (opts: unknown) => {
      const o = opts as { data?: string; name?: string; description?: string; visibility?: string };
      const body = {
        ...(await dataObject(o.data)),
        ...(o.name != null && { name: o.name }),
        ...(o.description != null && { description: o.description }),
        ...(o.visibility != null && { visibility: o.visibility }),
      };
      if (!Object.keys(body).length) throw new DevicCliError('Pass --data or --name.', 'INVALID_USAGE');
      return createClient().createWorkspace(body);
    }, (d) => {
      const w = (d as any)?.workspace ?? d;
      return md.success(`Workspace created: ${md.code(String(w?.id ?? '-'))}${w?.name ? ` — ${w.name}` : ''}`);
    }));

  ws.command('update <wid>')
    .description('Change a workspace (name, description, visibility, assistantIds, intervention, archived, ...)')
    .option('--data <json|file|->', 'Fields to change')
    .option('--name <name>', 'Name')
    .option('--description <text>', 'Description')
    .option('--visibility <visibility>', 'Visibility')
    .option('--archive', 'Archive the workspace')
    .option('--unarchive', 'Unarchive the workspace')
    .option('--revision <n>', 'Expected revision (optimistic concurrency)')
    .action(withAction(async (wid: unknown, opts: unknown) => {
      const o = opts as {
        data?: string; name?: string; description?: string; visibility?: string;
        archive?: boolean; unarchive?: boolean; revision?: string;
      };
      if (o.archive && o.unarchive) throw new DevicCliError('Pass only one of --archive / --unarchive.', 'INVALID_USAGE');
      const revision = intOpt(o.revision, '--revision');
      const body = {
        ...(await dataObject(o.data)),
        ...(o.name != null && { name: o.name }),
        ...(o.description != null && { description: o.description }),
        ...(o.visibility != null && { visibility: o.visibility }),
        ...(o.archive && { archived: true }),
        ...(o.unarchive && { archived: false }),
        ...(revision != null && { revision }),
      };
      if (!Object.keys(body).length) throw new DevicCliError('Nothing to update.', 'INVALID_USAGE');
      return createClient().updateWorkspace(wid as string, body);
    }, () => md.success('Workspace updated.')));

  // ── members ──

  const members = ws.command('members').description('People of a workspace and their roles');

  members
    .command('list <wid>')
    .description('List members (from the workspace detail)')
    .action(withAction(async (wid: unknown) => {
      const w = (await createClient().getWorkspace(wid as string)) as any;
      return (w?.workspace ?? w)?.members ?? [];
    }));

  members
    .command('set <wid> <userUID>')
    .description(`Add a person or change their role (${MEMBER_ROLES.join(' | ')})`)
    .requiredOption('--role <role>', MEMBER_ROLES.join(' | '))
    .option('--revision <n>', 'Expected workspace revision')
    .action(withAction(async (wid: unknown, uid: unknown, opts: unknown) => {
      const o = opts as { role: string; revision?: string };
      if (!MEMBER_ROLES.includes(o.role)) {
        throw new DevicCliError(`--role must be one of ${MEMBER_ROLES.join(', ')}.`, 'INVALID_USAGE');
      }
      const revision = intOpt(o.revision, '--revision');
      return createClient().setWorkspaceMember(wid as string, uid as string, {
        role: o.role,
        ...(revision != null && { revision }),
      });
    }, () => md.success('Member saved.')));

  members
    .command('remove <wid> <userUID>')
    .description('Remove a person from the workspace')
    .action(withAction(async (wid: unknown, uid: unknown) =>
      createClient().removeWorkspaceMember(wid as string, uid as string),
    () => md.success('Member removed.')));

  // ── assistants ──

  const assistants = ws.command('assistants').description('Assistants available in a workspace');

  assistants
    .command('list <wid>')
    .description('List the workspace\'s assistants')
    .action(withAction(async (wid: unknown) => createClient().listWorkspaceAssistants(wid as string), (d) => {
      const items = itemsOf(d, 'assistants');
      return items.length ? md.table(items) : '_No assistants._';
    }));

  assistants
    .command('get <wid> <assistantId>')
    .description('Show one assistant of the workspace')
    .action(withAction(async (wid: unknown, aid: unknown) =>
      createClient().getWorkspaceAssistant(wid as string, aid as string)));

  assistants
    .command('add <wid>')
    .description('Add an assistant to the workspace')
    .requiredOption('--data <json|file|->', 'Assistant body')
    .action(withAction(async (wid: unknown, opts: unknown) =>
      createClient().addWorkspaceAssistant(wid as string, await dataObject((opts as { data: string }).data)),
    () => md.success('Assistant added.')));

  assistants
    .command('update <wid> <assistantId>')
    .description('Change a workspace assistant')
    .requiredOption('--data <json|file|->', 'Fields to change')
    .action(withAction(async (wid: unknown, aid: unknown, opts: unknown) =>
      createClient().updateWorkspaceAssistant(wid as string, aid as string, await dataObject((opts as { data: string }).data)),
    () => md.success('Assistant updated.')));

  assistants
    .command('remove <wid> <assistantId>')
    .description('Remove an assistant (revision is read from the assistant, else the workspace, unless --revision)')
    .option('--revision <n>', 'Expected revision')
    .action(withAction(async (wid: unknown, aid: unknown, opts: unknown) => {
      const client = createClient();
      let revision = intOpt((opts as { revision?: string }).revision, '--revision');
      if (revision == null) {
        const a = (await client.getWorkspaceAssistant(wid as string, aid as string)) as any;
        revision = revisionOf(a) ?? revisionOf(a?.assistant);
        if (revision == null) {
          const w = (await client.getWorkspace(wid as string)) as any;
          revision = revisionOf(w) ?? revisionOf(w?.workspace);
        }
      }
      return client.removeWorkspaceAssistant(wid as string, aid as string, revision);
    }, () => md.success('Assistant removed.')));

  // ── resources, knowledge, skills ──

  const resources = ws.command('resources').description('Knowledge, skills and environment of a workspace');

  resources
    .command('get <wid>')
    .description('Show the workspace resources')
    .action(withAction(async (wid: unknown) => createClient().getWorkspaceResources(wid as string)));

  resources
    .command('set <wid>')
    .description('Replace resources: {knowledgeSkills?, knowledge?, environment?} (revision filled in when missing)')
    .requiredOption('--data <json|file|->', 'Resources body')
    .option('--revision <n>', 'Expected revision (default: the current one)')
    .action(withAction(async (wid: unknown, opts: unknown) => {
      const o = opts as { data: string; revision?: string };
      const client = createClient();
      const body = await dataObject(o.data);
      const revision = intOpt(o.revision, '--revision');
      if (revision != null) body.revision = revision;
      if (body.revision == null) {
        const current = (await client.getWorkspaceResources(wid as string)) as any;
        const found = revisionOf(current) ?? revisionOf(current?.resources);
        if (found != null) body.revision = found;
      }
      return client.setWorkspaceResources(wid as string, body);
    }, () => md.success('Resources saved.')));

  const knowledge = ws.command('knowledge').description('Knowledge a workspace can use');
  knowledge
    .command('catalog <wid>')
    .description('Knowledge documents that can be attached to the workspace')
    .option('--search <text>', 'Filter')
    .action(withAction(async (wid: unknown, opts: unknown) =>
      createClient().getWorkspaceKnowledgeCatalog(wid as string, (opts as { search?: string }).search), catalogTable));

  const skills = ws.command('skills').description('Skills attached to a workspace (resources.knowledgeSkills)');

  skills
    .command('catalog <wid>')
    .description('Skills that can be attached to the workspace')
    .option('--search <text>', 'Filter')
    .action(withAction(async (wid: unknown, opts: unknown) =>
      createClient().getWorkspaceSkillsCatalog(wid as string, (opts as { search?: string }).search), catalogTable));

  skills
    .command('list <wid>')
    .description('Skills currently attached')
    .action(withAction(async (wid: unknown) => (await createClient().getWorkspaceResources(wid as string) as any)?.knowledgeSkills ?? []));

  skills
    .command('attach <wid> <skillRef...>')
    .description('Attach skills: <id> or document:<id> for a skill document, folder:<id> for a skill folder')
    .action(withAction(async (wid: unknown, refs: unknown) => {
      const client = createClient();
      const { skills: current, revision } = await readKnowledgeSkills(client, wid as string);
      const have = new Set(current.map(linkKey));
      const added = (refs as string[]).map(parseSkillRef).filter((s) => !have.has(linkKey(s)));
      if (!added.length) return { knowledgeSkills: current, unchanged: true };
      return client.setWorkspaceResources(wid as string, {
        knowledgeSkills: [...current, ...added],
        ...(revision != null && { revision }),
      });
    }, (d) => ((d as any)?.unchanged ? md.info('Already attached.') : md.success('Skills attached.'))));

  skills
    .command('detach <wid> <skillRef...>')
    .description('Detach skills (same references as attach)')
    .action(withAction(async (wid: unknown, refs: unknown) => {
      const client = createClient();
      const { skills: current, revision } = await readKnowledgeSkills(client, wid as string);
      const drop = new Set((refs as string[]).map(parseSkillRef).map(linkKey));
      const next = current.filter((s) => !drop.has(linkKey(s)));
      if (next.length === current.length) return { knowledgeSkills: current, unchanged: true };
      return client.setWorkspaceResources(wid as string, {
        knowledgeSkills: next,
        ...(revision != null && { revision }),
      });
    }, (d) => ((d as any)?.unchanged ? md.info('None of those were attached.') : md.success('Skills detached.'))));

  ws.command('documents <wid>')
    .description('Documents produced or shared in the workspace')
    .option('--search <text>', 'Search')
    .option('--extension <ext>', 'File extension')
    .option('--type <type>', 'Document type')
    .option('--creator <id>', 'Creator')
    .option('--thread <tid>', 'Only documents of this thread')
    .option('--offset <n>', 'Items to skip')
    .option('--limit <n>', 'Items to return')
    .action(withAction(async (wid: unknown, opts: unknown) => {
      const o = opts as {
        search?: string; extension?: string; type?: string; creator?: string; thread?: string;
        offset?: string; limit?: string;
      };
      return createClient().listWorkspaceDocuments(wid as string, {
        search: o.search,
        extension: o.extension,
        type: o.type,
        creator: o.creator,
        threadId: o.thread,
        offset: intOpt(o.offset, '--offset'),
        limit: intOpt(o.limit, '--limit'),
      });
    }, (d) => {
      const items = itemsOf(d);
      return items.length ? `${md.table(items)}${md.pagination(d as any)}` : '_No documents._';
    }));

  // ── core memory ──

  const memory = ws.command('memory').description('Core memory of an assistant inside a workspace');

  memory
    .command('list <wid> <assistantId>')
    .description('Core memory entries')
    .action(withAction(async (wid: unknown, aid: unknown) =>
      createClient().listWorkspaceCoreMemory(wid as string, aid as string), (d) => {
      const data = d as any;
      const head = [
        `**Enabled:** ${data?.enabled ? 'Yes' : 'No'}`,
        `**Can edit:** ${data?.canEdit ? 'Yes' : 'No'}`,
      ];
      const entries = itemsOf(data, 'entries');
      return [...head, '', entries.length
        ? md.table(entries, { columns: ['id', 'section', 'pinned', 'source', 'content'], maxColWidth: 80 })
        : '_No entries._'].join('\n');
    }));

  const memoryContent = async (o: { content?: string; file?: string }) => {
    const content = await textInput(o.content, o.file, ['--content', '--file']);
    if (content != null && content.length > MEMORY_MAX_CHARS) {
      throw new DevicCliError(`Content is ${content.length} characters; the limit is ${MEMORY_MAX_CHARS}.`, 'INVALID_USAGE');
    }
    return content;
  };
  const checkSection = (section?: string) => {
    if (section != null && !MEMORY_SECTIONS.includes(section)) {
      throw new DevicCliError(`--section must be one of ${MEMORY_SECTIONS.join(', ')}.`, 'INVALID_USAGE');
    }
  };

  memory
    .command('add <wid> <assistantId>')
    .description('Add a core memory entry')
    .requiredOption('--section <section>', MEMORY_SECTIONS.join(' | '))
    .option('--content <text>', `Entry text (max ${MEMORY_MAX_CHARS} chars; - for stdin)`)
    .option('--file <path>', 'Read the entry text from a file (- for stdin)')
    .option('--pinned', 'Pin the entry')
    .action(withAction(async (wid: unknown, aid: unknown, opts: unknown) => {
      const o = opts as { section: string; content?: string; file?: string; pinned?: boolean };
      checkSection(o.section);
      const content = await memoryContent(o);
      if (!content?.trim()) throw new DevicCliError('--content or --file is required.', 'INVALID_USAGE');
      return createClient().addWorkspaceCoreMemory(wid as string, aid as string, {
        section: o.section,
        content,
        ...(o.pinned && { pinned: true }),
      });
    }, () => md.success('Memory entry added.')));

  memory
    .command('update <wid> <assistantId> <entryId>')
    .description('Change a core memory entry (only the given fields)')
    .option('--section <section>', MEMORY_SECTIONS.join(' | '))
    .option('--content <text>', 'New text (- for stdin)')
    .option('--file <path>', 'Read the new text from a file (- for stdin)')
    .option('--pinned', 'Pin')
    .option('--unpinned', 'Unpin')
    .action(withAction(async (wid: unknown, aid: unknown, entryId: unknown, opts: unknown) => {
      const o = opts as { section?: string; content?: string; file?: string; pinned?: boolean; unpinned?: boolean };
      checkSection(o.section);
      if (o.pinned && o.unpinned) throw new DevicCliError('Pass only one of --pinned / --unpinned.', 'INVALID_USAGE');
      const content = await memoryContent(o);
      const body = {
        ...(o.section != null && { section: o.section }),
        ...(content != null && { content }),
        ...(o.pinned && { pinned: true }),
        ...(o.unpinned && { pinned: false }),
      };
      if (!Object.keys(body).length) throw new DevicCliError('Nothing to update.', 'INVALID_USAGE');
      return createClient().updateWorkspaceCoreMemory(wid as string, aid as string, entryId as string, body);
    }, () => md.success('Memory entry updated.')));

  memory
    .command('remove <wid> <assistantId> <entryId>')
    .description('Delete a core memory entry')
    .action(withAction(async (wid: unknown, aid: unknown, entryId: unknown) =>
      createClient().removeWorkspaceCoreMemory(wid as string, aid as string, entryId as string),
    () => md.success('Memory entry removed.')));

  // ── rules ──

  const rules = ws.command('rules').description('Standing rules of a workspace, or of one thread with --thread');

  rules
    .command('get <wid>')
    .description('Current rules')
    .option('--thread <tid>', 'Rules of this thread instead of the workspace')
    .action(withAction(async (wid: unknown, opts: unknown) =>
      createClient().getWorkspaceRules(wid as string, (opts as { thread?: string }).thread), (d) => {
      const r = ((d as any)?.rules && typeof (d as any).rules === 'object' ? (d as any).rules : d) as any;
      const lines: string[] = [];
      if (r?.revision != null) lines.push(`**Revision:** ${r.revision}`, '');
      lines.push(typeof r?.content === 'string' && r.content ? r.content : '_No rules._');
      return lines.join('\n');
    }));

  rules
    .command('set <wid>')
    .description('Replace the rules (expectedRevision is the current revision unless given)')
    .option('--thread <tid>', 'Rules of this thread instead of the workspace')
    .option('--content <text>', 'Rules text (- for stdin)')
    .option('--file <path>', 'Read the rules from a file (- for stdin)')
    .option('--expected-revision <n>', 'Revision you are replacing (skips fetching it)')
    .action(withAction(async (wid: unknown, opts: unknown) => {
      const o = opts as { thread?: string; content?: string; file?: string; expectedRevision?: string };
      const content = await textInput(o.content, o.file, ['--content', '--file']);
      if (content == null) throw new DevicCliError('--content or --file is required.', 'INVALID_USAGE');
      const client = createClient();
      let expectedRevision = intOpt(o.expectedRevision, '--expected-revision');
      if (expectedRevision == null) {
        const current = (await client.getWorkspaceRules(wid as string, o.thread)) as any;
        expectedRevision = revisionOf(current) ?? revisionOf(current?.rules) ?? 0;
      }
      return client.setWorkspaceRules(wid as string, o.thread, { content, expectedRevision });
    }, () => md.success('Rules saved.')));

  rules
    .command('history <wid>')
    .description('Previous versions of the rules')
    .option('--thread <tid>', 'Rules of this thread instead of the workspace')
    .option('--before <cursor>', 'Page cursor')
    .action(withAction(async (wid: unknown, opts: unknown) => {
      const o = opts as { thread?: string; before?: string };
      return createClient().getWorkspaceRulesHistory(wid as string, o.thread, o.before);
    }));

  registerWorkspaceThreadCommands(ws);
  registerWorkspaceAutomationCommands(ws);
}

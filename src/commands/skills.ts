import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { createClient, withAction } from '../helpers.js';
import { md } from '../output.js';
import type {
  SkillCatalogItem,
  SkillCatalogPage,
  SkillTree,
} from '../types.js';

/** Reported on install so an admin can see which CLI a user installed with. */
const cliVersion: string | undefined = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '../../package.json'),
        'utf-8',
      ),
    ) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
})();

/**
 * Where each supported coding agent expects its skills, mirroring the skills.sh
 * conventions. Project paths are relative to the current directory; global
 * paths are under the user's home. Each skill is written as a folder named after
 * the skill inside these directories.
 */
const AGENT_DIRS: Record<string, { project: string; global: string }> = {
  'claude-code': { project: '.claude/skills', global: '.claude/skills' },
  codex: { project: '.agents/skills', global: '.codex/skills' },
  cursor: { project: '.agents/skills', global: '.cursor/skills' },
  opencode: { project: '.agents/skills', global: '.config/opencode/skills' },
  cline: { project: '.agents/skills', global: '.agents/skills' },
};

const ALL_AGENTS = Object.keys(AGENT_DIRS);

// Directories whose existence signals an installed agent (for auto-detection).
const AGENT_DETECT: Record<string, string[]> = {
  'claude-code': ['.claude'],
  codex: ['.codex'],
  cursor: ['.cursor'],
  opencode: ['.config/opencode'],
  cline: ['.cline'],
};

/** Turns a skill name into a filesystem-safe folder name. */
function skillFolderName(name: string): string {
  return (
    name
      .trim()
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'skill'
  );
}

/** Resolves the base skills directory for one agent + scope. */
function agentSkillsDir(agent: string, global: boolean): string {
  const entry = AGENT_DIRS[agent];
  if (!entry) throw new Error(`Unknown agent "${agent}"`);
  return global
    ? join(homedir(), entry.global)
    : resolve(process.cwd(), entry.project);
}

/** Auto-detects which agents look installed on this machine (global scope). */
function detectAgents(): string[] {
  const found: string[] = [];
  for (const [agent, markers] of Object.entries(AGENT_DETECT)) {
    if (
      markers.some(
        (m) =>
          existsSync(join(homedir(), m)) ||
          existsSync(resolve(process.cwd(), m)),
      )
    ) {
      found.push(agent);
    }
  }
  return found;
}

// ── Local install registry (lockfile) ──

interface LockEntry {
  id: string;
  name: string;
  type: 'document' | 'folder';
  version: string;
  agents: string[];
  scope: 'project' | 'global';
  installedAt: string;
  updatedAt: string;
  // Absolute directory written per agent. Recorded so `uninstall` deletes what
  // was actually installed: recomputing the path from the name would miss the
  // old folder when a skill has been renamed upstream since.
  paths?: Record<string, string>;
}
interface Lockfile {
  skills: Record<string, LockEntry>;
}

function lockfilePath(global: boolean): string {
  return global
    ? join(homedir(), '.devic', 'skills.json')
    : resolve(process.cwd(), '.devic', 'skills.json');
}

function readLockfile(global: boolean): Lockfile {
  const p = lockfilePath(global);
  if (!existsSync(p)) return { skills: {} };
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Lockfile;
  } catch {
    return { skills: {} };
  }
}

function writeLockfile(global: boolean, lock: Lockfile): void {
  const p = lockfilePath(global);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(lock, null, 2));
}

/**
 * Writes a skill tree into each target agent directory, under a folder named
 * after the skill. Document-skills are written as a single SKILL.md so the
 * agent recognizes them. Returns the absolute skill directory per agent.
 *
 * `previous` are the directories a former install wrote: they are removed too,
 * so renaming a skill upstream doesn't leave the old folder behind.
 */
function writeSkillTree(
  tree: SkillTree,
  agents: string[],
  global: boolean,
  previous?: Record<string, string>,
): Record<string, string> {
  const folder = skillFolderName(tree.skill.name);
  const written: Record<string, string> = {};
  for (const agent of agents) {
    const skillDir = join(agentSkillsDir(agent, global), folder);
    // Replace any previous copy so updates don't leave stale files behind.
    for (const dir of new Set([skillDir, previous?.[agent]].filter(Boolean))) {
      if (existsSync(dir as string)) {
        rmSync(dir as string, { recursive: true, force: true });
      }
    }
    for (const file of tree.files) {
      const relPath =
        tree.skill.type === 'document' && tree.files.length === 1
          ? 'SKILL.md'
          : file.path;
      const dest = join(skillDir, relPath);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.content ?? '');
    }
    written[agent] = skillDir;
  }
  return written;
}

/**
 * Where a skill lives for one agent. Prefers what the install actually wrote
 * (lockfiles from CLI < 0.13 carry no paths, so fall back to the name).
 */
function skillDirFor(entry: LockEntry, agent: string): string {
  return (
    entry.paths?.[agent] ??
    join(agentSkillsDir(agent, entry.scope === 'global'), skillFolderName(entry.name))
  );
}

/**
 * Whole catalog, page by page.
 *
 * `skills install`/`update` resolve a skill by name, so a truncated fetch shows
 * up as "Skill not found" for anything past the first page. The API caps `limit`
 * at 200 and returns `{items,total,page,limit}`, so keep asking until we have
 * `total` (older deployments answered with a bare array — `normalizeCatalog`
 * absorbs that, and the loop exits on the first page because there is no
 * `total` to chase).
 */
async function fetchWholeCatalog(
  client: ReturnType<typeof createClient>,
): Promise<SkillCatalogItem[]> {
  const PAGE_SIZE = 200;
  const all: SkillCatalogItem[] = [];
  for (let page = 1; ; page++) {
    const res = (await client.listSkills({ page, limit: PAGE_SIZE })) as
      | SkillCatalogPage
      | SkillCatalogItem[];
    const items = normalizeCatalog(res as SkillCatalogPage);
    all.push(...items);
    const total = Array.isArray(res) ? items.length : res.total;
    if (items.length === 0 || all.length >= (total ?? all.length)) break;
  }
  return all;
}

function normalizeCatalog(
  res: SkillCatalogItem[] | SkillCatalogPage,
): SkillCatalogItem[] {
  return Array.isArray(res) ? res : res.items;
}

export function registerSkillCommands(program: Command): void {
  const skills = program
    .command('skills')
    .description('Browse and install Devic skills into your coding agents');

  // skills list
  skills
    .command('list')
    .alias('ls')
    .description('List available skills from Devic')
    .option('--tag <tag...>', 'Filter by tag (repeatable)')
    .option('--search <text>', 'Free-text search over name/description')
    .option('--project <projectId>', 'Filter by project id')
    .option('--limit <n>', 'Page size (max 200, default 100)')
    .option('--page <n>', '1-based page number')
    .action(
      withAction(
        async (opts: unknown) => {
          const o = opts as {
            tag?: string[];
            search?: string;
            project?: string;
            limit?: string;
            page?: string;
          };
          const client = createClient();
          const res = (await client.listSkills({
            tags: o.tag,
            search: o.search,
            projectId: o.project,
            // A page size is always sent: it is what makes the API return the
            // usage stats (linked agents/assistants, installs) shown below.
            limit: o.limit ? Math.max(1, Math.min(200, Number(o.limit) || 100)) : 100,
            page: o.page ? Math.max(1, Number(o.page) || 1) : undefined,
          })) as SkillCatalogPage | SkillCatalogItem[];
          return res;
        },
        (d) => {
          const items = normalizeCatalog(d as SkillCatalogPage);
          if (!items.length) return '_No skills found._';
          return [
            md.h(2, 'Skills'),
            '',
            md.table(
              items.map((s) => ({
                id: s.id,
                name: s.name,
                type: s.type,
                tags: (s.tags || []).join(', ') || '-',
                agents: s.linkedAgentsCount ?? 0,
                assistants: s.linkedAssistantsCount ?? 0,
                reads: s.readCount ?? 0,
                description:
                  (s.description || '').length > 60
                    ? `${s.description.slice(0, 57)}...`
                    : s.description || '-',
              })),
              {
                columns: [
                  'id',
                  'name',
                  'type',
                  'tags',
                  'agents',
                  'assistants',
                  'reads',
                  'description',
                ],
              },
            ),
          ].join('\n');
        },
      ),
    );

  // skills tags
  skills
    .command('tags')
    .description('List the distinct tags across skills')
    .option('--project <projectId>', 'Filter by project id')
    .action(
      withAction(
        async (opts: unknown) => {
          const o = opts as { project?: string };
          const client = createClient();
          return client.listSkillTags(o.project);
        },
        (d) => {
          const tags = (d as string[]) ?? [];
          if (!tags.length) return '_No tags found._';
          return [md.h(2, 'Skill tags'), '', tags.map((t) => `- ${t}`).join('\n')].join(
            '\n',
          );
        },
      ),
    );

  // skills install <skill>
  skills
    .command('install <skill>')
    .alias('add')
    .description(
      'Install a skill (by id or name) into your coding agents. Downloads its whole tree into a folder named after the skill.',
    )
    .option(
      '-a, --agent <agents...>',
      `Target agents: ${ALL_AGENTS.join(', ')}, or "*" for all. Auto-detected when omitted.`,
    )
    .option('-g, --global', 'Install to the user-level (global) agent directories')
    .action(
      withAction(
        async (skill: unknown, opts: unknown) => {
          const ref = skill as string;
          const o = opts as { agent?: string[]; global?: boolean };
          const client = createClient();

          // Resolve the skill by id or (case-insensitive) name.
          const catalog = await fetchWholeCatalog(client);
          const match = resolveSkill(catalog, ref);

          const agents = resolveAgents(o.agent);
          const global = !!o.global;
          const scope = global ? 'global' : 'project';
          const lock = readLockfile(global);
          const prev = lock.skills[match.id];

          const tree = await client.installSkill(match.id, match.type, {
            agents,
            scope,
            cliVersion,
          });
          const paths = writeSkillTree(tree, agents, global, prev?.paths);

          // Record in the local lockfile so `update` knows what to refresh.
          const now = new Date().toISOString();
          lock.skills[match.id] = {
            id: match.id,
            name: tree.skill.name,
            type: match.type,
            version: tree.version,
            agents,
            scope,
            installedAt: prev?.installedAt ?? now,
            updatedAt: now,
            paths,
          };
          writeLockfile(global, lock);

          return {
            installed: tree.skill.name,
            id: match.id,
            type: match.type,
            version: tree.version,
            files: tree.files.length,
            agents,
            scope,
            directories: Object.values(paths),
          };
        },
        (d) => {
          const r = d as {
            installed: string;
            files: number;
            agents: string[];
            scope: string;
            directories: string[];
          };
          return [
            md.success(
              `Installed ${md.b(r.installed)} (${r.files} file${r.files !== 1 ? 's' : ''}) for ${r.agents.join(', ')} [${r.scope}]`,
            ),
            '',
            ...r.directories.map((dir) => `- ${md.code(dir)}`),
          ].join('\n');
        },
      ),
    );

  // skills update [skill]
  skills
    .command('update [skill]')
    .description(
      'Update installed skills to their latest version. Updates all installed skills when no skill is given.',
    )
    .option('-g, --global', 'Operate on the user-level (global) install registry')
    .action(
      withAction(
        async (skill: unknown, opts: unknown) => {
          const ref = skill as string | undefined;
          const o = opts as { global?: boolean };
          const global = !!o.global;
          const client = createClient();
          const lock = readLockfile(global);

          let entries = Object.values(lock.skills);
          if (ref) {
            entries = entries.filter(
              (e) =>
                e.id === ref ||
                e.name.toLowerCase() === ref.toLowerCase(),
            );
            if (!entries.length) {
              throw new Error(
                `Skill "${ref}" is not installed in the ${global ? 'global' : 'project'} scope.`,
              );
            }
          }
          if (!entries.length) {
            return { updated: [], upToDate: [], scope: global ? 'global' : 'project' };
          }

          const updated: string[] = [];
          const upToDate: string[] = [];
          for (const entry of entries) {
            // Goes through install (not the plain tree download) so the server
            // knows this user is still on the skill and which version they now
            // hold — otherwise an updated copy would keep looking stale.
            const tree = await client.installSkill(entry.id, entry.type, {
              agents: entry.agents,
              scope: entry.scope,
              cliVersion,
            });
            if (tree.version === entry.version) {
              upToDate.push(entry.name);
              continue;
            }
            entry.paths = writeSkillTree(tree, entry.agents, global, entry.paths);
            entry.name = tree.skill.name;
            entry.version = tree.version;
            entry.updatedAt = new Date().toISOString();
            updated.push(entry.name);
          }
          writeLockfile(global, lock);
          return {
            updated,
            upToDate,
            scope: global ? 'global' : 'project',
          };
        },
        (d) => {
          const r = d as {
            updated: string[];
            upToDate: string[];
            scope: string;
          };
          const lines = [md.h(2, `Skills update (${r.scope})`), ''];
          if (r.updated.length)
            lines.push(md.success(`Updated: ${r.updated.join(', ')}`));
          if (r.upToDate.length)
            lines.push(`_Up to date: ${r.upToDate.join(', ')}_`);
          if (!r.updated.length && !r.upToDate.length)
            lines.push('_No installed skills to update._');
          return lines.join('\n');
        },
      ),
    );

  // skills uninstall <skill>
  skills
    .command('uninstall <skill>')
    .alias('remove')
    .alias('rm')
    .description(
      'Uninstall a skill: removes its files from your coding agents and drops it from the local registry.',
    )
    .option(
      '-a, --agent <agents...>',
      'Only uninstall from these agents (all the agents it was installed for when omitted)',
    )
    .option('-g, --global', 'Operate on the user-level (global) install registry')
    .action(
      withAction(
        async (skill: unknown, opts: unknown) => {
          const ref = skill as string;
          const o = opts as { agent?: string[]; global?: boolean };
          const global = !!o.global;
          const scope = global ? 'global' : 'project';

          const lock = readLockfile(global);
          const entry = Object.values(lock.skills).find(
            (e) => e.id === ref || e.name.toLowerCase() === ref.toLowerCase(),
          );
          if (!entry) {
            throw new Error(
              `Skill "${ref}" is not installed in the ${scope} scope. Run "devic skills installed${global ? ' --global' : ''}" to see what is.`,
            );
          }

          const targets = o.agent?.length
            ? entry.agents.filter((a) => o.agent!.includes(a))
            : entry.agents;
          if (!targets.length) {
            throw new Error(
              `${entry.name} is not installed for ${o.agent!.join(', ')}. Installed for: ${entry.agents.join(', ')}.`,
            );
          }

          const removed: string[] = [];
          for (const agent of targets) {
            const dir = skillDirFor(entry, agent);
            if (existsSync(dir)) {
              rmSync(dir, { recursive: true, force: true });
              removed.push(dir);
            }
          }

          // Keep the entry alive while any other agent still holds the skill.
          const remaining = entry.agents.filter((a) => !targets.includes(a));
          if (remaining.length) {
            entry.agents = remaining;
            for (const agent of targets) delete entry.paths?.[agent];
            entry.updatedAt = new Date().toISOString();
          } else {
            delete lock.skills[entry.id];
          }
          writeLockfile(global, lock);

          // Tell the server only once the skill is fully gone from this scope —
          // it tracks (user, skill, scope), not individual agents. Best-effort:
          // the files are already gone, so a server hiccup must not fail the
          // command, but the user should know their admin still sees it.
          let recorded = true;
          let recordError: string | undefined;
          if (!remaining.length) {
            try {
              await createClient().uninstallSkill(entry.id, scope);
            } catch (err) {
              recorded = false;
              recordError = err instanceof Error ? err.message : String(err);
            }
          }

          return {
            uninstalled: entry.name,
            id: entry.id,
            agents: targets,
            remainingAgents: remaining,
            scope,
            directories: removed,
            recorded,
            recordError,
          };
        },
        (d) => {
          const r = d as {
            uninstalled: string;
            agents: string[];
            remainingAgents: string[];
            scope: string;
            directories: string[];
            recorded: boolean;
            recordError?: string;
          };
          const lines = [
            md.success(
              `Uninstalled ${md.b(r.uninstalled)} from ${r.agents.join(', ')} [${r.scope}]`,
            ),
            '',
            ...r.directories.map((dir) => `- ${md.code(dir)}`),
          ];
          if (r.remainingAgents.length) {
            lines.push('', `_Still installed for: ${r.remainingAgents.join(', ')}_`);
          }
          if (!r.recorded) {
            lines.push(
              '',
              `_Files removed, but Devic could not be notified (${r.recordError}). It may still list this skill as installed for you._`,
            );
          }
          return lines.join('\n');
        },
      ),
    );

  // skills create <name>
  skills
    .command('create <name>')
    .description(
      'Create a folder-skill: the folder plus its SKILL.md manifest, with the name/description frontmatter already written.',
    )
    .option('-d, --description <text>', 'One-line description. Phrase it as a trigger ("How to … when …") — it is what the model sees before deciding to load the skill.')
    .option('--tags <tags...>', 'Category tags')
    .option('--project <projectId>', 'Scope the skill to a project')
    .option('--parent <folderId>', 'Create it inside an existing folder')
    .option('--from-file <path>', 'Replace the generated manifest with this markdown file')
    .action(
      withAction(
        async (name: unknown, opts: unknown) => {
          const o = opts as {
            description?: string;
            tags?: string[];
            project?: string;
            parent?: string;
            fromFile?: string;
          };
          const client = createClient();
          const created = await client.scaffoldSkill({
            name: name as string,
            description: o.description,
            tags: o.tags,
            projectId: o.project,
            parentFolderId: o.parent,
          });

          // The scaffold writes a stub manifest; --from-file replaces its body in
          // place so the caller ends up with one skill, not a skill plus a
          // stray document.
          if (o.fromFile) {
            const skillDocId = String(
              (created.skillDoc as { _id?: unknown })?._id ?? '',
            );
            if (!skillDocId) {
              throw new Error(
                'The skill was created but its SKILL.md id was not returned, so --from-file could not be applied. Update the manifest manually.',
              );
            }
            await client.updateDocument(skillDocId, {
              markdownContent: readFileSync(o.fromFile, 'utf-8'),
            });
          }
          return created;
        },
        (d) => {
          const r = d as { folder?: any; skillDoc?: any };
          return [
            md.success(`Skill created: ${md.b(r.folder?.name ?? '-')}`),
            '',
            `- id: ${md.code(String(r.folder?._id ?? '-'))} (use it with \`type: "folder"\`)`,
            `- manifest: ${md.code(String(r.skillDoc?._id ?? '-'))}`,
            '',
            '_Attach it with `knowledgeSkills`, and grant the Advanced knowledge search tool group so the model can load it on demand._',
          ].join('\n');
        },
      ),
    );

  // skills get <skill>
  skills
    .command('get <skill>')
    .description('Show one skill from the catalog (by id or name)')
    .action(
      withAction(
        async (skill: unknown) => {
          const client = createClient();
          const catalog = await fetchWholeCatalog(client);
          return resolveSkill(catalog, skill as string);
        },
        (d) => {
          const s = d as SkillCatalogItem;
          const lines = [
            md.h(2, s.name),
            '',
            s.description || '_No description._',
            '',
            `- id: ${md.code(s.id)}`,
            `- type: ${s.type}`,
            `- tags: ${(s.tags || []).join(', ') || '-'}`,
            `- linked: ${s.linkedAgentsCount ?? 0} agent(s), ${s.linkedAssistantsCount ?? 0} assistant(s)`,
            `- reads: ${s.readCount ?? 0}`,
          ];
          if ((s as any).github) {
            const g = (s as any).github;
            lines.push(
              `- github: ${g.owner}/${g.repo}/${g.path} @ ${g.ref} (read-only, cached 5 min)`,
            );
          }
          return lines.join('\n');
        },
      ),
    );

  // skills tree <skill>
  skills
    .command('tree <skill>')
    .description('Show the files of a skill (what an install would download), without recording an install')
    .option('--out <dir>', 'Also write the files to this directory')
    .action(
      withAction(
        async (skill: unknown, opts: unknown) => {
          const o = opts as { out?: string };
          const client = createClient();
          const catalog = await fetchWholeCatalog(client);
          const match = resolveSkill(catalog, skill as string);
          const tree = await client.getSkillTree(match.id, match.type);

          if (o.out) {
            for (const file of tree.files) {
              const target = join(o.out, file.path);
              mkdirSync(dirname(target), { recursive: true });
              writeFileSync(target, file.content, 'utf-8');
            }
          }
          return tree;
        },
        (d) => {
          const t = d as SkillTree;
          return [
            md.h(2, `${t.skill.name} (${t.skill.type})`),
            '',
            `version: ${md.code(t.version)}`,
            '',
            ...t.files.map((f) => `- ${md.code(f.path)} (${f.content.length} chars)`),
          ].join('\n');
        },
      ),
    );

  // skills installed
  skills
    .command('installed')
    .description('List skills installed on this machine (from the local registry)')
    .option('-g, --global', 'Show the user-level (global) registry')
    .action(
      withAction(
        async (opts: unknown) => {
          const o = opts as { global?: boolean };
          const lock = readLockfile(!!o.global);
          return Object.values(lock.skills);
        },
        (d) => {
          const items = (d as LockEntry[]) ?? [];
          if (!items.length) return '_No skills installed._';
          return [
            md.h(2, 'Installed skills'),
            '',
            md.table(
              items.map((e) => ({
                name: e.name,
                type: e.type,
                version: e.version,
                agents: e.agents.join(', '),
                scope: e.scope,
                updated: new Date(e.updatedAt).toLocaleString(),
              })),
              { columns: ['name', 'type', 'version', 'agents', 'scope', 'updated'] },
            ),
          ].join('\n');
        },
      ),
    );
}

/** Resolves a skill reference (id or name) against the catalog. */
function resolveSkill(
  catalog: SkillCatalogItem[],
  ref: string,
): SkillCatalogItem {
  const byId = catalog.find((s) => s.id === ref);
  if (byId) return byId;
  const byName = catalog.filter(
    (s) => s.name.toLowerCase() === ref.toLowerCase(),
  );
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(
      `Multiple skills named "${ref}". Install by id instead: ${byName
        .map((s) => s.id)
        .join(', ')}`,
    );
  }
  throw new Error(`Skill "${ref}" not found. Run "devic skills list" to see options.`);
}

/** Resolves the target agents from the flag, "*", or auto-detection. */
function resolveAgents(flag?: string[]): string[] {
  if (flag?.length) {
    if (flag.includes('*')) return ALL_AGENTS;
    const invalid = flag.filter((a) => !AGENT_DIRS[a]);
    if (invalid.length) {
      throw new Error(
        `Unknown agent(s): ${invalid.join(', ')}. Valid: ${ALL_AGENTS.join(', ')}`,
      );
    }
    return flag;
  }
  const detected = detectAgents();
  // Fall back to Claude Code when nothing is detected, so install never no-ops.
  return detected.length ? detected : ['claude-code'];
}

import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { createClient, withAction } from '../helpers.js';
import { md } from '../output.js';
import type {
  SkillCatalogItem,
  SkillCatalogPage,
  SkillTree,
} from '../types.js';

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
 * agent recognizes them. Returns the absolute skill directories written.
 */
function writeSkillTree(
  tree: SkillTree,
  agents: string[],
  global: boolean,
): string[] {
  const folder = skillFolderName(tree.skill.name);
  const written: string[] = [];
  for (const agent of agents) {
    const skillDir = join(agentSkillsDir(agent, global), folder);
    // Replace any previous copy so updates don't leave stale files behind.
    if (existsSync(skillDir)) rmSync(skillDir, { recursive: true, force: true });
    for (const file of tree.files) {
      const relPath =
        tree.skill.type === 'document' && tree.files.length === 1
          ? 'SKILL.md'
          : file.path;
      const dest = join(skillDir, relPath);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.content ?? '');
    }
    written.push(skillDir);
  }
  return written;
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
    .action(
      withAction(
        async (opts: unknown) => {
          const o = opts as {
            tag?: string[];
            search?: string;
            project?: string;
          };
          const client = createClient();
          const res = (await client.listSkills({
            tags: o.tag,
            search: o.search,
            projectId: o.project,
            limit: 100,
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
          const catalog = normalizeCatalog(
            (await client.listSkills({})) as SkillCatalogItem[],
          );
          const match = resolveSkill(catalog, ref);

          const agents = resolveAgents(o.agent);
          const tree = await client.installSkill(match.id, match.type);
          const dirs = writeSkillTree(tree, agents, !!o.global);

          // Record in the local lockfile so `update` knows what to refresh.
          const global = !!o.global;
          const lock = readLockfile(global);
          const now = new Date().toISOString();
          const prev = lock.skills[match.id];
          lock.skills[match.id] = {
            id: match.id,
            name: tree.skill.name,
            type: match.type,
            version: tree.version,
            agents,
            scope: global ? 'global' : 'project',
            installedAt: prev?.installedAt ?? now,
            updatedAt: now,
          };
          writeLockfile(global, lock);

          return {
            installed: tree.skill.name,
            id: match.id,
            type: match.type,
            version: tree.version,
            files: tree.files.length,
            agents,
            scope: global ? 'global' : 'project',
            directories: dirs,
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
            const tree = await client.getSkillTree(entry.id, entry.type);
            if (tree.version === entry.version) {
              upToDate.push(entry.name);
              continue;
            }
            writeSkillTree(tree, entry.agents, global);
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

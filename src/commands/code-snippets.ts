import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { Command } from 'commander';
import { createClient, withAction, readJsonInput, readTextStdin } from '../helpers.js';
import { md } from '../output.js';
import { DevicCliError } from '../errors.js';

const LANGUAGES = ['javascript', 'typescript', 'python'];
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.py': 'python',
};
const FENCE: Record<string, string> = {
  javascript: 'js',
  typescript: 'ts',
  python: 'python',
};

/** `-` reads stdin, anything else is a path. */
async function readText(path: string): Promise<string> {
  return path === '-' ? readTextStdin() : readFileSync(path, 'utf-8');
}

/** A JSON value given inline (`{...}`, `[...]`) or as a file path. */
async function readJsonArg(value: string, flag: string): Promise<unknown> {
  const trimmed = value.trim();
  try {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
    return value === '-' ? JSON.parse(await readTextStdin()) : readJsonInput(value);
  } catch (err) {
    throw new DevicCliError(
      `${flag}: not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
      'INVALID_USAGE',
    );
  }
}

function languageOf(explicit: string | undefined, codeFile: string | undefined): string | undefined {
  if (explicit) {
    if (!LANGUAGES.includes(explicit)) {
      throw new DevicCliError(
        `--language must be one of ${LANGUAGES.join(', ')}.`,
        'INVALID_USAGE',
      );
    }
    return explicit;
  }
  return codeFile ? LANGUAGE_BY_EXTENSION[extname(codeFile).toLowerCase()] : undefined;
}

function tagsOf(value?: string): string[] | undefined {
  if (value == null) return undefined;
  return value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function formatSnippet(s: any): string {
  const lines = [
    md.h(2, `Snippet: ${s.name}`),
    '',
    `**ID:** ${md.code(s.id)}`,
    `**Tool name:** ${md.code(s.toolName)}`,
    `**Language:** ${s.language}`,
    `**Enabled:** ${s.enabled ? 'Yes' : 'No'}`,
    `**Version:** ${s.version}`,
  ];
  if (s.tags?.length) lines.push(`**Tags:** ${s.tags.join(', ')}`);
  if (s.projectId) lines.push(`**Project:** ${md.code(s.projectId)}`);
  if (s.updatedAt) lines.push(`**Updated:** ${s.updatedAt}`);
  if (s.lastTest) {
    lines.push(`**Last test:** ${s.lastTest.passed} passed, ${s.lastTest.failed} failed`);
  }
  if (s.description) lines.push('', s.description);
  if (s.parameters) {
    lines.push('', md.h(3, 'Parameters'), md.codeBlock(JSON.stringify(s.parameters, null, 2), 'json'));
  }
  if (s.code != null) {
    lines.push('', md.h(3, 'Code'), md.codeBlock(s.code, FENCE[s.language] ?? ''));
  }
  if (s.testCases?.length) {
    lines.push(
      '',
      md.h(3, 'Test cases'),
      ...s.testCases.map((c: any) => `- ${c.name}: ${md.code(JSON.stringify(c.input))}`),
    );
  }
  return lines.join('\n');
}

/** The fields shared by create and update, from flags and an optional --from-json. */
async function snippetBody(o: {
  fromJson?: string;
  name?: string;
  description?: string;
  language?: string;
  codeFile?: string;
  code?: string;
  parameters?: string;
  tags?: string;
  project?: string;
}): Promise<Record<string, unknown>> {
  const base = o.fromJson ? await readJsonInput(o.fromJson) : {};
  if (o.codeFile && o.code != null) {
    throw new DevicCliError('Pass only one of --code-file / --code.', 'INVALID_USAGE');
  }
  const code = o.codeFile ? await readText(o.codeFile) : o.code;
  const language = languageOf(o.language, o.codeFile);
  const parameters = o.parameters ? await readJsonArg(o.parameters, '--parameters') : undefined;
  return {
    ...base,
    ...(o.name != null && { name: o.name }),
    ...(o.description != null && { description: o.description }),
    ...(language && { language }),
    ...(code != null && { code }),
    ...(parameters !== undefined && { parameters }),
    ...(o.tags != null && { tags: tagsOf(o.tags) }),
    ...(o.project && { projectId: o.project }),
  };
}

const CONTENT_OPTIONS: [string, string][] = [
  ['--name <name>', 'snake_case name, also the tool name the model calls'],
  ['--description <text>', 'What the tool does and when to use it'],
  ['--language <lang>', 'javascript | typescript | python (inferred from --code-file)'],
  ['--code-file <file>', 'Source file defining main(input) (- for stdin)'],
  ['--code <source>', 'Source code inline'],
  ['--parameters <json|file>', 'JSON Schema of the input object, inline or a file'],
  ['--tags <a,b>', 'Comma-separated tags'],
  ['--from-json <file>', 'Full payload: name, description, language, code, parameters, tags, testCases, enabled, projectId (- for stdin)'],
];

export function registerCodeSnippetCommands(program: Command): void {
  const snippets = program
    .command('snippets')
    .alias('code-snippets')
    .description(
      'Manage code snippets — functions attached to agents and assistants as tools (codeSnippetIds)',
    );

  // snippets list
  snippets
    .command('list')
    .description('List code snippets (without their code)')
    .option('--search <text>', 'Search the name and description')
    .option('--language <lang>', 'javascript | typescript | python')
    .option('--enabled', 'Only enabled snippets')
    .option('--disabled', 'Only disabled snippets')
    .option('--tag <tag>', 'Only snippets with this tag')
    .option('--project <id>', 'Only snippets of this project')
    .option('--limit <n>', 'Page size (max 100)')
    .option('--offset <n>', 'Items to skip')
    .action(
      withAction(async (opts: unknown) => {
        const o = opts as {
          search?: string;
          language?: string;
          enabled?: boolean;
          disabled?: boolean;
          tag?: string;
          project?: string;
          limit?: string;
          offset?: string;
        };
        if (o.enabled && o.disabled) {
          throw new DevicCliError('Pass only one of --enabled / --disabled.', 'INVALID_USAGE');
        }
        const client = createClient();
        return client.listCodeSnippets({
          search: o.search,
          language: o.language,
          enabled: o.enabled ? 'true' : o.disabled ? 'false' : 'all',
          tag: o.tag,
          projectId: o.project,
          limit: o.limit ? Number(o.limit) : undefined,
          offset: o.offset ? Number(o.offset) : undefined,
        });
      }, (d) => {
        const data = d as any;
        const items = data.snippets ?? [];
        if (items.length === 0) return '_No code snippets found._';
        const lines = [
          md.h(2, 'Code snippets'),
          '',
          md.table(
            items.map((s: any) => ({
              id: s.id,
              toolName: s.toolName,
              language: s.language,
              enabled: s.enabled ? 'yes' : 'no',
              version: s.version,
              description: s.description,
            })),
            { columns: ['id', 'toolName', 'language', 'enabled', 'version', 'description'], maxColWidth: 60 },
          ),
        ];
        if (data.total != null) lines.push('', md.info(`${data.total} snippet(s)`));
        return lines.join('\n');
      }),
    );

  // snippets get <id>
  snippets
    .command('get <id>')
    .description('Get a code snippet with its code, parameters and test cases')
    .option('--code-only', 'Print only the source code (to redirect into a file)')
    .action(
      withAction(async (id: unknown, opts: unknown) => {
        const client = createClient();
        const snippet = (await client.getCodeSnippet(id as string)) as any;
        if ((opts as { codeOnly?: boolean }).codeOnly) {
          process.stdout.write(snippet.code.endsWith('\n') ? snippet.code : snippet.code + '\n');
          return undefined;
        }
        return snippet;
      }, (d) => formatSnippet(d)),
    );

  // snippets create
  const create = snippets
    .command('create')
    .description('Create a code snippet');
  for (const [flag, help] of CONTENT_OPTIONS) create.option(flag, help);
  create
    .option('--project <id>', 'Project to file it under')
    .option('--disabled', 'Create it disabled')
    .action(
      withAction(async (opts: unknown) => {
        const o = opts as Parameters<typeof snippetBody>[0] & { disabled?: boolean };
        const body = await snippetBody(o);
        if (o.disabled) body.enabled = false;
        const missing = ['name', 'description', 'language', 'code', 'parameters'].filter(
          (key) => body[key] == null || body[key] === '',
        );
        if (missing.length) {
          throw new DevicCliError(
            `Missing ${missing.join(', ')}. Pass them as flags or in --from-json.`,
            'INVALID_USAGE',
          );
        }
        const client = createClient();
        return client.createCodeSnippet(body);
      }, (d) => {
        const s = d as any;
        return [md.success(`Snippet created: ${md.code(s.id)}`), '', formatSnippet(s)].join('\n');
      }),
    );

  // snippets update <id>
  const update = snippets
    .command('update <id>')
    .description('Update a code snippet (only the fields given change)');
  for (const [flag, help] of CONTENT_OPTIONS) update.option(flag, help);
  update
    .option('--enabled', 'Enable the snippet')
    .option('--disabled', 'Disable the snippet')
    .option('--test-cases <json|file>', 'Replace the saved test cases: [{ "name", "input" }]')
    .option('--expected-version <n>', 'Fail with 409 if the snippet is no longer at this version')
    .action(
      withAction(async (id: unknown, opts: unknown) => {
        const o = opts as Parameters<typeof snippetBody>[0] & {
          enabled?: boolean;
          disabled?: boolean;
          testCases?: string;
          expectedVersion?: string;
        };
        if (o.enabled && o.disabled) {
          throw new DevicCliError('Pass only one of --enabled / --disabled.', 'INVALID_USAGE');
        }
        const body = await snippetBody(o);
        if (o.enabled) body.enabled = true;
        if (o.disabled) body.enabled = false;
        if (o.testCases) body.testCases = await readJsonArg(o.testCases, '--test-cases');
        if (o.expectedVersion) body.expectedVersion = Number(o.expectedVersion);
        if (!Object.keys(body).length) {
          throw new DevicCliError('Nothing to update.', 'INVALID_USAGE');
        }
        const client = createClient();
        return client.updateCodeSnippet(id as string, body);
      }, (d) => {
        const s = d as any;
        return [md.success(`Snippet updated (version ${s.version}).`), '', formatSnippet(s)].join('\n');
      }),
    );

  // snippets delete <id>
  snippets
    .command('delete <id>')
    .description('Delete a code snippet')
    .action(
      withAction(async (id: unknown) => {
        const client = createClient();
        return client.deleteCodeSnippet(id as string);
      }, (d) => {
        const r = d as any;
        const users = [
          ...(r.usedBy?.agents ?? []).map((a: any) => `agent ${a.name} (${a._id})`),
          ...(r.usedBy?.assistants ?? []).map((a: any) => `assistant ${a.name} (${a._id})`),
        ];
        const lines = [md.success(`Snippet ${md.code(r.id)} deleted.`)];
        if (users.length) {
          lines.push(
            '',
            md.warn('Still listed in codeSnippetIds of (they no longer get the tool):'),
            md.list(users),
          );
        }
        return lines.join('\n');
      }),
    );

  // snippets test <id>
  snippets
    .command('test <id>')
    .description('Run a saved snippet in a sandbox. Exits 1 if any run fails.')
    .option(
      '--input <json|file>',
      'An input object for main(input); repeat for several runs',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option('--inputs-file <file>', 'JSON array of input objects')
    .option('--timeout <ms>', 'Timeout per run, 1000-30000 ms')
    .addHelpText('after', '\nWithout --input or --inputs-file, the saved test cases run.')
    .action(
      withAction(async (id: unknown, opts: unknown) => {
        const o = opts as { input?: string[]; inputsFile?: string; timeout?: string };
        const inputs: Record<string, unknown>[] = [];
        for (const value of o.input ?? []) {
          inputs.push((await readJsonArg(value, '--input')) as Record<string, unknown>);
        }
        if (o.inputsFile) {
          const list = await readJsonArg(o.inputsFile, '--inputs-file');
          if (!Array.isArray(list)) {
            throw new DevicCliError('--inputs-file must hold a JSON array.', 'INVALID_USAGE');
          }
          inputs.push(...(list as Record<string, unknown>[]));
        }
        const client = createClient();
        const result = (await client.testCodeSnippet(id as string, {
          ...(inputs.length && { inputs }),
          ...(o.timeout && { timeout: Number(o.timeout) }),
        })) as any;
        // A failing run is a result, not an API error — but scripts need to see it.
        if (result?.failed > 0) process.exitCode = 1;
        return result;
      }, (d) => {
        const r = d as any;
        const lines = [md.h(2, `Test: ${r.passed} passed, ${r.failed} failed`)];
        (r.results ?? []).forEach((run: any, i: number) => {
          lines.push(
            '',
            md.h(3, `${run.success ? '[OK]' : '[XX]'} Run ${i + 1} — ${run.executionTimeMs} ms`),
            `**Input:** ${md.code(JSON.stringify(run.input))}`,
          );
          if (run.success) {
            lines.push(md.codeBlock(JSON.stringify(run.output, null, 2), 'json'));
          } else {
            lines.push(`**Error:** ${run.error}`);
          }
          if (run.logs) lines.push('**Logs:**', md.codeBlock(run.logs));
        });
        return lines.join('\n');
      }),
    );
}

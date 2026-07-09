import { readFileSync } from 'node:fs';
import { DevicApiClient } from './client.js';
import { DevicCliError } from './errors.js';
import { DevicApiError } from './errors.js';
import { loadConfig, saveConfig } from './config.js';
import { output, outputError } from './output.js';
import { EXIT_CODES } from './types.js';
import { refreshAccessToken } from './oauth.js';
import { assertValidPayload, type EntityKind } from './validation.js';
import type { Command } from 'commander';

const ACCESS_TOKEN_REFRESH_SKEW_MS = 60 * 1000; // refresh if <60s left

/** Create an authenticated API client from config/env */
export function createClient(): DevicApiClient {
  const config = loadConfig();
  const baseUrl = config.baseUrl ?? 'https://api.devic.ai';

  if (config.oauth?.accessToken) {
    return new DevicApiClient({
      apiKey: config.oauth.accessToken,
      baseUrl,
      refreshToken: async () => {
        const fresh = await loadConfig();
        if (!fresh.oauth?.refreshToken) {
          throw new DevicCliError(
            'OAuth session expired. Run `devic auth login` to re-authenticate.',
            'AUTH_REQUIRED',
            EXIT_CODES.AUTH_REQUIRED,
          );
        }
        const tokens = await refreshAccessToken({
          baseUrl,
          clientId: fresh.oauth.clientId,
          refreshToken: fresh.oauth.refreshToken,
        });
        saveConfig({ oauth: tokens });
        return tokens.accessToken;
      },
      shouldRefreshProactively: () =>
        !!config.oauth &&
        config.oauth.expiresAt - Date.now() < ACCESS_TOKEN_REFRESH_SKEW_MS,
    });
  }

  if (!config.apiKey) {
    throw new DevicCliError(
      'Not authenticated. Run `devic auth login` (or `devic auth login --api-key <key>` for legacy auth).',
      'AUTH_REQUIRED',
      EXIT_CODES.AUTH_REQUIRED,
    );
  }
  return new DevicApiClient({ apiKey: config.apiKey, baseUrl });
}

/** Read raw text from stdin until EOF. */
export async function readTextStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * True when stdin is piped or redirected (e.g. `cmd < file`, `cat file | cmd`)
 * rather than attached to an interactive terminal. Used to auto-read content
 * from stdin when no explicit content flag is given.
 */
export function isStdinPiped(): boolean {
  return process.stdin.isTTY !== true;
}

/** Read JSON from a file path or stdin (when path is "-") */
export async function readJsonInput(path: string): Promise<Record<string, unknown>> {
  if (path === '-') {
    return JSON.parse(await readTextStdin());
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Read JSON input and validate its top-level fields against the entity schema.
 * Throws DevicCliError with an actionable, multi-line message if the payload
 * uses wrong field names (e.g. `systemPrompt` instead of `assistantSpecialization.presets`).
 *
 * Pass `{ skip: true }` to bypass validation (wired to the `--skip-validation` flag).
 */
export async function readAndValidateJson(
  path: string,
  entity: EntityKind,
  opts: { skip?: boolean } = {},
): Promise<Record<string, unknown>> {
  const data = await readJsonInput(path);
  assertValidPayload(entity, data, opts);
  return data;
}

/**
 * Adds a `--skip-validation` flag to a create/update command that accepts `--from-json`.
 * Use together with {@link readAndValidateJson}.
 */
export function addSkipValidationOption(cmd: Command): Command {
  return cmd.option(
    '--skip-validation',
    'Skip client-side payload validation (use when sending fields newer than this CLI knows about).',
  );
}

/**
 * Wraps a command action with standard error handling and output.
 * `fn` receives the parsed args/opts and returns the data to output.
 */
export function withAction<T>(
  fn: (...args: unknown[]) => Promise<T>,
  humanFn?: (d: T) => string,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    try {
      const result = await fn(...args);
      if (result !== undefined) {
        output(result, humanFn as ((d: unknown) => string) | undefined);
      }
    } catch (err: unknown) {
      if (err instanceof DevicApiError) {
        outputError(err.toJSON());
        process.exit(err.statusCode === 401 ? EXIT_CODES.AUTH_REQUIRED : EXIT_CODES.ERROR);
      }
      if (err instanceof DevicCliError) {
        outputError(err.toJSON());
        process.exit(err.exitCode);
      }
      const message = err instanceof Error ? err.message : String(err);
      outputError({ error: message, code: 'UNKNOWN_ERROR' });
      process.exit(EXIT_CODES.ERROR);
    }
  };
}

/** True when the value is already a Mongo ObjectId (24 hex chars). */
export function isObjectId(value: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(value);
}

/**
 * Resolve a user-supplied project reference to its canonical ObjectId.
 *
 * Accepts an `_id` (passed through untouched, no API call), an `identifier`,
 * or a `name`. Identifiers/names are matched case-insensitively against
 * `projects list` (including archived). Throws an actionable error listing the
 * available projects when nothing matches, so the agent knows what to use.
 */
export async function resolveProjectId(
  client: DevicApiClient,
  value: string,
): Promise<string> {
  if (isObjectId(value)) return value;

  const needle = value.trim().toLowerCase();
  const matchIn = (projects: ProjectRef[]): ProjectRef | undefined =>
    projects.find((p) => (p.identifier ?? '').toLowerCase() === needle) ??
    projects.find((p) => (p.name ?? '').toLowerCase() === needle);

  // Active projects are the common case (the API's `archived` filter is
  // exclusive: archived:true returns ONLY archived ones). Try active first and
  // only pay for a second request — over archived — when there's no match.
  const active = await fetchProjects(client, false);
  const match = matchIn(active) ?? matchIn(await fetchProjects(client, true));
  if (match?._id) return match._id;

  const available = active
    .map((p) => p.identifier || p._id)
    .filter(Boolean)
    .join(', ');
  throw new DevicCliError(
    `No project matches "${value}". Pass a project _id, identifier, or name.` +
      (available ? ` Available: ${available}.` : ' Run `devic projects list` to see them.'),
    'PROJECT_NOT_FOUND',
    EXIT_CODES.ERROR,
  );
}

async function fetchProjects(
  client: DevicApiClient,
  archived: boolean,
): Promise<ProjectRef[]> {
  const data = (await client.listProjects({
    ...(archived ? { archived: true } : {}),
    limit: 1000,
  })) as { projects?: ProjectRef[] } | ProjectRef[];
  return Array.isArray(data) ? data : data?.projects ?? [];
}

interface ProjectRef {
  _id?: string;
  identifier?: string;
  name?: string;
}

/** Add common list options to a command */
export function addListOptions(cmd: Command): Command {
  return cmd
    .option('--offset <n>', 'Number of items to skip', '0')
    .option('--limit <n>', 'Maximum items to return', '10');
}

/** Parse list options to numbers */
export function parseListOpts(opts: { offset?: string; limit?: string }): { offset: number; limit: number } {
  return {
    offset: parseInt(opts.offset ?? '0', 10),
    limit: parseInt(opts.limit ?? '10', 10),
  };
}

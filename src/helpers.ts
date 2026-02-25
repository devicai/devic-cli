import { readFileSync } from 'node:fs';
import { DevicApiClient } from './client.js';
import { DevicCliError } from './errors.js';
import { DevicApiError } from './errors.js';
import { loadConfig } from './config.js';
import { output, outputError } from './output.js';
import { EXIT_CODES } from './types.js';
import type { Command } from 'commander';

/** Create an authenticated API client from config/env */
export function createClient(): DevicApiClient {
  const config = loadConfig();
  if (!config.apiKey) {
    throw new DevicCliError(
      'Not authenticated. Run `devic auth login --api-key <key>` or set DEVIC_API_KEY.',
      'AUTH_REQUIRED',
      EXIT_CODES.AUTH_REQUIRED,
    );
  }
  return new DevicApiClient({ apiKey: config.apiKey, baseUrl: config.baseUrl ?? 'https://api.devic.ai' });
}

/** Read JSON from a file path or stdin (when path is "-") */
export async function readJsonInput(path: string): Promise<Record<string, unknown>> {
  if (path === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
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

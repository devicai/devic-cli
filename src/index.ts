import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { setOutputFormat } from './output.js';
import { outputError } from './output.js';
import { setGlobalBaseUrl } from './config.js';
import { EXIT_CODES } from './types.js';
import type { OutputFormat } from './types.js';

import { registerAuthCommands } from './commands/auth.js';
import { registerAssistantCommands } from './commands/assistants.js';
import { registerAgentCommands } from './commands/agents.js';
import { registerToolServerCommands } from './commands/tool-servers.js';
import { registerFeedbackCommands } from './commands/feedback.js';
import { registerProjectCommands } from './commands/projects.js';
import { registerDocumentCommands } from './commands/documents.js';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf-8'),
) as { version: string };

const program = new Command();

program
  .name('devic')
  .description('CLI for the Devic AI Platform API')
  .version(pkg.version)
  .option('-o, --output <format>', 'Output format: json or human')
  .option('--base-url <url>', 'API base URL (overrides config and env)')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.output) {
      setOutputFormat(opts.output as OutputFormat);
    }
    if (opts.baseUrl) {
      setGlobalBaseUrl(opts.baseUrl as string);
    }
  });

registerAuthCommands(program);
registerAssistantCommands(program);
registerAgentCommands(program);
registerToolServerCommands(program);
registerFeedbackCommands(program);
registerProjectCommands(program);
registerDocumentCommands(program);

// Global error handler
program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  // Commander throws on --help and --version with code 'commander.helpDisplayed' / 'commander.version'
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: string }).code;
    if (code === 'commander.helpDisplayed' || code === 'commander.version') {
      process.exit(0);
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  outputError({ error: message, code: 'CLI_ERROR' });
  process.exit(EXIT_CODES.ERROR);
}

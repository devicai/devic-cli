import { Command } from 'commander';
import { setOutputFormat } from './output.js';
import { outputError } from './output.js';
import { EXIT_CODES } from './types.js';
import type { OutputFormat } from './types.js';

import { registerAuthCommands } from './commands/auth.js';
import { registerAssistantCommands } from './commands/assistants.js';
import { registerAgentCommands } from './commands/agents.js';
import { registerToolServerCommands } from './commands/tool-servers.js';
import { registerFeedbackCommands } from './commands/feedback.js';

const program = new Command();

program
  .name('devic')
  .description('CLI for the Devic AI Platform API')
  .version('0.1.0')
  .option('-o, --output <format>', 'Output format: json or human')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.output) {
      setOutputFormat(opts.output as OutputFormat);
    }
  });

registerAuthCommands(program);
registerAssistantCommands(program);
registerAgentCommands(program);
registerToolServerCommands(program);
registerFeedbackCommands(program);

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

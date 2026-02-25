import { Command } from 'commander';
import { createClient, withAction, addListOptions, parseListOpts, readJsonInput } from '../helpers.js';

export function registerToolServerCommands(program: Command): void {
  const ts = program.command('tool-servers').description('Manage tool servers and tools');

  // tool-servers list
  addListOptions(
    ts.command('list').description('List all tool servers'),
  ).action(
    withAction(async (opts: unknown) => {
      const o = opts as { offset?: string; limit?: string };
      const client = createClient();
      return client.listToolServers(parseListOpts(o));
    }),
  );

  // tool-servers get <id>
  ts
    .command('get <toolServerId>')
    .description('Get tool server details')
    .action(
      withAction(async (toolServerId: unknown) => {
        const client = createClient();
        return client.getToolServer(toolServerId as string);
      }),
    );

  // tool-servers create
  ts
    .command('create')
    .description('Create a new tool server')
    .option('--name <name>', 'Tool server name')
    .option('--url <url>', 'Base URL')
    .option('--description <desc>', 'Description')
    .option('--from-json <file>', 'Read config from JSON file (- for stdin)')
    .action(
      withAction(async (opts: unknown) => {
        const o = opts as { name?: string; url?: string; description?: string; fromJson?: string };
        const client = createClient();
        let data: Record<string, unknown>;
        if (o.fromJson) {
          data = await readJsonInput(o.fromJson);
        } else {
          data = {};
          if (o.name) data.name = o.name;
          if (o.url) data.url = o.url;
          if (o.description) data.description = o.description;
        }
        return client.createToolServer(data);
      }),
    );

  // tool-servers update <id>
  ts
    .command('update <toolServerId>')
    .description('Update a tool server')
    .option('--name <name>', 'Tool server name')
    .option('--url <url>', 'Base URL')
    .option('--description <desc>', 'Description')
    .option('--enabled <bool>', 'Enable/disable')
    .option('--from-json <file>', 'Read update payload from JSON file (- for stdin)')
    .action(
      withAction(async (toolServerId: unknown, opts: unknown) => {
        const o = opts as { name?: string; url?: string; description?: string; enabled?: string; fromJson?: string };
        const client = createClient();
        let data: Record<string, unknown>;
        if (o.fromJson) {
          data = await readJsonInput(o.fromJson);
        } else {
          data = {};
          if (o.name) data.name = o.name;
          if (o.url) data.url = o.url;
          if (o.description) data.description = o.description;
          if (o.enabled != null) data.enabled = o.enabled === 'true';
        }
        return client.updateToolServer(toolServerId as string, data);
      }),
    );

  // tool-servers delete <id>
  ts
    .command('delete <toolServerId>')
    .description('Delete a tool server')
    .action(
      withAction(async (toolServerId: unknown) => {
        const client = createClient();
        return client.deleteToolServer(toolServerId as string);
      }),
    );

  // tool-servers clone <id>
  ts
    .command('clone <toolServerId>')
    .description('Clone a tool server')
    .action(
      withAction(async (toolServerId: unknown) => {
        const client = createClient();
        return client.cloneToolServer(toolServerId as string);
      }),
    );

  // tool-servers definition <id>
  ts
    .command('definition <toolServerId>')
    .description('Get tool server definition')
    .action(
      withAction(async (toolServerId: unknown) => {
        const client = createClient();
        return client.getToolServerDefinition(toolServerId as string);
      }),
    );

  // tool-servers update-definition <id>
  ts
    .command('update-definition <toolServerId>')
    .description('Update tool server definition')
    .requiredOption('--from-json <file>', 'Read definition from JSON file (- for stdin)')
    .action(
      withAction(async (toolServerId: unknown, opts: unknown) => {
        const o = opts as { fromJson: string };
        const client = createClient();
        const data = await readJsonInput(o.fromJson);
        return client.updateToolServerDefinition(toolServerId as string, data);
      }),
    );

  // ── Tools subcommand ──

  const tools = ts.command('tools').description('Manage tools within a tool server');

  // tool-servers tools list <toolServerId>
  tools
    .command('list <toolServerId>')
    .description('List tools in a tool server')
    .action(
      withAction(async (toolServerId: unknown) => {
        const client = createClient();
        return client.listTools(toolServerId as string);
      }),
    );

  // tool-servers tools get <toolServerId> <toolName>
  tools
    .command('get <toolServerId> <toolName>')
    .description('Get a specific tool definition')
    .action(
      withAction(async (toolServerId: unknown, toolName: unknown) => {
        const client = createClient();
        return client.getTool(toolServerId as string, toolName as string);
      }),
    );

  // tool-servers tools add <toolServerId>
  tools
    .command('add <toolServerId>')
    .description('Add a tool to a tool server')
    .requiredOption('--from-json <file>', 'Read tool definition from JSON file (- for stdin)')
    .action(
      withAction(async (toolServerId: unknown, opts: unknown) => {
        const o = opts as { fromJson: string };
        const client = createClient();
        const data = await readJsonInput(o.fromJson);
        return client.addTool(toolServerId as string, data);
      }),
    );

  // tool-servers tools update <toolServerId> <toolName>
  tools
    .command('update <toolServerId> <toolName>')
    .description('Update a tool definition')
    .requiredOption('--from-json <file>', 'Read update payload from JSON file (- for stdin)')
    .action(
      withAction(async (toolServerId: unknown, toolName: unknown, opts: unknown) => {
        const o = opts as { fromJson: string };
        const client = createClient();
        const data = await readJsonInput(o.fromJson);
        return client.updateTool(toolServerId as string, toolName as string, data);
      }),
    );

  // tool-servers tools delete <toolServerId> <toolName>
  tools
    .command('delete <toolServerId> <toolName>')
    .description('Delete a tool from a tool server')
    .action(
      withAction(async (toolServerId: unknown, toolName: unknown) => {
        const client = createClient();
        return client.deleteTool(toolServerId as string, toolName as string);
      }),
    );

  // tool-servers tools test <toolServerId> <toolName>
  tools
    .command('test <toolServerId> <toolName>')
    .description('Test a tool call with parameters')
    .requiredOption('--from-json <file>', 'Read test parameters from JSON file (- for stdin)')
    .action(
      withAction(async (toolServerId: unknown, toolName: unknown, opts: unknown) => {
        const o = opts as { fromJson: string };
        const client = createClient();
        const data = await readJsonInput(o.fromJson);
        return client.testTool(toolServerId as string, toolName as string, data);
      }),
    );
}

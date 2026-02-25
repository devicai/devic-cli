import { Command } from 'commander';
import { createClient, withAction, addListOptions, parseListOpts, readJsonInput } from '../helpers.js';
import { md } from '../output.js';
import type { ToolServerDto, ToolDefinition } from '../types.js';

function formatToolServer(ts: ToolServerDto): string {
  const lines = [
    md.h(2, `Tool Server: ${ts.name}`),
    '',
    `**ID:** ${md.code(ts._id || '-')}`,
    `**Name:** ${ts.name}`,
  ];
  if (ts.description) lines.push(`**Description:** ${ts.description}`);
  if (ts.url) lines.push(`**URL:** ${ts.url}`);
  if (ts.identifier) lines.push(`**Identifier:** ${md.code(ts.identifier)}`);
  if (ts.enabled != null) lines.push(`**Enabled:** ${ts.enabled ? 'Yes' : 'No'}`);
  if (ts.mcpType) lines.push(`**MCP Server:** Yes`);

  if (ts.toolServerDefinition?.toolDefinitions?.length) {
    lines.push('', md.h(3, `Tools (${ts.toolServerDefinition.toolDefinitions.length})`));
    for (const tool of ts.toolServerDefinition.toolDefinitions) {
      lines.push(`- ${md.code(tool.function.name)} — ${tool.function.description}`);
      if (tool.endpoint) lines.push(`  Endpoint: ${md.code(`${tool.method || 'GET'} ${tool.endpoint}`)}`);
    }
  }
  return lines.join('\n');
}

function formatTool(t: ToolDefinition): string {
  const lines = [
    md.h(2, `Tool: ${t.function.name}`),
    '',
    `**Description:** ${t.function.description}`,
  ];
  if (t.endpoint) lines.push(`**Endpoint:** ${md.code(`${t.method || 'GET'} ${t.endpoint}`)}`);
  if (t.pathParametersKeys?.length) lines.push(`**Path Params:** ${t.pathParametersKeys.map(p => md.code(p)).join(', ')}`);
  if (t.queryParametersKeys?.length) lines.push(`**Query Params:** ${t.queryParametersKeys.map(p => md.code(p)).join(', ')}`);
  if (t.bodyMode) lines.push(`**Body Mode:** ${t.bodyMode}`);
  if (t.bodyJsonTemplate) lines.push(`**Body Template:** ${md.code(t.bodyJsonTemplate)}`);
  if (t.responsePostProcessingEnabled) lines.push(`**Response Processing:** ${md.code(t.responsePostProcessingTemplate || '-')}`);
  if (t.function.parameters) {
    lines.push('', md.h(3, 'Parameters'), md.codeBlock(JSON.stringify(t.function.parameters, null, 2), 'json'));
  }
  return lines.join('\n');
}

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
    }, (d) => {
      const data = d as any;
      const items = data.toolServers ?? (Array.isArray(data) ? data : []);
      if (items.length === 0) return '_No tool servers found._';
      const lines = [
        md.h(2, 'Tool Servers'),
        '',
        md.table(items.map((s: any) => ({
          id: s._id,
          name: s.name,
          url: s.url || '-',
          identifier: s.identifier || '-',
          enabled: s.enabled ?? true,
        })), { columns: ['id', 'name', 'url', 'identifier', 'enabled'] }),
      ];
      if (data.total != null) lines.push(md.pagination(data));
      return lines.join('\n');
    }),
  );

  // tool-servers get <id>
  ts
    .command('get <toolServerId>')
    .description('Get tool server details')
    .action(withAction(async (toolServerId: unknown) => {
      const client = createClient();
      return client.getToolServer(toolServerId as string);
    }, (d) => formatToolServer(d as ToolServerDto)));

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
      }, (d) => {
        const s = d as ToolServerDto;
        return [md.success(`Tool server created: ${md.b(s.name)}`), '', formatToolServer(s)].join('\n');
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
      }, (d) => {
        const s = d as ToolServerDto;
        return [md.success(`Tool server updated: ${md.b(s.name)}`), '', formatToolServer(s)].join('\n');
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
      }, (d) => {
        const r = d as any;
        return md.success(r.message || `Tool server ${md.code(r.deletedId || '')} deleted.`);
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
      }, (d) => {
        const s = d as ToolServerDto;
        return [md.success(`Tool server cloned: ${md.b(s.name)}`), '', formatToolServer(s)].join('\n');
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
      }, (d) => {
        const data = d as any;
        const defs = data.toolDefinitions ?? [];
        if (defs.length === 0) return '_No tool definitions._';
        const lines = [md.h(2, 'Tool Server Definition'), ''];
        for (const tool of defs) {
          lines.push(`### ${md.code(tool.function?.name ?? 'unknown')}`, '');
          lines.push(`${tool.function?.description ?? '-'}`, '');
          if (tool.endpoint) lines.push(`Endpoint: ${md.code(`${tool.method || 'GET'} ${tool.endpoint}`)}`);
          lines.push('');
        }
        return lines.join('\n');
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
      }, () => md.success('Tool server definition updated.')),
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
      }, (d) => {
        const data = d as any;
        const items = data.tools ?? (Array.isArray(data) ? data : []);
        if (items.length === 0) return '_No tools found._';
        const lines = [
          md.h(2, 'Tools'),
          '',
          md.table(items.map((t: any) => ({
            name: t.function?.name ?? '-',
            description: (t.function?.description ?? '-').slice(0, 60),
            method: t.method || 'GET',
            endpoint: t.endpoint || '-',
          })), { columns: ['name', 'description', 'method', 'endpoint'] }),
        ];
        if (data.total != null) lines.push('', md.info(`${data.total} tool(s)`));
        return lines.join('\n');
      }),
    );

  // tool-servers tools get <toolServerId> <toolName>
  tools
    .command('get <toolServerId> <toolName>')
    .description('Get a specific tool definition')
    .action(withAction(async (toolServerId: unknown, toolName: unknown) => {
      const client = createClient();
      return client.getTool(toolServerId as string, toolName as string);
    }, (d) => formatTool(d as ToolDefinition)));

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
      }, () => md.success('Tool added.')),
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
      }, () => md.success('Tool updated.')),
    );

  // tool-servers tools delete <toolServerId> <toolName>
  tools
    .command('delete <toolServerId> <toolName>')
    .description('Delete a tool from a tool server')
    .action(
      withAction(async (toolServerId: unknown, toolName: unknown) => {
        const client = createClient();
        return client.deleteTool(toolServerId as string, toolName as string);
      }, () => md.success('Tool deleted.')),
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
      }, (d) => {
        const r = d as any;
        const lines = [md.h(2, 'Tool Test Result'), ''];
        lines.push(`**Success:** ${r.success ? 'Yes' : 'No'}`);
        if (r.executionTimeMs != null) lines.push(`**Execution Time:** ${r.executionTimeMs}ms`);
        if (r.requestUrl) lines.push(`**Request:** ${md.code(`${r.requestMethod || 'GET'} ${r.requestUrl}`)}`);
        if (r.error) lines.push(`**Error:** ${r.error}`);
        if (r.data != null) {
          lines.push('', md.h(3, 'Response'), md.codeBlock(JSON.stringify(r.data, null, 2), 'json'));
        }
        return lines.join('\n');
      }),
    );
}

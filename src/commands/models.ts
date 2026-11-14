import { Command } from 'commander';
import { createClient, withAction } from '../helpers.js';
import { md } from '../output.js';
import type { ModelCatalogProvider } from '../types.js';

export function registerModelCommands(program: Command): void {
  program.command('models').description('Discover supported models and reasoning levels')
    .command('list')
    .description('List selectable models from the current API catalog')
    .option('--provider <provider>', 'Filter by exact provider identifier')
    .option('--model <model>', 'Filter by exact model identifier')
    .action(withAction(async (opts: unknown) => {
      const { provider, model } = opts as { provider?: string; model?: string };
      const catalog = await createClient().getModels();
      return catalog.filter(p => !provider || p.provider === provider).map(p => ({
        ...p,
        models: p.models.filter(m => !model || m.model === model),
      })).filter(p => p.models.length > 0);
    }, d => {
      const rows = (d as ModelCatalogProvider[]).flatMap(p => p.models.map(m => ({
        provider: p.provider,
        model: m.model,
        reasoningEfforts: m.reasoningEfforts.join(', ') || 'default only',
      })));
      return rows.length ? md.table(rows, { columns: ['provider', 'model', 'reasoningEfforts'] }) : '_No models found._';
    }));
}

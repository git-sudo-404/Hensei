import { resolve, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { extractGraph, GRAPHIFY_VERSION } from './graphify';
import { projectGraph } from './graph';
import { buildLayers } from './layers';
import { planTasks, deepseekComplete } from './planner';

async function main() {
  const [command, ...args] = Bun.argv.slice(2);
  if (command === 'plan') {
    const graphPath = args.shift();
    if (!graphPath || graphPath.startsWith('--')) throw new Error('plan requires a Graphify graph.json path');
    let root: string | undefined, target: string | undefined;
    let output = resolve('artifacts/tasks.json'), model = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
    while (args.length) {
      const flag = args.shift(), value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      if (flag === '--root') root = resolve(value);
      else if (flag === '--target') target = value;
      else if (flag === '--out') output = resolve(value);
      else if (flag === '--model') model = value;
      else throw new Error(`Unknown option: ${flag}`);
    }
    if (!root || !target) throw new Error('plan requires --root <repository> and --target <language>');
    const complete = deepseekComplete(process.env.DEEPSEEK_API_KEY || '',model);
    const plan = await planTasks({graphPath:resolve(graphPath),root,target,output,model,complete,onProgress:console.log});
    console.log(`Saved ${plan.tasks.length} validated tasks to ${output}`);
    return;
  }
  if (!command || command === '--help') {
    console.log('bun run graph <repo> [--out <directory>]\nbun run order <graph.json> --root <repo> [--out <directory>]\nbun run plan <graph.json> --root <repo> --target <language> [--out <tasks.json>] [--model <model>]'); return;
  }
  if (command !== 'graph' && command !== 'order') throw new Error(`Unknown command: ${command}`);
  const input = args.shift();
  if (!input || input.startsWith('--')) throw new Error('Missing repository or graph path');
  let output = resolve('artifacts'), root: string | undefined;
  while (args.length) {
    const flag = args.shift(), value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--out') output = resolve(value);
    else if (flag === '--root') root = resolve(value);
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (command === 'order' && !root) throw new Error('order requires --root pointing at the scanned repository');
  root = command === 'graph' ? resolve(input) : root!;
  const graphPath = command === 'graph' ? await extractGraph(root, output) : resolve(input);
  const graph = projectGraph(await Bun.file(graphPath).json(), root);
  if (!graph.files.length) throw new Error('No files found in Graphify graph; inspect supported languages and extraction logs');
  const order = buildLayers(graph);
  await mkdir(output, {recursive:true});
  await Bun.write(join(output,'file-graph.json'), JSON.stringify({schemaVersion:1, root, graphPath, ...graph},null,2)+'\n');
  await Bun.write(join(output,'migration-order.json'), JSON.stringify({root, graphPath, graphifyVersion: command === 'graph' ? GRAPHIFY_VERSION : null, ...order},null,2)+'\n');
  console.log(`${graph.files.length} files, ${graph.dependencies.length} dependency edges, ${order.groups.filter(g => g.cyclic).length} cyclic groups`);
  for (const layer of order.layers) console.log(`Layer ${layer.index}: ${layer.groupIds.map(id => { const group = order.groups.find(g => g.id === id)!; return `[${group.files.join(', ')}]${group.cyclic ? ' (cycle)' : ''}`; }).join(' | ')}`);
  console.log(`${graph.warnings.length} unresolved/external edges; details in migration-order.json\nOutput: ${output}`);
}
main().catch(error => {console.error(error instanceof Error ? error.message : String(error)); process.exitCode=1;});

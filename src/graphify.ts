import { resolve, join } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
export const GRAPHIFY_VERSION = '0.9.79';
export async function extractGraph(root: string, output: string): Promise<string> {
  if (!(await stat(root)).isDirectory()) throw new Error('Repository must be a directory');
  await mkdir(output, { recursive: true });
  const child = Bun.spawn(['uvx','--from',`graphifyy==${GRAPHIFY_VERSION}`,'graphify','extract',resolve(root),'--code-only','--no-cluster','--force','--max-workers','2','--out',resolve(output)], {
    env: {...process.env, GRAPHIFY_NO_AUTO_REFRESH:'1'}, stdout:'inherit', stderr:'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Graphify failed (${exitCode}); install uv and check its extraction logs`);
  const path = join(resolve(output),'graphify-out','graph.json');
  if (!await Bun.file(path).exists()) throw new Error('Graphify did not produce graph.json');
  return path;
}

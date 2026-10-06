import { isAbsolute, relative, resolve } from 'node:path';

export interface Dependency { dependent: string; prerequisite: string; relation: string }
export interface FileGraph { files: string[]; dependencies: Dependency[]; warnings: string[] }
const dependencyRelations = new Set(['imports', 'imports_from', 'calls', 'inherits', 'implements']);
const record = (x: unknown): Record<string, unknown> => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('Expected a Graphify object');
  return x as Record<string, unknown>;
};

/** Project symbol-level edges onto files. Graphify source -> target means consumer -> dependency. */
export function projectGraph(input: unknown, root: string): FileGraph {
  const graph = record(input);
  if (!Array.isArray(graph.nodes)) throw new Error('Graphify output needs nodes[]');
  const rawEdges = graph.edges ?? graph.links;
  if (!Array.isArray(rawEdges)) throw new Error('Graphify output needs edges[] or links[]');
  if (graph.directed === false) throw new Error('Undirected graph loses dependency direction; use Graphify --no-cluster extraction');
  const warnings = new Set<string>();
  const canonical = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const normalized = value.replaceAll('\\', '/');
    const file = relative(resolve(root), isAbsolute(normalized) ? normalized : resolve(root, normalized)).replaceAll('\\', '/');
    if (!file || file === '..' || file.startsWith('../')) return undefined;
    return file;
  };
  const nodes = new Map<string, string | undefined>();
  const files = new Set<string>();
  for (const item of graph.nodes) {
    const node = record(item);
    if (typeof node.id !== 'string') throw new Error('Graphify node needs string id');
    if (nodes.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`);
    const file = canonical(node.source_file ?? node.path);
    nodes.set(node.id, file);
    if (file) files.add(file);
  }
  const dependencies = new Map<string, Dependency>();
  for (const item of rawEdges) {
    const edge = record(item);
    if (typeof edge.source !== 'string' || typeof edge.target !== 'string') throw new Error('Graphify edge needs string source and target');
    const relation = String(edge.relation ?? '').toLowerCase();
    if (!dependencyRelations.has(relation)) continue; // contains/related_to are not prerequisites
    const dependent = nodes.get(edge.source) ?? canonical(edge.source_file);
    const prerequisite = canonical(edge.target_file) ?? nodes.get(edge.target);
    if (!dependent || !prerequisite) {
      warnings.add(`Unresolved/external ${relation}: ${edge.source} -> ${edge.target}`);
      continue;
    }
    files.add(dependent); files.add(prerequisite);
    if (dependent === prerequisite) continue; // intra-file symbols cannot constrain file ordering
    const dependency = { dependent, prerequisite, relation };
    dependencies.set(JSON.stringify(dependency), dependency);
  }
  return { files: [...files].sort(), dependencies: [...dependencies.values()].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), warnings: [...warnings].sort() };
}

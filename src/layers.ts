import type { FileGraph } from './graph';
export interface Group { id: string; files: string[]; cyclic: boolean; dependsOn: string[] }
export interface MigrationOrder { schemaVersion: 1; groups: Group[]; layers: { index: number; groupIds: string[]; files: string[] }[]; warnings: string[] }

/** Iterative Kosaraju SCC condensation + batched Kahn traversal (dependency-first BFS layers). */
export function buildLayers(graph: FileGraph): MigrationOrder {
  const files = [...new Set(graph.files)].sort();
  const next = new Map(files.map(f => [f, new Set<string>()]));
  const reverse = new Map(files.map(f => [f, new Set<string>()]));
  for (const {dependent, prerequisite} of graph.dependencies) {
    if (!next.has(dependent) || !next.has(prerequisite)) throw new Error('Dependency references an unknown file');
    next.get(dependent)!.add(prerequisite); reverse.get(prerequisite)!.add(dependent);
  }
  const visited = new Set<string>(), finish: string[] = [];
  for (const file of files) {
    if (visited.has(file)) continue;
    visited.add(file);
    const stack: {file: string; edges: Iterator<string>}[] = [{file, edges: next.get(file)!.values()}];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const edge = frame.edges.next();
      if (edge.done) { finish.push(frame.file); stack.pop(); }
      else if (!visited.has(edge.value)) { visited.add(edge.value); stack.push({file: edge.value, edges: next.get(edge.value)!.values()}); }
    }
  }
  const assigned = new Set<string>(), components: string[][] = [];
  for (const file of finish.reverse()) {
    if (assigned.has(file)) continue;
    const component: string[] = [], stack = [file]; assigned.add(file);
    while (stack.length) {
      const current = stack.pop()!; component.push(current);
      for (const neighbor of reverse.get(current)!) if (!assigned.has(neighbor)) { assigned.add(neighbor); stack.push(neighbor); }
    }
    components.push(component.sort());
  }
  components.sort((a,b) => a[0].localeCompare(b[0]));
  const groups: Group[] = components.map((files,index) => ({id: `group_${String(index+1).padStart(4,'0')}`, files, cyclic: files.length > 1 || next.get(files[0])!.has(files[0]), dependsOn: []}));
  const owner = new Map(groups.flatMap(g => g.files.map(f => [f,g.id] as const)));
  const prerequisites = new Map(groups.map(g => [g.id,new Set<string>()]));
  const consumers = new Map(groups.map(g => [g.id,new Set<string>()]));
  for (const edge of graph.dependencies) {
    const consumer = owner.get(edge.dependent)!, dependency = owner.get(edge.prerequisite)!;
    if (consumer !== dependency) { prerequisites.get(consumer)!.add(dependency); consumers.get(dependency)!.add(consumer); }
  }
  for (const group of groups) group.dependsOn = [...prerequisites.get(group.id)!].sort();
  const remaining = new Map(groups.map(g => [g.id,g.dependsOn.length]));
  const byId = new Map(groups.map(g => [g.id,g]));
  const layers: MigrationOrder['layers'] = [];
  let ready = groups.filter(g => !g.dependsOn.length).map(g => g.id).sort();
  let processed = 0;
  while (ready.length) {
    layers.push({index: layers.length, groupIds: ready, files: ready.flatMap(id => byId.get(id)!.files).sort()});
    processed += ready.length;
    const future: string[] = [];
    for (const id of ready) for (const consumer of consumers.get(id)!) {
      const count = remaining.get(consumer)! - 1; remaining.set(consumer,count);
      if (count === 0) future.push(consumer);
    }
    ready = future.sort();
  }
  if (processed !== groups.length) throw new Error('Internal error: SCC condensation must be acyclic');
  return {schemaVersion: 1, groups, layers, warnings: graph.warnings};
}

import { test, expect } from 'bun:test';
import { projectGraph, type FileGraph } from '../src/graph';
import { buildLayers } from '../src/layers';
const graph = (files: string[], edges: [string,string][]): FileGraph => ({files,dependencies:edges.map(([dependent,prerequisite]) => ({dependent,prerequisite,relation:'imports_from'})),warnings:[]});
test('dependency-first layers wait for every prerequisite', () => {
  const order = buildLayers(graph(['a','b','c','d','e'], [['b','a'],['c','a'],['d','b'],['d','c']]));
  expect(order.layers.map(l => l.files)).toEqual([['a','e'],['b','c'],['d']]);
});
test('cycles form atomic groups with prerequisites first and consumers later', () => {
  const order = buildLayers(graph(['base','a','b','app'], [['a','b'],['b','a'],['a','base'],['app','a']]));
  expect(order.layers.map(l => l.files)).toEqual([['base'],['a','b'],['app']]);
  expect(order.groups.find(g => g.cyclic)?.files).toEqual(['a','b']);
});
test('empty, isolated, self-loop, duplicate edges, disconnected cycles', () => {
  expect(buildLayers(graph([],[])).layers).toEqual([]);
  const order = buildLayers(graph(['a','b','c'],[['a','a'],['b','c'],['c','b'],['c','b']]));
  expect(order.layers.length).toBe(1); expect(order.groups.every(g => g.cyclic)).toBe(true);
});
test('deep graphs do not overflow recursive stacks', () => {
  const files = Array.from({length:15000},(_,i) => String(i));
  expect(buildLayers(graph(files, files.slice(1).map((f,i) => [f,files[i]]))).layers.length).toBe(15000);
});
test('ordering stable across input permutations and prerequisites precede consumers', () => {
  const input = graph(['a','b','c','d'],[['a','b'],['b','a'],['c','a'],['d','c']]);
  const first = buildLayers(input);
  expect(buildLayers({...input,files:input.files.toReversed(),dependencies:input.dependencies.toReversed()})).toEqual(first);
  const layerOf = new Map(first.layers.flatMap(l => l.groupIds.map(id => [id,l.index] as const)));
  for (const group of first.groups) for (const dep of group.dependsOn) expect(layerOf.get(dep)!).toBeLessThan(layerOf.get(group.id)!);
});
test('projects symbols, retains relation direction, ignores non-dependency edges', () => {
  const output = projectGraph({nodes:[{id:'a',source_file:'/repo/app.ts'},{id:'b',source_file:'base.ts'},{id:'c',source_file:'other.ts'},{id:'external'}],edges:[
    {source:'a',target:'b',relation:'imports_from'}, {source:'b',target:'c',relation:'contains'}, {source:'a',target:'external',relation:'imports'},
  ]},'/repo');
  expect(output.dependencies).toEqual([{dependent:'app.ts',prerequisite:'base.ts',relation:'imports_from'}]);
  expect(output.warnings.length).toBe(1);
});
test('supports raw target_file and node-link links, rejects undirected or invalid graphs', () => {
  expect(projectGraph({nodes:[{id:'a',source_file:'a.ts'}],links:[{source:'a',target:'unresolved',target_file:'/repo/b.ts',relation:'calls'}]},'/repo').files).toEqual(['a.ts','b.ts']);
  expect(() => projectGraph({directed:false,nodes:[],edges:[]},'/repo')).toThrow('Undirected');
  expect(() => projectGraph({nodes:[]},'/repo')).toThrow();
  expect(() => buildLayers(graph(['a'],[['a','b']]))).toThrow('unknown file');
});
test('real Graphify 0.9.79 fixture produces the expected cycle layers', async () => {
  const raw = await Bun.file(new URL('./fixtures/graphify-cyclic.json', import.meta.url)).json();
  const extractedRoot = '/Users/chiranjeevprasannaavv/Desktop/MAO/hensei/examples/cyclic';
  const order = buildLayers(projectGraph(raw, extractedRoot));
  expect(order.layers.map(l => l.files)).toEqual([['base.ts','independent.ts'],['a.ts','b.ts'],['app.ts']]);
  expect(order.warnings).toEqual([]);
});

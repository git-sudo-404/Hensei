import {test,expect} from 'bun:test';
import {parseConfig} from '../src/config';
test('configuration allows user-selected language framework and version',()=> {
  expect(parseConfig('target:\n  language: TypeScript\n  framework: Next.js\n  version: "5.9"')).toEqual({language:'TypeScript',framework:'Next.js',version:'5.9'});
  expect(parseConfig('target:\n  language: Rust')).toEqual({language:'Rust'});
});
test('rejects missing target, ambiguous versions, unknown fields and duplicate keys',()=> {
  for (const yaml of ['', 'language: Go', 'target: {}', 'target:\n  language: Go\n  version: 1.24', 'target:\n  language: Go\n  typo: x', 'target:\n  language: Go\n  language: Rust']) expect(()=>parseConfig(yaml)).toThrow();
});
test('config accepts bounded worker limit and rejects invalid limits',()=> {
  expect(parseConfig('target:\n  language: Go\nagents:\n  workers: 5').workers).toBe(5);
  for (const value of ['0','-1','1.5','65','"5"'])expect(()=>parseConfig(`target:\n  language: Go\nagents:\n  workers: ${value}`)).toThrow();
});

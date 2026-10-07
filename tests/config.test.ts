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
test('evaluation requires separate build/test argv and bounded attempts',()=> {
  expect(parseConfig('target:\n  language: Go\nevaluation:\n  build: [go, build, ./...]\n  test: [go, test, ./...]').evaluation?.maxAttempts).toBe(4);
  for(const extra of ['build: "go build"\n  test: [go, test]','build: [go, build]','build: [go, build]\n  test: [go, test]\n  maxAttempts: 0'])expect(()=>parseConfig(`target:\n  language: Go\nevaluation:\n  ${extra}`)).toThrow();
});

test('worker repair returns default to three and configured maxRetries is distinct from transport retries',()=>{
 const c=parseConfig('target: {language: Go}\nagents: {workers: 5, maxRetries: 1}\nevaluation: {build: [go, build], test: [go, test]}');expect(c.evaluation?.maxAttempts).toBe(2);
 expect(()=>parseConfig('target: {language: Go}\nagents: {workers: 5, maxRetries: 1}\nevaluation: {build: [go, build], test: [go, test], maxAttempts: 3}')).toThrow('both');
});

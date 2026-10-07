import {isAbsolute} from 'node:path';
export function safePath(path:string):boolean {
  return typeof path==='string'&&!!path&&!isAbsolute(path)&&!path.includes('\\')&&!/[\x00-\x1f]/.test(path)&&!path.split('/').some(p=>!p||p==='.'||p==='..'||p==='.git'||p==='.hensei'||p==='.env'||p.startsWith('.env.'));
}

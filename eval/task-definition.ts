import { createHash } from 'node:crypto';
import type { EvalTask } from './tasks.js';

export function taskDefinitionSha256(task: EvalTask): string {
  return createHash('sha256').update(JSON.stringify({
    name: task.name,
    files: task.files,
    prompt: task.prompt,
    verifySource: task.verify.toString(),
  })).digest('hex');
}

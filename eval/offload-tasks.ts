import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalTask } from './tasks.js';

/** Synthetic mechanism probes, not a representative coding benchmark. The
 * controller diagnoses only development runs; confirmation fixtures stay out
 * of its proposal input. Verifiers are executed by the fixed evaluator. */
function incidentTask(name: string, seed: number): EvalTask {
  const files: Record<string, string> = {};
  const expected: Record<string, string> = {};
  for (let service = 0; service < 10; service++) {
    const key = `service-${service}`;
    const code = `E${seed * 100 + service}`;
    const lines = Array.from({ length: 240 }, (_, i) =>
      `${i}: ${key} heartbeat healthy; sequence ${seed + i}; no intervention required.`);
    lines[31 + service * 13] = `INCIDENT ${code}: repair=${(seed + service) % 2 ? 'restart' : 'rollback'}`;
    files[`logs/${key}.log`] = lines.join('\n') + '\n';
    expected[key] = `${code}:${(seed + service) % 2 ? 'restart' : 'rollback'}`;
  }
  return {
    name, files,
    prompt: 'Investigate the ten service logs in logs/. For each service identify its INCIDENT code and repair action. Write report.json mapping each service name (without .log) to "CODE:action". Check all ten services and verify your report against the logs before finishing.',
    verify(dir) {
      const actual = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
      return actual !== null && typeof actual === 'object' && !Array.isArray(actual)
        && Object.keys(actual).length === Object.keys(expected).length
        && Object.entries(expected).every(([key, value]) => actual[key] === value);
    },
  };
}
export const offloadDevelopment = [1, 2, 3].map(seed => incidentTask(`offload-dev-${seed}`, seed));
export const offloadConfirmation = [11, 12, 13].map(seed => incidentTask(`offload-confirm-${seed}`, seed));
export const suites: Record<string, EvalTask[]> = {
  'offload-development': offloadDevelopment,
  'offload-confirmation': offloadConfirmation,
};

import { DevicCliError } from './errors.js';
import type { ReasoningEffort } from './types.js';

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const EFFORT_HELP = 'Reasoning level: none, minimal, low, medium, high, xhigh, max; default restores inheritance (model support varies)';

export function parseReasoningEffort(value: string): ReasoningEffort | null {
  if (value === 'default' || value === 'null') return null;
  if (REASONING_EFFORTS.includes(value as ReasoningEffort)) return value as ReasoningEffort;
  throw new DevicCliError(`Invalid reasoning effort "${value}". ${EFFORT_HELP}.`, 'INVALID_REASONING_EFFORT');
}

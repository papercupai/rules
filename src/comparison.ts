/** Shared comparison readings and authored-leaf checks. Pure; no caller adapters. */
import { z } from 'zod';
import { COMPARISON_MODES, isOperatorTest, isPlainObject } from './operators';
import type { ComparisonMode, OperatorTest } from './operators';

export const UNREADABLE = Symbol('unreadable comparison value');
const instantSchema = z.string().datetime({ offset: true });

/** Non-exact readings accept scalars, never JS object/array-to-string coercion. */
export function readComparison(value: unknown, mode: ComparisonMode): unknown {
  if (mode === 'exact') return value;
  if (mode === 'time') {
    if (!instantSchema.safeParse(value).success) return UNREADABLE;
    const instant = Date.parse(value as string);
    return Number.isFinite(instant) ? instant : UNREADABLE;
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return UNREADABLE;
  if (typeof value === 'number' && !Number.isFinite(value)) return UNREADABLE;
  if (mode === 'text') return String(value).trim().toLowerCase();
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : UNREADABLE;
}

/** Return an author error, or null. Exact legacy leaves retain their old validation. */
export function comparisonError(test: OperatorTest): string | null {
  const mode = test.as === undefined ? 'exact' : test.as;
  if (!COMPARISON_MODES.includes(mode)) return 'unknown comparison mode';
  for (const key of Object.keys(test) as (keyof OperatorTest)[]) {
    if (key === 'as') continue;
    const operand = test[key];
    if (mode === 'exact') {
      if ((key === 'containsText' || key === 'notContainsText') && typeof operand !== 'string') return `${key} requires a string in exact mode`;
      continue;
    }
    if (key === 'exists' || key === 'truthy') {
      if (typeof operand !== 'boolean') return `${key} requires a boolean`;
      continue;
    }
    const substring = ['containsText', 'notContainsText', 'startsWith', 'endsWith', 'matches'].includes(key);
    if (substring && (mode === 'number' || mode === 'time')) return `${key} is incompatible with ${mode} mode`;
    // Legacy contains is list-or-substring; in numeric/time mode only its list branch applies.
    if (key === 'matches') {
      try {
        if (typeof operand === 'string') new RegExp(operand);
        else if (isPlainObject(operand) && typeof operand.source === 'string' && (operand.flags === undefined || typeof operand.flags === 'string')) {
          new RegExp(operand.source, operand.flags as string | undefined);
        } else return 'matches requires a regex source';
      } catch { return 'matches requires a valid regex'; }
      continue;
    }
    const operands = key === 'in' || key === 'notIn' ? operand : [operand];
    if (!Array.isArray(operands) || operands.some((v) => readComparison(v, mode) === UNREADABLE)) return `${key} operand is unreadable as ${mode}`;
  }
  return null;
}

/** Validate only operator-shaped leaves, walking the existing condition grammar. */
export function conditionComparisonError(condition: unknown): string | null {
  if (!isPlainObject(condition)) return null;
  const keys = Object.keys(condition);
  if (keys.length === 1) {
    const key = keys[0];
    if ((key === 'all' || key === 'any') && Array.isArray(condition[key])) {
      for (const sub of condition[key]) { const error = conditionComparisonError(sub); if (error) return error; }
      return null;
    }
    if (key === 'not') return conditionComparisonError(condition.not);
    if (key === 'some' && isPlainObject(condition.some) && Array.isArray(condition.some.of)) {
      for (const sub of condition.some.of) { const error = conditionComparisonError(sub); if (error) return error; }
      return null;
    }
  }
  for (const [path, leaf] of Object.entries(condition)) {
    if (isOperatorTest(leaf)) {
      const error = comparisonError(leaf);
      if (error) return `${path}: ${error}`;
    }
  }
  return null;
}

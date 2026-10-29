/**
 * validate.test.ts — branch-complete unit coverage for validateRuleShape, the cheap
 * structural guard EVERY rule passes through on engine.add (engine.ts:34) and the
 * serializable-form check defers to (schema.ts). engine.test.ts only drives 3 branches
 * incidentally (empty id/on/fire); this pins the rest, since a wrong guard either lets
 * a malformed rule into the engine (fires on the wrong event / crashes at match time)
 * or rejects a legitimately-shaped one (predicate `when`, function `args`, array `on`).
 *
 * Pure: validateRuleShape has no imports beyond its own RuleValidationError.
 */
import { describe, expect, it } from 'vitest';
import { validateRuleShape, RuleValidationError } from './validate';
import { dataConditionSchema, operatorTestSchema, parseSerializableRule } from './schema';
import { evaluateOperatorTest } from './compile';

function rejectLeaf(leaf: Record<string, unknown>): void {
  const when = { all: [{ any: [{ some: { require: 1, of: [{ not: { value: leaf } }] } }] }] };
  expect(() => check({ ...valid(), when })).toThrow(RuleValidationError);
  expect(() => parseSerializableRule({ ...valid(), when })).toThrow();
  expect(operatorTestSchema.safeParse(leaf).success).toBe(false);
  expect(dataConditionSchema.safeParse(when).success).toBe(false);
  expect(evaluateOperatorTest(leaf, 'anything')).toBe(false);
}

it('rules events reuse R-41 rejects authored operands unreadable in the selected mode', () => {
  for (const value of ['NaN', 'Infinity', NaN, Infinity, null, undefined, {}, [], new Date()]) {
    for (const op of ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'containsItem', 'notContainsItem']) rejectLeaf({ as: 'number', [op]: value });
    for (const op of ['in', 'notIn']) rejectLeaf({ as: 'number', [op]: [1, value] });
  }
  for (const value of ['2026-10-28T12:00:00', '2026-02-30T12:00:00Z', 'tomorrow', 42, null, undefined, {}]) {
    for (const op of ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'containsItem', 'notContainsItem']) rejectLeaf({ as: 'time', [op]: value });
    rejectLeaf({ as: 'time', in: [value] });
  }
  for (const value of [null, undefined, {}, [], NaN]) rejectLeaf({ as: 'text', equals: value });
  for (const leaf of [{ as: 'text', equals: 2 }, { as: 'number', gt: '2' }, { as: 'time', lte: '2026-10-28T12:00:00+04:00' }]) {
    expect(() => check({ ...valid(), when: { value: leaf } })).not.toThrow();
    expect(() => parseSerializableRule({ ...valid(), when: { value: leaf } })).not.toThrow();
    expect(operatorTestSchema.safeParse(leaf).success).toBe(true);
  }
});

it('rules events reuse R-42 rejects mode and operator combinations that cannot be interpreted', () => {
  for (const as of ['number', 'time']) {
    for (const op of ['containsText', 'notContainsText', 'startsWith', 'endsWith', 'matches']) rejectLeaf({ as, [op]: '2' });
  }
  rejectLeaf({ as: 'other', equals: 1 });
  rejectLeaf({ as: null, equals: 1 });
  expect(operatorTestSchema.safeParse({ as: 'text' }).success).toBe(false);
  // An as-only map remains an ordinary object literal, never a vacuous operator test.
  expect(dataConditionSchema.safeParse({ value: { as: 'text' } }).success).toBe(true);
  rejectLeaf({ as: 'text', exists: 'yes' });
  rejectLeaf({ as: 'number', truthy: 'yes' });
  rejectLeaf({ as: 'text', matches: '[' });
});

/** Call with arbitrary input (the param type is the internal RuleLike). */
const check = (rule: unknown) => validateRuleShape(rule as Parameters<typeof validateRuleShape>[0]);

/** A minimal fully-valid rule to mutate per-case. */
const valid = () => ({ id: 'r1', on: 'evt', fire: 'do-thing' });

describe('validateRuleShape — accepts well-formed rules', () => {
  it('a minimal string-on rule does not throw', () => {
    expect(() => check(valid())).not.toThrow();
  });

  it('accepts a non-empty string[] on, a predicate when, and a function args', () => {
    expect(() =>
      check({ id: 'r', on: ['a', 'b'], fire: 'f', when: () => true, args: () => ({ x: 1 }) }),
    ).not.toThrow();
  });

  it('accepts object when / object args (the serializable forms)', () => {
    expect(() => check({ id: 'r', on: 'a', fire: 'f', when: { eq: 1 }, args: { k: 'v' } })).not.toThrow();
  });
});

describe('validateRuleShape — rejects a non-object rule', () => {
  it.each([null, undefined, 'rule', 42])('throws "rule must be an object" for %p', (bad) => {
    expect(() => check(bad)).toThrow('rule must be an object');
  });
});

describe('validateRuleShape — id must be a non-empty string', () => {
  it.each([{ id: '' }, { id: 42 }, { id: undefined }, { id: null }])('rejects id %o', (patch) => {
    expect(() => check({ ...valid(), ...patch })).toThrow('rule.id must be a non-empty string');
  });
});

describe('validateRuleShape — on must be a non-empty string or non-empty string[]', () => {
  it.each([
    ['empty string', ''],
    ['empty array', []],
    ['array with an empty-string element', ['a', '']],
    ['array with a non-string element', ['a', 2]],
    ['a number', 7],
    ['undefined', undefined],
  ])('rejects on = %s', (_label, on) => {
    expect(() => check({ ...valid(), on })).toThrow(/on must be a non-empty string or non-empty string\[\]/);
  });

  it('names the offending rule id in the on error', () => {
    expect(() => check({ id: 'badRule', on: '', fire: 'f' })).toThrow('rule "badRule"');
  });
});

describe('validateRuleShape — fire is required', () => {
  it.each([undefined, null, ''])('rejects fire = %p', (fire) => {
    expect(() => check({ ...valid(), fire })).toThrow(/fire is required/);
  });

  it('accepts a non-empty-string / truthy-but-non-string fire (only undefined|null|"" reject)', () => {
    // The guard rejects ONLY undefined, null, and the empty string — a numeric or
    // object fire passes structurally (deep-shape is schema.ts's job, not this guard).
    expect(() => check({ ...valid(), fire: 0 })).not.toThrow();
    expect(() => check({ ...valid(), fire: { kind: 'x' } })).not.toThrow();
  });
});

describe('validateRuleShape — when, if present, must be a function or non-null object', () => {
  it.each(['str', 42, null, true])('rejects when = %p', (when) => {
    expect(() => check({ ...valid(), when })).toThrow(/when must be a DataCondition object or a predicate function/);
  });

  it('allows when to be absent (undefined)', () => {
    expect(() => check({ ...valid(), when: undefined })).not.toThrow();
  });
});

describe('validateRuleShape — args, if present, must be a function or non-null object', () => {
  it.each(['str', 42, null, true])('rejects args = %p', (args) => {
    expect(() => check({ ...valid(), args })).toThrow(/args must be an object or a function/);
  });

  it('allows args to be absent (undefined)', () => {
    expect(() => check({ ...valid(), args: undefined })).not.toThrow();
  });
});

describe('validateRuleShape — error type', () => {
  it('throws a RuleValidationError (named) for every rejection', () => {
    try {
      check(null);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RuleValidationError);
      expect((err as RuleValidationError).name).toBe('RuleValidationError');
    }
  });
});

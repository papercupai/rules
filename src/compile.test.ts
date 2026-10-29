/**
 * compile.test.ts — the mingo-backing tests
 * (rules-engine-wrap-mingo-2026-06-05, D-002/D-003).
 *
 * Two jobs:
 *  1. The translation layer — `compileToMingo` maps the curated MatchMap
 *     vocabulary onto the `$`-operators correctly, and the compiled query
 *     EVALUATES the same as `evaluateDataCondition` (cross-check).
 *  2. The edge cases — where mingo's well-defined MongoDB semantics legitimately
 *     differ from the old hand-rolled evaluator. Those divergences are ADOPTED
 *     on purpose (the whole point: stop owning regex/null/coercion/array
 *     edge-cases) and PINNED here so the chosen behaviour is trusted, per D-003
 *     ("add edge-case tests … before trusting the swap"). The existing
 *     operators.test.ts / matcher.test.ts remain the byte-identical conformance
 *     suite for scalar values; this file documents the boundary.
 */

import { describe, it, expect, vi } from 'vitest';
import { Query } from 'mingo';
import { compileToMingo, compileLeafClauses, evaluateOperatorTest, RULES_CONTEXT } from './compile';
import { evaluateDataCondition } from './matcher';
import { RulesEngine } from './engine';
import type { DataCondition } from './types';
import { OPERATOR_KEYS, isOperatorTest, type OperatorTest } from './operators';

/** Exercise both public execution paths against an independently expected result. */
function expectLeaf(test: OperatorTest, value: unknown, expected: boolean): void {
  expect(evaluateOperatorTest(test, value)).toBe(expected);
  const when = { value: test };
  expect(evaluateDataCondition(when, { value })).toBe(expected);
  expect(new Query(compileToMingo(when), { context: RULES_CONTEXT } as never).test({ value } as never)).toBe(expected);
}

it('rules events reuse R-5 preserves default exact comparison behavior', () => {
  const cases: [OperatorTest, unknown, boolean][] = [
    [{ equals: 'Bug' }, ' bug ', false], [{ equals: 2 }, '2', false],
    [{ equals: null }, undefined, true], [{ equals: 'a' }, ['a', 'b'], true],
    [{ equals: { a: 1 } }, { a: 1 }, true], [{ notEquals: 'a' }, 'b', true],
    [{ in: ['a'] }, 'a', true], [{ notIn: ['a'] }, 'a', false],
    [{ exists: false }, null, true], [{ truthy: false }, '', true],
    [{ gt: 2 }, 3, true], [{ gte: 2 }, 2, true], [{ lt: 2 }, 2, false], [{ lte: 2 }, 2, true],
    [{ startsWith: 'A' }, 'abc', false], [{ endsWith: 'c' }, 'abc', true], [{ matches: '^a' }, 'abc', true],
  ];
  for (const [test, value, expected] of cases) {
    expectLeaf(test, value, expected);
    expectLeaf({ ...test, as: 'exact' }, value, expected);
  }
  expect(isOperatorTest({ as: 'text' })).toBe(false);
  expect(isOperatorTest({ as: 'text', equals: 'x' })).toBe(true);
  expect(isOperatorTest({ as: 'text', equals: 'x', typo: true })).toBe(false);
});

it('rules events reuse R-34 compares trimmed case-folded scalar text including numbers and booleans', () => {
  for (const [expected, value] of [['bug', ' Bug '], ['42', 42], [true, ' TRUE '], [false, false]] as const) {
    expectLeaf({ as: 'text', equals: expected }, value, true);
    expectLeaf({ as: 'text', notEquals: expected }, value, false);
  }
  expectLeaf({ as: 'text', equals: 'feature' }, 'bug', false);
  for (const value of [null, undefined, {}, [], NaN, Infinity]) expectLeaf({ as: 'text', notEquals: 'bug' }, value, false);
});

it('rules events reuse R-35 compares finite numeric coercions', () => {
  for (const [test, value, expected] of [
    [{ equals: 2 }, ' 2 ', true], [{ notEquals: '2' }, 3, true],
    [{ in: ['2', 3] }, 2, true], [{ notIn: ['2', 3] }, '2', false],
    [{ gt: '2' }, '3', true], [{ gte: '2' }, 2, true], [{ lt: 3 }, '2', true], [{ lte: '2' }, 2, true],
    [{ equals: true }, '1', true], [{ truthy: false }, '0', true], [{ equals: 0 }, '', true],
  ] as [OperatorTest, unknown, boolean][]) expectLeaf({ ...test, as: 'number' }, value, expected);
});

it('rules events reuse R-35 invalid runtime numeric facts fail closed including negated comparisons', () => {
  for (const value of ['not-a-number', 'Infinity', NaN, Infinity, null, undefined, {}, [], [1]]) {
    for (const test of [{ equals: 2 }, { notEquals: 2 }, { in: [2] }, { notIn: [2] }, { gt: 0 }, { lte: 0 }, { truthy: false }]) {
      expectLeaf({ ...test, as: 'number' }, value, false);
    }
    expectLeaf({ as: 'number', notContainsItem: 2 }, [1, value], false);
  }
});

const noon = '2026-10-28T12:00:00Z';
const sameNoon = '2026-10-28T08:00:00-04:00';
it('rules events reuse R-36 compares offset-bearing ISO values as instants', () => {
  for (const test of [{ equals: noon }, { in: [noon] }, { gte: noon, lte: noon }]) expectLeaf({ ...test, as: 'time' }, sameNoon, true);
  for (const test of [{ notEquals: noon }, { notIn: [noon] }, { gt: noon }, { lt: noon }]) expectLeaf({ ...test, as: 'time' }, sameNoon, false);
  expectLeaf({ as: 'time', gt: noon }, '2026-10-28T13:00:00Z', true);
  expectLeaf({ as: 'time', lt: noon }, '2026-10-28T10:00:00Z', true);
});

it('rules events reuse R-36 invalid runtime timestamps fail closed including negated comparisons', () => {
  for (const value of ['2026-10-28T12:00:00', '2026-02-30T00:00:00Z', 'not-time', '', 0, null, undefined, {}, [], new Date(noon)]) {
    for (const test of [{ equals: noon }, { notEquals: noon }, { in: [noon] }, { notIn: [noon] }, { gt: noon }, { lte: noon }]) {
      expectLeaf({ ...test, as: 'time' }, value, false);
    }
    expectLeaf({ as: 'time', notContainsItem: noon }, [sameNoon, value], false);
  }
});

it('rules events reuse R-37 applies the selected mode to every applicable operator in a leaf', () => {
  expectLeaf({ as: 'text', equals: ' BUG ', notEquals: 'feature', in: [' Bug'], notIn: ['Feature'], gt: 'aaa', gte: 'BUG', lt: 'zzz', lte: 'bug', startsWith: ' B ', endsWith: ' G ', containsText: ' U ', notContainsText: 'x', contains: 'U', notContains: 'x', matches: '^BUG$', exists: true, truthy: true }, ' Bug ', true);
  expectLeaf({ as: 'text', equals: 'bug', notEquals: 'BUG' }, 'Bug', false);
  expectLeaf({ as: 'text', matches: '^\\D+$' }, ' BUG ', true); // regex syntax is not case-folded
  expectLeaf({ as: 'text', startsWith: 1, endsWith: 3 }, 123, true);
  expectLeaf({ as: 'number', equals: '2', in: ['2'], notIn: [3], gte: '2', lt: '3', exists: true, truthy: true }, '2', true);
  expectLeaf({ as: 'time', equals: noon, in: [sameNoon], notIn: ['2026-10-27T00:00:00Z'], gte: sameNoon, lte: noon }, sameNoon, true);
  // Presence is structural; truthiness is evaluated on the mode's scalar reading.
  expectLeaf({ as: 'number', exists: false }, undefined, true);
  expectLeaf({ as: 'text', truthy: false }, '   ', true);
});

it('rules events reuse R-38 matches list members without scalar substring matching', () => {
  expectLeaf({ containsItem: { a: 1 } }, [{ a: 1 }], true);
  expectLeaf({ notContainsItem: 'x' }, ['y'], true);
  expectLeaf({ containsItem: 'x' }, ['xx'], false);
  for (const value of ['x', 'xx', 42, null, undefined, {}]) {
    expectLeaf({ containsItem: 'x' }, value, false);
    expectLeaf({ notContainsItem: 'x' }, value, false);
  }
  expectLeaf({ as: 'text', containsItem: ' BUG ', notContainsItem: 'feature' }, ['bug', ' Other '], true);
  expectLeaf({ as: 'number', containsItem: 2, notContainsItem: 3 }, ['2', true], true);
  expectLeaf({ as: 'time', containsItem: noon, notContainsItem: '2026-10-27T00:00:00Z' }, [sameNoon], true);
});

it('rules events reuse R-39 matches scalar substrings without list membership matching', () => {
  expectLeaf({ containsText: 'ell', notContainsText: 'z' }, 'hello', true);
  expectLeaf({ notContainsText: 'ell' }, 'hello', false);
  for (const value of [['ell'], 123, null, undefined, {}]) {
    expectLeaf({ containsText: 'ell' }, value, false);
    expectLeaf({ notContainsText: 'ell' }, value, false);
  }
  expectLeaf({ as: 'text', containsText: ' ELL ', notContainsText: 'ZZ' }, ' HELLO ', true);
  expectLeaf({ as: 'text', containsText: 23 }, 1234, true);
  expectLeaf({ as: 'text', containsText: 'ell' }, ['ell'], false);
});

it('rules events reuse R-40 preserves legacy positive and negative list-or-substring containment', () => {
  for (const [value, expected] of [[['x'], true], ['xyz', true], ['X', false], [42, false], [null, false], [undefined, false]] as [unknown, boolean][]) {
    expectLeaf({ contains: 'x' }, value, expected);
    expectLeaf({ notContains: 'x' }, value, !expected);
    expectLeaf({ as: 'exact', contains: 'x' }, value, expected);
  }
  expectLeaf({ contains: 2 }, '123', true); // prior String(member) behavior
  expectLeaf({ contains: { a: 1 } }, [{ a: 1 }], true);
  expectLeaf({ as: 'number', contains: 2, notContains: 3 }, ['2'], true);
  expectLeaf({ as: 'time', contains: noon }, [sameNoon], true);
});

it('rules events reuse R-43 expresses time ordering through relational operators only', () => {
  expect(OPERATOR_KEYS).not.toContain('after');
  expect(OPERATOR_KEYS).not.toContain('before');
  expect(isOperatorTest({ as: 'time', after: noon })).toBe(false);
  expectLeaf({ as: 'time', gt: '2026-10-28T11:00:00Z', gte: noon, lt: '2026-10-28T13:00:00Z', lte: noon }, sameNoon, true);
});

/* ───────────────────────── compileToMingo — vocabulary map (D-002) ───────────────────────── */

describe('compileToMingo — vocabulary translation', () => {
  it('maps a MatchMap leaf to $eq (bare value)', () => {
    expect(compileToMingo({ 'args.kind': 'bug' })).toEqual({ 'args.kind': { $eq: 'bug' } });
  });

  it('maps each operator to its $-form', () => {
    expect(compileLeafClauses({ equals: 5 })).toEqual([{ $eq: 5 }]);
    expect(compileLeafClauses({ notEquals: 5 })).toEqual([{ $ne: 5 }]);
    expect(compileLeafClauses({ in: ['a', 'b'] })).toEqual([{ $in: ['a', 'b'] }]);
    expect(compileLeafClauses({ notIn: ['a'] })).toEqual([{ $nin: ['a'] }]);
    expect(compileLeafClauses({ gt: 3, gte: 1, lt: 9, lte: 8 })).toEqual([{ $gt: 3, $gte: 1, $lt: 9, $lte: 8 }]);
  });

  it('translates exists to not-null ($ne null) / null ($eq null), NOT mongo $exists', () => {
    expect(compileLeafClauses({ exists: true })).toEqual([{ $ne: null }]);
    expect(compileLeafClauses({ exists: false })).toEqual([{ $eq: null }]);
  });

  it('registers truthy / contains / notContains as custom ops', () => {
    expect(compileLeafClauses({ truthy: true })).toEqual([{ $pcTruthy: true }]);
    expect(compileLeafClauses({ contains: 'x' })).toEqual([{ $pcContains: 'x' }]);
    expect(compileLeafClauses({ notContains: 'x' })).toEqual([{ $pcNotContains: 'x' }]);
  });

  it('translates matches / startsWith / endsWith to anchored, escaped $regex', () => {
    expect(compileLeafClauses({ matches: '^F-\\d+$' })).toEqual([{ $regex: /^F-\d+$/ }]);
    expect(compileLeafClauses({ startsWith: 'coord:' })).toEqual([{ $regex: /^coord:/ }]);
    expect(compileLeafClauses({ endsWith: ':done' })).toEqual([{ $regex: /:done$/ }]);
    // dot is escaped (literal), not a wildcard
    expect(compileLeafClauses({ startsWith: 'a.' })).toEqual([{ $regex: /^a\./ }]);
  });

  it('maps combinators all/any/not → $and/$or/$nor', () => {
    expect(compileToMingo({ all: [{ a: 1 }, { b: 2 }] })).toEqual({ $and: [{ a: { $eq: 1 } }, { b: { $eq: 2 } }] });
    expect(compileToMingo({ any: [{ a: 1 }] })).toEqual({ $or: [{ a: { $eq: 1 } }] });
    expect(compileToMingo({ not: { a: 1 } })).toEqual({ $nor: [{ a: { $eq: 1 } }] });
  });

  it('maps some k-of-n: require:1 → $or, require:n → $and', () => {
    // require:1 is the `any` preset
    expect(compileToMingo({ some: { require: 1, of: [{ a: 1 }, { b: 2 }] } })).toEqual({
      $or: [{ a: { $eq: 1 } }, { b: { $eq: 2 } }],
    });
    // require === n is the `all` preset
    expect(compileToMingo({ some: { require: 2, of: [{ a: 1 }, { b: 2 }] } })).toEqual({
      $and: [{ a: { $eq: 1 } }, { b: { $eq: 2 } }],
    });
  });

  it('maps genuine k-of-n (1<k<n) → $or over every k-subset ($and)', () => {
    expect(compileToMingo({ some: { require: 2, of: [{ a: 1 }, { b: 2 }, { c: 3 }] } })).toEqual({
      $or: [
        { $and: [{ a: { $eq: 1 } }, { b: { $eq: 2 } }] },
        { $and: [{ a: { $eq: 1 } }, { c: { $eq: 3 } }] },
        { $and: [{ b: { $eq: 2 } }, { c: { $eq: 3 } }] },
      ],
    });
  });

  it('maps an unsatisfiable some (require>n, or empty of) → match-nothing ($nor of match-all)', () => {
    expect(compileToMingo({ some: { require: 3, of: [{ a: 1 }, { b: 2 }] } })).toEqual({ $nor: [{}] });
    expect(compileToMingo({ some: { require: 1, of: [] } })).toEqual({ $nor: [{}] });
  });

  it('a multi-key MatchMap ANDs each path clause', () => {
    expect(compileToMingo({ x: { gte: 3, lte: 5 }, y: { exists: true } })).toEqual({
      $and: [{ x: { $gte: 3, $lte: 5 } }, { y: { $ne: null } }],
    });
  });

  it('multiple operators in one leaf become separate AND clauses (no $-key collision)', () => {
    // notEquals + exists:true both want $ne — must not collide.
    expect(compileLeafClauses({ notEquals: 'x', exists: true })).toEqual([{ $ne: 'x' }, { $ne: null }]);
  });
});

/* ───────────────────────── compileToMingo ≡ evaluateDataCondition (object paths) ───────────────────────── */

describe('compiled mingo query evaluates identically to evaluateDataCondition', () => {
  const event = {
    tool: 'coord:handoff',
    args: { item: 'WI-001', kind: 'bug', count: 3, to: ['a', 'b'] },
    result: { ok: true, data: { count: 3 } },
  };
  const run = (when: DataCondition, doc: unknown) => new Query(compileToMingo(when), { context: RULES_CONTEXT } as never).test(doc as never);

  const conds: DataCondition[] = [
    { 'args.item': { exists: true } },
    { 'args.item': { exists: true }, 'result.ok': true },
    { 'args.kind': 'bug' },
    { 'args.kind': 'feature' },
    { 'args.count': { gte: 3, lte: 5 } },
    { 'args.to': { contains: 'a' } },
    { 'args.to': { contains: 'z' } },
    { all: [{ 'args.kind': 'bug' }, { 'result.ok': true }] },
    { any: [{ 'args.kind': 'feature' }, { 'result.ok': true }] },
    { not: { 'args.kind': 'feature' } },
    { all: [{ 'args.item': { exists: true } }, { any: [{ 'args.kind': 'bug' }, { 'args.kind': 'feature' }] }] },
    // some — k-of-n against the event (kind bug ✓, kind feature ✗, ok true ✓, count 3):
    { some: { require: 1, of: [{ 'args.kind': 'feature' }, { 'result.ok': true }] } }, // 1 of 2 ⇒ true
    { some: { require: 2, of: [{ 'args.kind': 'bug' }, { 'args.kind': 'feature' }, { 'result.ok': true }] } }, // 2 of 3 ⇒ true (subset expansion)
    { some: { require: 3, of: [{ 'args.kind': 'bug' }, { 'args.kind': 'feature' }, { 'result.ok': true }] } }, // only 2 pass ⇒ false
    { some: { require: 2, of: [{ 'args.kind': 'feature' }, { 'args.count': 999 }] } }, // 0 pass ⇒ false
    { some: { require: 4, of: [{ 'args.kind': 'bug' }, { 'result.ok': true }, { 'args.count': 3 }] } }, // require>n ⇒ unsatisfiable false
    { some: { require: 1, of: [] } }, // empty of ⇒ unsatisfiable false
    { all: [{ 'args.item': { exists: true } }, { some: { require: 2, of: [{ 'args.kind': 'bug' }, { 'result.ok': true }, { 'args.count': 1 }] } }] }, // nested ⇒ true
  ];

  for (const cond of conds) {
    it(`agrees for ${JSON.stringify(cond)}`, () => {
      expect(run(cond, event)).toBe(evaluateDataCondition(cond, event));
    });
  }
});

/* ───────────────────────── EDGE CASES — adopted mingo (MongoDB) semantics ───────────────────────── */

describe('edge: implicit array-element matching (MongoDB semantics)', () => {
  // When a resolved value is an ARRAY, mingo matches element-wise. The old
  // evaluator treated an array as one atomic value. We adopt mingo's standard
  // MongoDB array semantics for the $-backed operators.
  it('equals / bare value match if an element matches', () => {
    expect(evaluateOperatorTest({ equals: 'x' }, ['x', 'y'])).toBe(true);
    expect(evaluateOperatorTest('x', ['x', 'y'])).toBe(true);
    // exact whole-array equality still works (mingo checks isEqual first)
    expect(evaluateOperatorTest({ equals: ['x', 'y'] }, ['x', 'y'])).toBe(true);
  });
  it('in matches if the array shares any member with the list', () => {
    expect(evaluateOperatorTest({ in: ['x', 'y'] }, ['x'])).toBe(true);
    expect(evaluateOperatorTest({ in: ['q'] }, ['x'])).toBe(false);
  });
  it('notEquals is the negation — false when an element equals', () => {
    expect(evaluateOperatorTest({ notEquals: 'x' }, ['x', 'y'])).toBe(false);
  });
  it('numeric / regex comparisons match per-element', () => {
    expect(evaluateOperatorTest({ gt: 3 }, [4])).toBe(true);
    expect(evaluateOperatorTest({ startsWith: 'x' }, ['x', 'y'])).toBe(true);
  });
  it('contains / exists / truthy stay atomic (our ops) even on arrays', () => {
    expect(evaluateOperatorTest({ contains: 'x' }, ['x', 'y'])).toBe(true);
    expect(evaluateOperatorTest({ exists: true }, [])).toBe(true);
    expect(evaluateOperatorTest({ truthy: true }, [])).toBe(true); // Boolean([]) === true
  });
});

describe('edge: null handling — null and undefined are equal under $eq/$ne (MongoDB idiom)', () => {
  it('equals null also matches a missing/undefined value', () => {
    expect(evaluateOperatorTest({ equals: null }, null)).toBe(true);
    expect(evaluateOperatorTest({ equals: null }, undefined)).toBe(true);
  });
  it('notEquals null excludes both null and undefined', () => {
    expect(evaluateOperatorTest({ notEquals: null }, undefined)).toBe(false);
    expect(evaluateOperatorTest({ notEquals: null }, 0)).toBe(true);
  });
});

describe('edge: type coercion — comparisons are BSON-typed (no coercion)', () => {
  it('bigint is NOT coerced to number for comparison', () => {
    // old evaluator did toNumber(5n)=5 > 3; mingo compares only same-type values.
    // (JSON events never carry bigint, so this only affects exotic in-code rules.)
    expect(evaluateOperatorTest({ gt: 3 }, 5n)).toBe(false);
  });
  it('a non-numeric value never satisfies a comparison', () => {
    expect(evaluateOperatorTest({ gt: 3 }, 'notnum')).toBe(false);
    expect(evaluateOperatorTest({ lte: 5 }, { a: 1 })).toBe(false);
  });
  it('NaN follows mingo ordering (unordered → equal): documented, do not rely on it', () => {
    // Pinned to make the behaviour visible. JSON never carries NaN.
    expect(evaluateOperatorTest({ gt: 3 }, NaN)).toBe(false);
    expect(evaluateOperatorTest({ lt: 5 }, NaN)).toBe(false);
    expect(evaluateOperatorTest({ gte: 3 }, NaN)).toBe(true);
    expect(evaluateOperatorTest({ lte: 5 }, NaN)).toBe(true);
  });
});

describe('edge: regex applies to strings only ($regex semantics)', () => {
  it('matches against a number is false (no String() coercion)', () => {
    expect(evaluateOperatorTest({ matches: '\\d' }, 5)).toBe(false);
    expect(evaluateOperatorTest({ matches: '^F' }, 'F-1')).toBe(true);
  });
  it('regex flags are honoured; stateful g/y flags are stripped (stateless leaf match)', () => {
    expect(evaluateOperatorTest({ matches: { source: 'abc', flags: 'i' } }, 'ABC')).toBe(true);
    // a global flag would leak lastIndex across a reused/cached regex — stripped, so repeats are stable.
    expect(evaluateOperatorTest({ matches: { source: 'a', flags: 'g' } }, 'a')).toBe(true);
    expect(evaluateOperatorTest({ matches: { source: 'a', flags: 'g' } }, 'a')).toBe(true);
  });
});

/* ───────────────────────── custom ops — direct fidelity ───────────────────────── */

describe('custom ops match the old contains/truthy semantics exactly', () => {
  it('contains: array-includes (deep) OR string-substring, else false', () => {
    expect(evaluateOperatorTest({ contains: 'ell' }, 'hello')).toBe(true);
    expect(evaluateOperatorTest({ contains: { x: 1 } }, [{ x: 1 }, { y: 2 }])).toBe(true); // deep array member
    expect(evaluateOperatorTest({ contains: 'x' }, 42)).toBe(false); // non-collection
    expect(evaluateOperatorTest({ contains: 'x' }, null)).toBe(false);
  });
  it('notContains is the negation', () => {
    expect(evaluateOperatorTest({ notContains: 'q' }, 'hello')).toBe(true);
    expect(evaluateOperatorTest({ notContains: 'ell' }, 'hello')).toBe(false);
  });
  it('truthy uses JS Boolean()', () => {
    expect(evaluateOperatorTest({ truthy: true }, 'x')).toBe(true);
    expect(evaluateOperatorTest({ truthy: true }, 0)).toBe(false);
    expect(evaluateOperatorTest({ truthy: false }, '')).toBe(true);
    expect(evaluateOperatorTest({ truthy: false }, null)).toBe(true);
  });
});

/* ───────────────────────── author-bug operands surface via onError ───────────────────────── */

describe('an un-compilable operand throws (author bug) and the engine catches it', () => {
  it('a bad matches regex source throws from evaluateOperatorTest', () => {
    expect(() => evaluateOperatorTest({ matches: '[' }, 'x')).toThrow();
  });
  it('a NaN expected-value throws (mingo cannot clone it)', () => {
    expect(() => evaluateOperatorTest({ equals: NaN }, 5)).toThrow();
  });
  it('the engine routes the throw to onError and skips only that rule', () => {
    const onError = vi.fn();
    const e = new RulesEngine<{ tool: string; x: unknown }>({ keyOf: (ev) => ev.tool, onError });
    e.add({ id: 'bad', on: 'a', when: { x: { matches: '[' } }, fire: 'X' });
    e.add({ id: 'good', on: 'a', when: { x: 'ok' }, fire: 'Y' });
    const out = e.match({ tool: 'a', x: 'ok' });
    expect(out.map((m) => m.ruleId)).toEqual(['good']);
    expect(onError).toHaveBeenCalledOnce();
  });
});

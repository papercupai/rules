/**
 * Zod schemas for the SERIALIZABLE rule form (rules-engine D-004: "Zod-validated
 * rule schema").
 *
 * A rule whose `when` is a data-condition and whose `args` is a static object is
 * fully serializable (JSON / an Events file). Predicate `when`s and function
 * `args` are the in-code escape-hatch and cannot be Zod-described — for those,
 * use `validateRuleShape` (validate.ts) instead. So: parse data-form rules with
 * `parseSerializableRule`; structurally check any rule with `validateRuleShape`.
 */

import { z } from 'zod';
import { OPERATOR_KEYS, COMPARISON_MODES, type OperatorTest } from './operators';
import { comparisonError, conditionComparisonError } from './comparison';

const comparisonScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

/** A single leaf operator test — every operator optional, at least the known keys. */
export const operatorTestSchema = z
  .object({
    as: z.enum(COMPARISON_MODES).optional(),
    equals: z.unknown().optional(),
    notEquals: z.unknown().optional(),
    exists: z.boolean().optional(),
    truthy: z.boolean().optional(),
    in: z.array(z.unknown()).optional(),
    notIn: z.array(z.unknown()).optional(),
    contains: z.unknown().optional(),
    notContains: z.unknown().optional(),
    containsItem: z.unknown().optional(),
    notContainsItem: z.unknown().optional(),
    containsText: comparisonScalarSchema.optional(),
    notContainsText: comparisonScalarSchema.optional(),
    gt: comparisonScalarSchema.optional(),
    gte: comparisonScalarSchema.optional(),
    lt: comparisonScalarSchema.optional(),
    lte: comparisonScalarSchema.optional(),
    matches: z.union([z.string(), z.object({ source: z.string(), flags: z.string().optional() })]).optional(),
    startsWith: comparisonScalarSchema.optional(),
    endsWith: comparisonScalarSchema.optional(),
  })
  .strict()
  .superRefine((test, ctx) => {
    if ('as' in test && !OPERATOR_KEYS.some((key) => key in test)) {
      ctx.addIssue({ code: 'custom', message: 'as requires at least one operator' });
    }
    const error = comparisonError(test as OperatorTest);
    if (error) ctx.addIssue({ code: 'custom', message: error });
    if ((test.as ?? 'exact') === 'exact') {
      for (const key of ['gt', 'gte', 'lt', 'lte'] as const) {
        if (key in test && typeof test[key] !== 'number') ctx.addIssue({ code: 'custom', message: `${key} requires a number in exact mode` });
      }
      for (const key of ['startsWith', 'endsWith'] as const) {
        if (key in test && typeof test[key] !== 'string') ctx.addIssue({ code: 'custom', message: `${key} requires a string in exact mode` });
      }
    }
  });

const combinatorKeys = ['all', 'any', 'some', 'not'];

// A sole combinator key must validate in its recursive branch; otherwise a
// malformed child can escape through this arbitrary-value MatchMap fallback.
// Multi-key maps still treat these names as ordinary paths, as the matcher does.
const matchMapSchema = z
  .record(z.string(), z.unknown())
  .refine((map) => {
    const keys = Object.keys(map);
    return keys.length !== 1 || !combinatorKeys.includes(keys[0]);
  }, 'A sole combinator key must contain a valid recursive condition')
  .refine((map) => conditionComparisonError(map) === null, 'Invalid comparison mode, operand or operator')
  // Refinements are not projected by Zod. Publish the equivalent constraint so
  // MCP/JSON-schema callers cannot accept what the callable Zod schema rejects.
  .meta({ not: { maxProperties: 1, anyOf: combinatorKeys.map((key) => ({ required: [key] })) } });

/**
 * A declarative condition. Combinators (`all`/`any`/`some`/`not`) are recognised
 * only as the sole key (`.strict()`); malformed sole-key combinators are rejected,
 * otherwise it's a match-map of path → test/value. Recursive via `z.lazy`.
 * Typed loosely to avoid TS recursion blow-up.
 *
 * `some: { require: k, of: [...] }` is the k-of-n threshold combinator: satisfied
 * when at least `k` of the `of` sub-conditions hold. `any` ≡ `some{require:1}`,
 * `all` ≡ `some{require:n}` — `some` is the general form the two are presets of.
 * (composable-event-awaits P-001: the awaits-spec grammar IS this schema, no fork.)
 */
export const dataConditionSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.object({ all: z.array(dataConditionSchema) }).strict(),
    z.object({ any: z.array(dataConditionSchema) }).strict(),
    z
      .object({ some: z.object({ require: z.number().int().min(1), of: z.array(dataConditionSchema) }).strict() })
      .strict(),
    z.object({ not: dataConditionSchema }).strict(),
    matchMapSchema,
  ]),
);

/** The serializable rule schema: `{ id, on, when?, fire, args?, meta? }`. */
export const serializableRuleSchema = z.object({
  id: z.string().min(1),
  on: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  when: dataConditionSchema.optional(),
  fire: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type SerializableRule = z.infer<typeof serializableRuleSchema>;

/** Parse + validate a data-form rule. Throws a ZodError on a bad shape. */
export function parseSerializableRule(input: unknown): SerializableRule {
  return serializableRuleSchema.parse(input);
}

/** Non-throwing variant. */
export function safeParseSerializableRule(input: unknown): z.ZodSafeParseResult<SerializableRule> {
  return serializableRuleSchema.safeParse(input);
}

/** Parse a whole Events file: an array of serializable rules. */
export function parseSerializableRules(input: unknown): SerializableRule[] {
  return z.array(serializableRuleSchema).parse(input);
}

/** The operator vocabulary, re-exported so a consumer can document/inspect it. */
export const KNOWN_OPERATORS = OPERATOR_KEYS;

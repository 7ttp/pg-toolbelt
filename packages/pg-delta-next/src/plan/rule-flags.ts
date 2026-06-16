/**
 * Per-kind graph/suppression flags read from the rule table (guardrail 3): the
 * planner body and its phases hold NO kind-name lists — they ask the rule table.
 * `rulesFor` throws for unknown kinds, so `ruleFlag` guards it and the boolean
 * accessors default to false.
 */
import type { KindRules } from "./rules.ts";
import { rulesFor } from "./rules.ts";

export function ruleFlag<K extends keyof KindRules>(
  kind: string,
  flag: K,
): KindRules[K] | undefined {
  try {
    return rulesFor(kind)[flag];
  } catch {
    return undefined;
  }
}

export const cascadesToChildren = (kind: string): boolean =>
  ruleFlag(kind, "cascadesToChildren") === true;

export const isRebuildable = (kind: string): boolean =>
  ruleFlag(kind, "rebuildable") === true;

/**
 * The EXPECTED_RED ledger (stage 0): scenarios whose engine support has not
 * landed yet. A listed test MUST fail (red = engine missing, pinned); an
 * accidentally-green listed test fails the suite so flipping an entry is
 * always a deliberate one-line diff.
 *
 * Entries are scenario directory names; a `:reverse` suffix pins only the
 * teardown direction.
 */
export const EXPECTED_RED: ReadonlySet<string> = new Set<string>([
  // F3: the membership drop now emits a plain REVOKE (no CASCADE). Tearing down
  // a multi-grantor membership where the removed grant has a dependent onward
  // grant fails LOUDLY on PG16+ ("dependent privileges exist") instead of
  // silently CASCADE-destroying the kept grant. Convergent regrant that would
  // let this teardown converge is tracked separately (#333); until it lands the
  // reverse (teardown) direction is expected-red. Forward (create) still passes.
  "role-membership-dedup--multi-grantor:reverse",
]);

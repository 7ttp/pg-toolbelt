import { describe, expect, test } from "bun:test";
import { DefaultPrivilegeState } from "../base.default-privileges.ts";
import { diffAggregates } from "./aggregate.diff.ts";
import { Aggregate } from "./aggregate.model.ts";
import { AlterAggregateChangeOwner } from "./changes/aggregate.alter.ts";
import {
  CreateCommentOnAggregate,
  DropCommentOnAggregate,
} from "./changes/aggregate.comment.ts";
import { CreateAggregate } from "./changes/aggregate.create.ts";
import { DropAggregate } from "./changes/aggregate.drop.ts";
import {
  GrantAggregatePrivileges,
  RevokeAggregatePrivileges,
  RevokeGrantOptionAggregatePrivileges,
} from "./changes/aggregate.privilege.ts";

type AggregateProps = ConstructorParameters<typeof Aggregate>[0];

const base: AggregateProps = {
  schema: "public",
  name: "agg_sum",
  identity_arguments: "integer",
  kind: "a",
  aggkind: "n",
  num_direct_args: 0,
  return_type: "integer",
  return_type_schema: "pg_catalog",
  parallel_safety: "u",
  is_strict: false,
  transition_function: "pg_catalog.int4pl(integer,integer)",
  state_data_type: "integer",
  state_data_type_schema: "pg_catalog",
  state_data_space: 0,
  final_function: null,
  final_function_extra_args: false,
  final_function_modify: null,
  combine_function: null,
  serial_function: null,
  deserial_function: null,
  initial_condition: null,
  moving_transition_function: null,
  moving_inverse_function: null,
  moving_state_data_type: null,
  moving_state_data_type_schema: null,
  moving_state_data_space: null,
  moving_final_function: null,
  moving_final_function_extra_args: false,
  moving_final_function_modify: null,
  moving_initial_condition: null,
  sort_operator: null,
  argument_count: 1,
  argument_default_count: 0,
  argument_names: null,
  argument_types: ["integer"],
  all_argument_types: null,
  argument_modes: null,
  argument_defaults: null,
  owner: "owner1",
  comment: null,
  privileges: [],
};

const makeAggregate = (override: Partial<AggregateProps> = {}) =>
  new Aggregate({
    ...base,
    ...override,
    privileges: override.privileges ?? [...base.privileges],
  });

const testContext = {
  version: 170000,
  currentUser: "postgres",
  defaultPrivilegeState: new DefaultPrivilegeState({}),
  mainRoles: {},
};

function publicExecutePrivilege() {
  return [{ grantee: "PUBLIC", privilege: "EXECUTE", grantable: false }];
}

function routineDefaults(): DefaultPrivilegeState {
  const state = new DefaultPrivilegeState({});
  state.applyGrant("postgres", "f", null, "PUBLIC", [
    { privilege: "EXECUTE", grantable: false },
  ]);
  return state;
}

function contextWith(
  overrides: Partial<typeof testContext> & {
    skipDefaultPrivilegeSubtraction?: boolean;
  } = {},
) {
  return {
    ...testContext,
    defaultPrivilegeState: new DefaultPrivilegeState({}),
    ...overrides,
  };
}

describe.concurrent("aggregate.diff", () => {
  test("create and drop emit expected changes", () => {
    const aggregate = makeAggregate({ comment: "sum comment" });
    const created = diffAggregates(
      testContext,
      {},
      { [aggregate.stableId]: aggregate },
    );

    expect(created[0]).toBeInstanceOf(CreateAggregate);
    expect(
      created.some((change) => change instanceof CreateCommentOnAggregate),
    ).toBe(true);

    const dropped = diffAggregates(
      testContext,
      { [aggregate.stableId]: aggregate },
      {},
    );

    expect(dropped[0]).toBeInstanceOf(DropAggregate);
  });

  test("alter owner produces change owner statement", () => {
    const main = makeAggregate();
    const branch = makeAggregate({ owner: "owner2" });
    const changes = diffAggregates(
      testContext,
      { [main.stableId]: main },
      { [branch.stableId]: branch },
    );

    expect(changes).toHaveLength(1);
    expect(changes[0]).toBeInstanceOf(AlterAggregateChangeOwner);
  });

  test("comment changes emit create/drop comment statements", () => {
    const main = makeAggregate();
    const withComment = makeAggregate({ comment: "sum comment" });
    const addComment = diffAggregates(
      testContext,
      { [main.stableId]: main },
      { [withComment.stableId]: withComment },
    );

    expect(addComment[0]).toBeInstanceOf(CreateCommentOnAggregate);

    const dropComment = diffAggregates(
      testContext,
      { [withComment.stableId]: withComment },
      { [main.stableId]: main },
    );

    expect(dropComment[0]).toBeInstanceOf(DropCommentOnAggregate);
  });

  test("non-alterable changes force create or replace", () => {
    const main = makeAggregate();
    const branch = makeAggregate({ return_type: "text" });
    const changes = diffAggregates(
      testContext,
      { [main.stableId]: main },
      { [branch.stableId]: branch },
    );

    expect(changes).toHaveLength(1);
    expect(changes[0]).toBeInstanceOf(CreateAggregate);
    expect((changes[0] as CreateAggregate).orReplace).toBe(true);
  });

  test("privilege diffs emit grant, revoke, and revoke grant option statements", () => {
    const main = makeAggregate({
      privileges: [
        { grantee: "role_exec", privilege: "EXECUTE", grantable: false },
        { grantee: "role_with_option", privilege: "EXECUTE", grantable: true },
        { grantee: "role_removed", privilege: "EXECUTE", grantable: false },
      ],
    });
    const branch = makeAggregate({
      privileges: [
        { grantee: "role_exec", privilege: "EXECUTE", grantable: true },
        { grantee: "role_with_option", privilege: "EXECUTE", grantable: false },
        { grantee: "role_new", privilege: "EXECUTE", grantable: false },
      ],
    });

    const changes = diffAggregates(
      testContext,
      { [main.stableId]: main },
      { [branch.stableId]: branch },
    );

    expect(
      changes.some((change) => change instanceof GrantAggregatePrivileges),
    ).toBe(true);
    expect(
      changes.some((change) => change instanceof RevokeAggregatePrivileges),
    ).toBe(true);
    expect(
      changes.some(
        (change) => change instanceof RevokeGrantOptionAggregatePrivileges,
      ),
    ).toBe(true);

    const grantBase = changes.find(
      (change) =>
        change instanceof GrantAggregatePrivileges &&
        change.grantee === "role_with_option",
    ) as GrantAggregatePrivileges | undefined;
    expect(grantBase?.privileges).toEqual([
      {
        grantee: "role_with_option",
        privilege: "EXECUTE",
        grantable: false,
      } as never,
    ]);

    const revokeGrantOption = changes.find(
      (change) =>
        change instanceof RevokeGrantOptionAggregatePrivileges &&
        change.grantee === "role_with_option",
    ) as RevokeGrantOptionAggregatePrivileges | undefined;
    expect(revokeGrantOption?.privilegeNames).toEqual(["EXECUTE"]);

    const revokePrivilege = changes.find(
      (change) =>
        change instanceof RevokeAggregatePrivileges &&
        change.grantee === "role_removed",
    ) as RevokeAggregatePrivileges | undefined;
    expect(revokePrivilege?.privileges).toEqual([
      {
        grantee: "role_removed",
        privilege: "EXECUTE",
        grantable: false,
      } as never,
    ]);
  });

  test("create revokes the built-in PUBLIC EXECUTE privilege when absent from the target", () => {
    const branch = makeAggregate({ owner: "postgres" });
    const changes = diffAggregates(
      contextWith({ defaultPrivilegeState: routineDefaults() }),
      {},
      { [branch.stableId]: branch },
    );

    expect(
      changes
        .find((change) => change instanceof RevokeAggregatePrivileges)
        ?.serialize(),
    ).toBe("REVOKE ALL ON FUNCTION public.agg_sum(integer) FROM PUBLIC");
  });

  test("alter emits a PUBLIC EXECUTE revoke and can restore it with a grant", () => {
    const withPublic = makeAggregate({
      owner: "postgres",
      privileges: publicExecutePrivilege(),
    });
    const withoutPublic = makeAggregate({
      owner: "postgres",
      privileges: [],
    });

    const revokeChanges = diffAggregates(
      contextWith(),
      { [withPublic.stableId]: withPublic },
      { [withoutPublic.stableId]: withoutPublic },
    );
    const grantChanges = diffAggregates(
      contextWith(),
      { [withoutPublic.stableId]: withoutPublic },
      { [withPublic.stableId]: withPublic },
    );

    expect(
      revokeChanges
        .find((change) => change instanceof RevokeAggregatePrivileges)
        ?.serialize(),
    ).toBe("REVOKE ALL ON FUNCTION public.agg_sum(integer) FROM PUBLIC");
    expect(
      grantChanges
        .find((change) => change instanceof GrantAggregatePrivileges)
        ?.serialize(),
    ).toBe("GRANT ALL ON FUNCTION public.agg_sum(integer) TO PUBLIC");
  });

  test("create or replace still emits a simultaneous PUBLIC EXECUTE revoke", () => {
    const main = makeAggregate({
      owner: "postgres",
      privileges: publicExecutePrivilege(),
    });
    const branch = makeAggregate({
      owner: "postgres",
      initial_condition: "1",
    });

    const changes = diffAggregates(
      contextWith(),
      { [main.stableId]: main },
      { [branch.stableId]: branch },
    );

    expect(
      changes.some(
        (change) =>
          change instanceof CreateAggregate && change.orReplace === true,
      ),
    ).toBe(true);
    expect(
      changes
        .find((change) => change instanceof RevokeAggregatePrivileges)
        ?.serialize(),
    ).toBe("REVOKE ALL ON FUNCTION public.agg_sum(integer) FROM PUBLIC");
  });

  test("self-contained create still models PostgreSQL's built-in PUBLIC EXECUTE baseline", () => {
    const branch = makeAggregate({ owner: "postgres" });
    const changes = diffAggregates(
      contextWith({ skipDefaultPrivilegeSubtraction: true }),
      {},
      { [branch.stableId]: branch },
    );

    expect(
      changes
        .find((change) => change instanceof RevokeAggregatePrivileges)
        ?.serialize(),
    ).toBe("REVOKE ALL ON FUNCTION public.agg_sum(integer) FROM PUBLIC");
  });
});

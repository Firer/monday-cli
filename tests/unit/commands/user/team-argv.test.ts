/**
 * Argv parser unit tests for the v0.5-M34 team writer pre-flight
 * surface (cli-design §4.3 USER section + §13 v0.5 entry;
 * v0.5-plan §3 M34).
 *
 * Test matrix scope: per-verb input-schema parse-boundary surface +
 * `--users` comma-split through the lifted
 * {@link parseBrandedListArg} helper (generic split / trim / empty-
 * entry / brand-rejection behaviour is pinned at
 * `tests/unit/utils/parse-brand-list.test.ts`). The per-verb tests
 * below cover the schema-level rejections (required-flag absence,
 * unknown-flag strict rejection, TeamId brand rejection) so future
 * argv-shape drift surfaces inline.
 *
 * Runtime body (wire dispatch, partial-success envelope projection,
 * destructive-gate emit) lands at v0.5-M34 IMPL with integration
 * tests there.
 *
 * The schema is the contract surface; agents key off the
 * `usage_error.details.issues` shape per cli-design §6.5.
 */
import { describe, expect, it } from 'vitest';
import { teamListCommand } from '../../../../src/commands/user/team-list.js';
import { teamGetCommand } from '../../../../src/commands/user/team-get.js';
import { teamCreateCommand } from '../../../../src/commands/user/team-create.js';
import { teamDeleteCommand } from '../../../../src/commands/user/team-delete.js';
import { teamAddMembersCommand } from '../../../../src/commands/user/team-add-members.js';
import { teamRemoveMembersCommand } from '../../../../src/commands/user/team-remove-members.js';
import { teamSchema, teamWireSchema } from '../../../../src/api/teams.js';
import { UsageError } from '../../../../src/utils/errors.js';
import { parseArgv } from '../../../../src/commands/parse-argv.js';

describe('teamListCommand.inputSchema (M34 team-list argv)', () => {
  it('parses an empty argv', () => {
    const parsed = parseArgv(teamListCommand.inputSchema, {});
    expect(parsed).toEqual({});
  });

  it('rejects unknown keys (strict schema)', () => {
    expect(() =>
      // @ts-expect-error — testing strict-mode rejection
      parseArgv(teamListCommand.inputSchema, { unknownFlag: 'oops' }),
    ).toThrow(UsageError);
  });

  it('declares the canonical command name', () => {
    expect(teamListCommand.name).toBe('user.team-list');
  });

  it('declares idempotent: true (pure read)', () => {
    expect(teamListCommand.idempotent).toBe(true);
  });

  it('ships at least one example', () => {
    expect(teamListCommand.examples.length).toBeGreaterThan(0);
  });
});

describe('teamGetCommand.inputSchema (M34 team-get argv)', () => {
  it('accepts a numeric teamId', () => {
    const parsed = parseArgv(teamGetCommand.inputSchema, { teamId: '12345' });
    expect(parsed.teamId).toBe('12345');
  });

  it('rejects a non-numeric teamId', () => {
    expect(() =>
      parseArgv(teamGetCommand.inputSchema, { teamId: 'abc' }),
    ).toThrow(UsageError);
  });

  it('rejects a missing teamId', () => {
    expect(() =>
      parseArgv(teamGetCommand.inputSchema, {}),
    ).toThrow(UsageError);
  });

  it('rejects unknown keys (strict schema)', () => {
    expect(() =>
      parseArgv(teamGetCommand.inputSchema, {
        teamId: '12345',
        // @ts-expect-error — testing strict-mode rejection
        unknownFlag: 'oops',
      }),
    ).toThrow(UsageError);
  });

  it('declares the canonical command name', () => {
    expect(teamGetCommand.name).toBe('user.team-get');
  });

  it('declares idempotent: true (pure read)', () => {
    expect(teamGetCommand.idempotent).toBe(true);
  });
});

describe('teamCreateCommand.inputSchema (M34 team-create argv)', () => {
  describe('happy paths', () => {
    it('accepts only --name (minimum required flags)', () => {
      const parsed = parseArgv(teamCreateCommand.inputSchema, {
        name: 'Backend Eng',
      });
      expect(parsed.name).toBe('Backend Eng');
      expect(parsed.users).toBeUndefined();
      expect(parsed.guestTeam).toBeUndefined();
      expect(parsed.allowEmpty).toBeUndefined();
    });

    it('accepts every documented flag together', () => {
      const parsed = parseArgv(teamCreateCommand.inputSchema, {
        name: 'Backend Eng',
        users: '67890,67891',
        guestTeam: true,
        allowEmpty: true,
      });
      expect(parsed.name).toBe('Backend Eng');
      expect(parsed.users).toBe('67890,67891');
      expect(parsed.guestTeam).toBe(true);
      expect(parsed.allowEmpty).toBe(true);
    });
  });

  describe('schema-level rejections', () => {
    it('rejects a missing --name', () => {
      expect(() => parseArgv(teamCreateCommand.inputSchema, {})).toThrow(
        UsageError,
      );
    });

    it('rejects an empty --name', () => {
      expect(() =>
        parseArgv(teamCreateCommand.inputSchema, { name: '' }),
      ).toThrow(/--name must not be empty/u);
    });

    it('rejects an empty --users', () => {
      expect(() =>
        parseArgv(teamCreateCommand.inputSchema, { name: 'X', users: '' }),
      ).toThrow(/--users must not be empty/u);
    });

    it('rejects unknown keys (strict schema)', () => {
      expect(() =>
        parseArgv(teamCreateCommand.inputSchema, {
          name: 'X',
          // @ts-expect-error — testing strict-mode rejection
          parent: '99',
        }),
      ).toThrow(UsageError);
    });
  });

  it('declares the canonical command name', () => {
    expect(teamCreateCommand.name).toBe('user.team-create');
  });

  it('declares idempotent: false (Monday allows duplicate names)', () => {
    expect(teamCreateCommand.idempotent).toBe(false);
  });
});

describe('teamDeleteCommand.inputSchema (M34 team-delete argv)', () => {
  it('accepts a numeric teamId', () => {
    const parsed = parseArgv(teamDeleteCommand.inputSchema, {
      teamId: '12345',
    });
    expect(parsed.teamId).toBe('12345');
  });

  it('rejects a non-numeric teamId', () => {
    expect(() =>
      parseArgv(teamDeleteCommand.inputSchema, { teamId: 'abc' }),
    ).toThrow(UsageError);
  });

  it('rejects a missing teamId', () => {
    expect(() =>
      parseArgv(teamDeleteCommand.inputSchema, {}),
    ).toThrow(UsageError);
  });

  it('rejects unknown keys (strict schema)', () => {
    expect(() =>
      parseArgv(teamDeleteCommand.inputSchema, {
        teamId: '12345',
        // @ts-expect-error — testing strict-mode rejection
        unknownFlag: 'oops',
      }),
    ).toThrow(UsageError);
  });

  it('declares the canonical command name', () => {
    expect(teamDeleteCommand.name).toBe('user.team-delete');
  });

  it('declares idempotent: false (re-deleting surfaces not_found)', () => {
    expect(teamDeleteCommand.idempotent).toBe(false);
  });
});

describe('teamAddMembersCommand.inputSchema (M34 team-add-members argv)', () => {
  it('accepts a numeric teamId + non-empty users string', () => {
    const parsed = parseArgv(teamAddMembersCommand.inputSchema, {
      teamId: '12345',
      users: '67890',
    });
    expect(parsed.teamId).toBe('12345');
    expect(parsed.users).toBe('67890');
  });

  it('accepts a numeric teamId + multi-user list', () => {
    const parsed = parseArgv(teamAddMembersCommand.inputSchema, {
      teamId: '12345',
      users: '67890,67891,67892',
    });
    expect(parsed.users).toBe('67890,67891,67892');
  });

  it('rejects a missing teamId', () => {
    expect(() =>
      parseArgv(teamAddMembersCommand.inputSchema, { users: '67890' }),
    ).toThrow(UsageError);
  });

  it('rejects a non-numeric teamId', () => {
    expect(() =>
      parseArgv(teamAddMembersCommand.inputSchema, {
        teamId: 'abc',
        users: '67890',
      }),
    ).toThrow(UsageError);
  });

  it('rejects a missing --users', () => {
    expect(() =>
      parseArgv(teamAddMembersCommand.inputSchema, { teamId: '12345' }),
    ).toThrow(UsageError);
  });

  it('rejects an empty --users', () => {
    expect(() =>
      parseArgv(teamAddMembersCommand.inputSchema, {
        teamId: '12345',
        users: '',
      }),
    ).toThrow(/--users must not be empty/u);
  });

  it('rejects unknown keys (strict schema)', () => {
    expect(() =>
      parseArgv(teamAddMembersCommand.inputSchema, {
        teamId: '12345',
        users: '67890',
        // @ts-expect-error — testing strict-mode rejection
        unknownFlag: 'oops',
      }),
    ).toThrow(UsageError);
  });

  it('declares the canonical command name', () => {
    expect(teamAddMembersCommand.name).toBe('user.team-add-members');
  });

  it('declares idempotent: true (re-add is no-op)', () => {
    expect(teamAddMembersCommand.idempotent).toBe(true);
  });
});

describe('teamRemoveMembersCommand.inputSchema (M34 team-remove-members argv)', () => {
  it('accepts a numeric teamId + non-empty users string', () => {
    const parsed = parseArgv(teamRemoveMembersCommand.inputSchema, {
      teamId: '12345',
      users: '67890',
    });
    expect(parsed.teamId).toBe('12345');
    expect(parsed.users).toBe('67890');
  });

  it('rejects a missing teamId', () => {
    expect(() =>
      parseArgv(teamRemoveMembersCommand.inputSchema, { users: '67890' }),
    ).toThrow(UsageError);
  });

  it('rejects a missing --users', () => {
    expect(() =>
      parseArgv(teamRemoveMembersCommand.inputSchema, { teamId: '12345' }),
    ).toThrow(UsageError);
  });

  it('rejects an empty --users', () => {
    expect(() =>
      parseArgv(teamRemoveMembersCommand.inputSchema, {
        teamId: '12345',
        users: '',
      }),
    ).toThrow(/--users must not be empty/u);
  });

  it('rejects unknown keys (strict schema)', () => {
    expect(() =>
      parseArgv(teamRemoveMembersCommand.inputSchema, {
        teamId: '12345',
        users: '67890',
        // @ts-expect-error — testing strict-mode rejection
        unknownFlag: 'oops',
      }),
    ).toThrow(UsageError);
  });

  it('declares the canonical command name', () => {
    expect(teamRemoveMembersCommand.name).toBe('user.team-remove-members');
  });

  it('declares idempotent: true (re-remove is no-op)', () => {
    expect(teamRemoveMembersCommand.idempotent).toBe(true);
  });
});

describe('team-* output schemas — partial-success envelope shape', () => {
  it('teamAddMembersCommand.outputSchema rejects operation drift', () => {
    expect(
      teamAddMembersCommand.outputSchema.safeParse({
        operation: 'remove_users_from_team',
        team_id: '12345',
        results: [],
      }).success,
    ).toBe(false);
  });

  it('teamRemoveMembersCommand.outputSchema rejects operation drift', () => {
    expect(
      teamRemoveMembersCommand.outputSchema.safeParse({
        operation: 'add_users_to_team',
        team_id: '12345',
        results: [],
      }).success,
    ).toBe(false);
  });

  it('teamAddMembersCommand.outputSchema accepts the canonical shape', () => {
    expect(
      teamAddMembersCommand.outputSchema.safeParse({
        operation: 'add_users_to_team',
        team_id: '12345',
        results: [
          { user_id: '67890', ok: true, user: { id: '67890', name: 'Ada', email: 'ada@example.test' } },
          { user_id: '67891', ok: false, error: { code: 'membership_failed', message: 'membership failed' } },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('teamWireSchema vs teamSchema — wire-vs-output split (M34 round-2 P2-1)', () => {
  // The wire-parse schema accepts a sparse users array (Monday
  // surfaces null entries when a member's User record was
  // tombstoned post-team-creation per round-1 fix prose); the
  // output schema rejects sparse entries because the projection
  // layer at IMPL filters nulls before the envelope emit, so an
  // agent reading `monday schema user.team-list` sees a clean
  // entries-non-null contract.
  const sparseUsersTeam = {
    id: '12345',
    name: 'Backend Eng',
    picture_url: null,
    is_guest: false,
    users: [
      { id: '67890', name: 'Ada', email: 'ada@example.test' },
      null,
      { id: '67891', name: 'Grace', email: 'grace@example.test' },
    ],
    owners: [{ id: '67890', name: 'Ada', email: 'ada@example.test' }],
  };

  it('teamWireSchema accepts a sparse users array', () => {
    expect(teamWireSchema.safeParse(sparseUsersTeam).success).toBe(true);
  });

  it('teamSchema rejects a sparse users array', () => {
    expect(teamSchema.safeParse(sparseUsersTeam).success).toBe(false);
  });

  it('teamWireSchema accepts a null users container', () => {
    expect(
      teamWireSchema.safeParse({
        ...sparseUsersTeam,
        users: null,
      }).success,
    ).toBe(true);
  });

  it('teamSchema accepts a null users container (the container nullability is shared)', () => {
    expect(
      teamSchema.safeParse({
        ...sparseUsersTeam,
        users: null,
      }).success,
    ).toBe(true);
  });

  it('both schemas accept a fully-populated team (no nulls)', () => {
    const populated = {
      ...sparseUsersTeam,
      users: [
        { id: '67890', name: 'Ada', email: 'ada@example.test' },
        { id: '67891', name: 'Grace', email: 'grace@example.test' },
      ],
    };
    expect(teamWireSchema.safeParse(populated).success).toBe(true);
    expect(teamSchema.safeParse(populated).success).toBe(true);
  });

  it('both schemas reject a missing required field', () => {
    const missingName = { ...sparseUsersTeam, name: undefined } as unknown;
    expect(teamWireSchema.safeParse(missingName).success).toBe(false);
    expect(teamSchema.safeParse(missingName).success).toBe(false);
  });
});

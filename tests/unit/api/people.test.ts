import { describe, expect, it, vi } from 'vitest';
import { ApiError, UsageError } from '../../../src/utils/errors.js';
import {
  parsePeopleInput,
  type ParsedPeopleInput,
  type PeopleResolutionContext,
} from '../../../src/api/people.js';

// Factory for a deterministic resolution context. Tests that don't
// care which callback fires can stub both with success values; tests
// that DO care override one and pin the other to a rejection so an
// accidental cross-call fires the test loudly.
const ctx = (
  overrides: Partial<PeopleResolutionContext> = {},
): PeopleResolutionContext => ({
  resolveMe: () => Promise.resolve('999'),
  resolveEmail: (email: string) => {
    // Default email→ID stub: hash by length so multiple emails
    // produce distinct IDs without per-test wiring. Tests that
    // need specific IDs override this.
    return Promise.resolve(String(100 + email.length));
  },
  ...overrides,
});

describe('parsePeopleInput — single token', () => {
  it('single email → one personsAndTeams entry with the resolved ID as a number', async () => {
    const out = await parsePeopleInput('alice@example.com', 'owner', {
      resolveMe: () => Promise.reject(new Error('should not be called')),
      resolveEmail: (email: string) => {
        expect(email).toBe('alice@example.com');
        return Promise.resolve('42');
      },
    });
    expect(out).toEqual<ParsedPeopleInput>({
      payload: {
        personsAndTeams: [{ id: 42, kind: 'person' }],
      },
    });
  });

  it('id field is a JS number, not a string (JSON scalar discipline)', async () => {
    // Anti-regression: it would be tempting to forward `userByEmail`'s
    // string id verbatim into the payload. JSON.stringify would then
    // serialise `"42"` (with quotes), which Monday's people column
    // rejects as validation_failed. Pin via typeof.
    const out = await parsePeopleInput('alice@example.com', 'owner', ctx({
      resolveEmail: () => Promise.resolve('42'),
    }));
    const entry = out.payload.personsAndTeams[0];
    if (entry === undefined) throw new Error('expected one entry');
    expect(typeof entry.id).toBe('number');
    expect(entry.id).toBe(42);
  });

  it('me token (lowercase) → resolveMe ID as a number', async () => {
    const out = await parsePeopleInput('me', 'owner', {
      resolveMe: () => Promise.resolve('7'),
      resolveEmail: () => Promise.reject(new Error('should not be called')),
    });
    expect(out.payload).toEqual({
      personsAndTeams: [{ id: 7, kind: 'person' }],
    });
  });

  it.each(['ME', 'Me', 'mE'])(
    'me token is case-insensitive (%s)',
    async (token) => {
      const out = await parsePeopleInput(token, 'owner', {
        resolveMe: () => Promise.resolve('7'),
        resolveEmail: () => Promise.reject(new Error('should not be called')),
      });
      expect(out.payload.personsAndTeams).toEqual([{ id: 7, kind: 'person' }]);
    },
  );

  it('me token surrounded by whitespace resolves the same way', async () => {
    const out = await parsePeopleInput('  me  ', 'owner', {
      resolveMe: () => Promise.resolve('7'),
      resolveEmail: () => Promise.reject(new Error('should not be called')),
    });
    expect(out.payload.personsAndTeams).toEqual([{ id: 7, kind: 'person' }]);
  });

  it('kind field is always the literal "person" (no team support in v0.1)', async () => {
    // cli-design.md §5.3 step 3 line 730 specifies `kind: "person"`
    // only. Teams are deferred to v0.2 per the spec gap log. Pin
    // the literal so a future widening of the union surfaces here.
    const out = await parsePeopleInput('alice@example.com', 'owner', ctx());
    const entry = out.payload.personsAndTeams[0];
    if (entry === undefined) throw new Error('expected one entry');
    expect(entry.kind).toBe('person');
  });
});

describe('parsePeopleInput — multiple tokens', () => {
  it('comma-split emails → ordered personsAndTeams list', async () => {
    const out = await parsePeopleInput(
      'alice@example.com,bob@example.com,carol@example.com',
      'owner',
      ctx({
        resolveEmail: (email: string) => {
          if (email === 'alice@example.com') return Promise.resolve('1');
          if (email === 'bob@example.com') return Promise.resolve('2');
          if (email === 'carol@example.com') return Promise.resolve('3');
          return Promise.reject(new Error(`unexpected: ${email}`));
        },
      }),
    );
    expect(out.payload.personsAndTeams).toEqual([
      { id: 1, kind: 'person' },
      { id: 2, kind: 'person' },
      { id: 3, kind: 'person' },
    ]);
  });

  it('mixed me + email → both resolve, ordered as input', async () => {
    const out = await parsePeopleInput('me,alice@example.com', 'owner', {
      resolveMe: () => Promise.resolve('7'),
      resolveEmail: (email: string) => {
        expect(email).toBe('alice@example.com');
        return Promise.resolve('42');
      },
    });
    expect(out.payload.personsAndTeams).toEqual([
      { id: 7, kind: 'person' },
      { id: 42, kind: 'person' },
    ]);
  });

  it('email,me ordering preserved (resolveMe fires when its slot comes up)', async () => {
    const out = await parsePeopleInput('alice@example.com,me', 'owner', {
      resolveMe: () => Promise.resolve('7'),
      resolveEmail: () => Promise.resolve('42'),
    });
    expect(out.payload.personsAndTeams).toEqual([
      { id: 42, kind: 'person' },
      { id: 7, kind: 'person' },
    ]);
  });

  it('trims whitespace around each segment', async () => {
    const out = await parsePeopleInput(
      ' alice@example.com , bob@example.com ',
      'owner',
      ctx({
        resolveEmail: (email: string) => {
          // Whitespace is stripped by the parser; resolveEmail
          // never sees it.
          expect(email.trim()).toBe(email);
          return Promise.resolve(email === 'alice@example.com' ? '1' : '2');
        },
      }),
    );
    expect(out.payload.personsAndTeams).toEqual([
      { id: 1, kind: 'person' },
      { id: 2, kind: 'person' },
    ]);
  });

  it('drops empty segments from a sloppy comma-list', async () => {
    // "alice@example.com,,bob@example.com" should still produce a
    // clean two-entry payload — one stray comma is a typo, not a
    // third unnamed person. Same shape as the dropdown branch.
    const out = await parsePeopleInput(
      'alice@example.com,,bob@example.com',
      'owner',
      ctx({
        resolveEmail: (email: string) =>
          Promise.resolve(email === 'alice@example.com' ? '1' : '2'),
      }),
    );
    expect(out.payload.personsAndTeams).toEqual([
      { id: 1, kind: 'person' },
      { id: 2, kind: 'person' },
    ]);
  });

  it('me appears multiple times → resolveMe fires once (caching)', async () => {
    // Mirrors filters.ts's resolveMe caching shape — one network
    // round-trip per build call regardless of how many `me` tokens
    // appear. Pinned so a future refactor that drops the cache
    // surfaces the regression as a 2x request count, not a wrong
    // answer.
    const resolveMe = vi.fn(() => Promise.resolve('7'));
    const out = await parsePeopleInput('me,me,me', 'owner', {
      resolveMe,
      resolveEmail: () => Promise.reject(new Error('should not be called')),
    });
    expect(resolveMe).toHaveBeenCalledTimes(1);
    expect(out.payload.personsAndTeams).toEqual([
      { id: 7, kind: 'person' },
      { id: 7, kind: 'person' },
      { id: 7, kind: 'person' },
    ]);
  });
});

describe('parsePeopleInput — empty / whitespace input', () => {
  it('empty string throws usage_error pointing at item clear', async () => {
    await expect(parsePeopleInput('', 'owner', ctx())).rejects.toThrow(UsageError);
    await expect(parsePeopleInput('', 'owner', ctx())).rejects.toThrow(
      /needs at least one email or the `me` token/u,
    );
    await expect(parsePeopleInput('', 'owner', ctx())).rejects.toThrow(
      /monday item clear <iid> owner/u,
    );
    try {
      await parsePeopleInput('', 'owner', ctx());
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.code).toBe('usage_error');
      expect(err.details).toMatchObject({
        column_id: 'owner',
        column_type: 'people',
        raw_input: '',
      });
    }
  });

  it('whitespace-only / commas-only input throws the same usage_error shape', async () => {
    const inputs = [' ', ' , ', ' , ,  ', ',,,,'];
    for (const input of inputs) {
      await expect(parsePeopleInput(input, 'owner', ctx())).rejects.toThrow(
        UsageError,
      );
      await expect(parsePeopleInput(input, 'owner', ctx())).rejects.toThrow(
        /needs at least one email or the `me` token/u,
      );
    }
  });

  it('empty-input hint uses placeholder <iid> since translator does not know the item ID', async () => {
    // Same template the dropdown branch uses (Codex pass-1 finding F2
    // on the status/dropdown commit). Pinned so a future "personalised
    // hint" refactor doesn't substitute something that looks like a
    // real ID.
    try {
      await parsePeopleInput('', 'owner', ctx());
      throw new Error('expected throw');
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.message).toContain('monday item clear <iid> owner');
      expect(err.message).toContain('[--board <bid>]');
    }
  });

  it('does not call resolveMe / resolveEmail when input is empty', async () => {
    const resolveMe = vi.fn(() => Promise.resolve('999'));
    const resolveEmail = vi.fn((email: string) => Promise.resolve(`${email}-id`));
    await expect(
      parsePeopleInput('', 'owner', { resolveMe, resolveEmail }),
    ).rejects.toThrow(UsageError);
    expect(resolveMe).not.toHaveBeenCalled();
    expect(resolveEmail).not.toHaveBeenCalled();
  });
});

describe('parsePeopleInput — numeric token rejection', () => {
  it('purely numeric token throws usage_error with a --set-raw hint', async () => {
    // cli-design.md §5.3 step 3 only lists emails + `me` for the
    // people grammar. Numeric tokens (`--set Owner=12345`) are
    // rejected because the column-type grammar is the contract;
    // agents who already have a user ID use --set-raw. Logged as
    // a spec gap in v0.1-plan.md §3 M5a.
    await expect(parsePeopleInput('12345', 'owner', ctx())).rejects.toThrow(
      UsageError,
    );
    await expect(parsePeopleInput('12345', 'owner', ctx())).rejects.toThrow(
      /numeric token "12345"/u,
    );
    try {
      await parsePeopleInput('12345', 'owner', ctx());
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.code).toBe('usage_error');
      expect(err.details).toMatchObject({
        column_id: 'owner',
        column_type: 'people',
        token: '12345',
        raw_input: '12345',
      });
      // Hint must point at the literal --set-raw shape with the
      // token interpolated so an agent can paste-and-edit.
      expect(err.details?.hint).toBe(
        `--set-raw owner='{"personsAndTeams":[{"id":12345,"kind":"person"}]}'`,
      );
    }
  });

  it('numeric token in a comma list rejects the whole call (not just the segment)', async () => {
    // Mixed input alice@example.com,12345 — translator could either
    // (a) reject the whole call, or (b) emit the email and skip the
    // numeric. Pinned (a): partial success would leave the agent
    // guessing which entries landed. The dropdown branch took the
    // same call (mixed-input → label path = whole-call shape).
    await expect(
      parsePeopleInput('alice@example.com,12345', 'owner', ctx()),
    ).rejects.toThrow(UsageError);
    await expect(
      parsePeopleInput('alice@example.com,12345', 'owner', ctx()),
    ).rejects.toThrow(/numeric token "12345"/u);
  });

  it('zero is still a numeric token (rejected — no special case)', async () => {
    await expect(parsePeopleInput('0', 'owner', ctx())).rejects.toThrow(
      /numeric token "0"/u,
    );
  });

  it('numeric token shape is digits-only — leading zeros are still numeric', async () => {
    await expect(parsePeopleInput('00042', 'owner', ctx())).rejects.toThrow(
      /numeric token "00042"/u,
    );
  });

  it('sign-prefixed numeric tokens fall through to the email path (resolveEmail handles)', async () => {
    // `+12345` is not a non-negative integer per the regex; falls
    // through to resolveEmail, which would normally throw
    // user_not_found. Pinned because the regex gating intent is
    // "all-digits → numeric path"; signed numerics being treated as
    // emails is a side-effect of the regex, but worth pinning so a
    // future refactor that widens to "numeric-shaped" doesn't
    // silently accept signed numbers.
    const resolveEmail = vi.fn((email: string) =>
      Promise.reject(
        new ApiError('user_not_found', `unknown email ${email}`, {
          details: { email },
        }),
      ),
    );
    await expect(
      parsePeopleInput('+12345', 'owner', { resolveMe: () => Promise.resolve('1'), resolveEmail }),
    ).rejects.toThrow(ApiError);
    expect(resolveEmail).toHaveBeenCalledWith('+12345');
  });
});

describe('parsePeopleInput — user_not_found bubbles from resolveEmail', () => {
  it('unknown email surfaces user_not_found verbatim (translator does not wrap)', async () => {
    // cli-design.md §5.3 step 3 line 733 says unknown email →
    // `error.code = "user_not_found"` with the unmatched email in
    // `details`. The translator forwards the resolveEmail callback's
    // error unchanged so the email-in-details echo (which userByEmail
    // already produces) is preserved.
    const err = new ApiError(
      'user_not_found',
      'No Monday user matches email "ghost@example.com"',
      { details: { email: 'ghost@example.com' } },
    );
    await expect(
      parsePeopleInput('ghost@example.com', 'owner', ctx({
        resolveEmail: () => Promise.reject(err),
      })),
    ).rejects.toBe(err);
  });

  it('first unknown email in a list short-circuits the whole resolution', async () => {
    // Mid-list failure: alice resolves, ghost throws. Translator
    // doesn't keep going — partial success would mis-represent
    // what landed at Monday (no ghost) vs what the agent typed
    // (alice + ghost). Pin the short-circuit so a future "best-
    // effort" refactor surfaces the regression.
    const resolveEmail = vi.fn((email: string) => {
      if (email === 'alice@example.com') return Promise.resolve('1');
      return Promise.reject(
        new ApiError('user_not_found', `unknown email ${email}`, {
          details: { email },
        }),
      );
    });
    await expect(
      parsePeopleInput(
        'alice@example.com,ghost@example.com,bob@example.com',
        'owner',
        { resolveMe: () => Promise.resolve('7'), resolveEmail },
      ),
    ).rejects.toThrow(ApiError);
    // alice resolved, ghost threw, bob was never asked — pin the
    // call count so the short-circuit is loud.
    expect(resolveEmail).toHaveBeenCalledTimes(2);
    expect(resolveEmail).toHaveBeenCalledWith('alice@example.com');
    expect(resolveEmail).toHaveBeenCalledWith('ghost@example.com');
  });
});

describe('parsePeopleInput — safe-integer guard on resolved IDs', () => {
  // Defensive: Monday's user IDs are auto-incremented integers well
  // below 2^53. If a future schema change widens the range, the
  // translator would silently round through Number() and corrupt
  // the wire payload. Pin via test that unsafe IDs throw
  // usage_error (same template as the status / dropdown safe-
  // integer guards).

  it('resolved ID > Number.MAX_SAFE_INTEGER throws usage_error', async () => {
    const huge = '9'.repeat(20); // 20-digit string well past 2^53
    await expect(
      parsePeopleInput('alice@example.com', 'owner', ctx({
        resolveEmail: () => Promise.resolve(huge),
      })),
    ).rejects.toThrow(UsageError);
    await expect(
      parsePeopleInput('alice@example.com', 'owner', ctx({
        resolveEmail: () => Promise.resolve(huge),
      })),
    ).rejects.toThrow(/exceeds JavaScript's safe-integer range/u);
    try {
      await parsePeopleInput('alice@example.com', 'owner', ctx({
        resolveEmail: () => Promise.resolve(huge),
      }));
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.code).toBe('usage_error');
      expect(err.details).toMatchObject({
        column_id: 'owner',
        column_type: 'people',
        token: 'alice@example.com',
        resolved_id: huge,
      });
      expect(err.details?.hint).toContain('--set-raw');
      expect(err.details?.hint).toContain(huge);
    }
  });

  it('resolved ID at MAX_SAFE_INTEGER boundary still works', async () => {
    const max = String(Number.MAX_SAFE_INTEGER);
    const out = await parsePeopleInput('alice@example.com', 'owner', ctx({
      resolveEmail: () => Promise.resolve(max),
    }));
    expect(out.payload.personsAndTeams).toEqual([
      { id: Number.MAX_SAFE_INTEGER, kind: 'person' },
    ]);
  });

  it('resolved me ID > Number.MAX_SAFE_INTEGER also throws (same path)', async () => {
    const huge = '9'.repeat(20);
    await expect(
      parsePeopleInput('me', 'owner', {
        resolveMe: () => Promise.resolve(huge),
        resolveEmail: () => Promise.reject(new Error('should not be called')),
      }),
    ).rejects.toThrow(/exceeds JavaScript's safe-integer range/u);
  });
});

describe('parsePeopleInput — defensive resolver-side ID validation', () => {
  // Codex review pass-1 finding F2. `Number()` alone accepts hex
  // ("0x2a" → 42), scientific notation ("1e3" → 1000), empty
  // strings ("" → 0), and signed forms ("-1" → -1) — none of
  // which are valid Monday user IDs but all of which would
  // silently land at Monday as the wrong number. The translator
  // defends its own boundary because `userByEmail`'s schema is
  // loose (z.string().min(1)). Pin per malformed shape so a
  // future refactor that drops the regex check fires.

  it.each([
    ['hex-prefixed', '0x2a'],
    ['scientific notation', '1e3'],
    ['signed negative', '-1'],
    ['signed positive', '+1'],
    ['decimal', '1.5'],
    ['leading zeros', '00042'],
    ['empty string', ''],
    ['whitespace only', '  '],
    ['trailing whitespace', '42 '],
    ['internal whitespace', '4 2'],
    ['letter-mixed', '42abc'],
  ])('rejects malformed resolved ID (%s: %j) → internal_error', async (_label, malformedId) => {
    await expect(
      parsePeopleInput('alice@example.com', 'owner', ctx({
        resolveEmail: () => Promise.resolve(malformedId),
      })),
    ).rejects.toThrow(ApiError);
    try {
      await parsePeopleInput('alice@example.com', 'owner', ctx({
        resolveEmail: () => Promise.resolve(malformedId),
      }));
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('internal_error');
      // Pin retryable=false so a future "retryable" override doesn't
      // make agents think retrying will heal a directory data-
      // integrity issue. internal_error's CODE_RETRYABLE_DEFAULT is
      // false; this assertion is cheap defence. Codex pass-2 finding.
      expect(err.retryable).toBe(false);
      expect(err.message).toMatch(/non-decimal user ID/u);
      expect(err.details).toMatchObject({
        column_id: 'owner',
        column_type: 'people',
        token: 'alice@example.com',
        resolved_id: malformedId,
      });
    }
  });

  it('rejects malformed me-resolved ID with the same shape', async () => {
    // Same template; the me path goes through the same idStringToNumber
    // helper. Pin so a future refactor that splits the validation
    // between paths surfaces.
    await expect(
      parsePeopleInput('me', 'owner', {
        resolveMe: () => Promise.resolve('1e3'),
        resolveEmail: () => Promise.reject(new Error('should not be called')),
      }),
    ).rejects.toThrow(/non-decimal user ID/u);
  });

  it('accepts valid decimal IDs (0, 1, 42, MAX_SAFE_INTEGER)', async () => {
    // Pin both sides of the boundary: the strict regex still
    // accepts the legitimate cases. "0" is a valid Monday user
    // ID for the system-user slot (rare but real); pin so a
    // future "non-zero only" refactor surfaces.
    for (const id of ['0', '1', '42', String(Number.MAX_SAFE_INTEGER)]) {
      const out = await parsePeopleInput('alice@example.com', 'owner', ctx({
        resolveEmail: () => Promise.resolve(id),
      }));
      expect(out.payload.personsAndTeams[0]?.id).toBe(Number(id));
    }
  });
});

describe('parsePeopleInput — JSON scalar discipline', () => {
  it('payload is a plain JS object, not a JSON-encoded string', async () => {
    // Anti-regression: future contributor might JSON.stringify the
    // payload "for the wire". graphql-request already stringifies
    // at the boundary; double-stringifying would round-trip as the
    // literal string `'{"personsAndTeams":[{"id":42,"kind":"person"}]}'`.
    const out = await parsePeopleInput('alice@example.com', 'owner', ctx({
      resolveEmail: () => Promise.resolve('42'),
    }));
    expect(typeof out.payload).toBe('object');
    expect(out.payload).not.toBeInstanceOf(String);
    expect(typeof out.payload.personsAndTeams).toBe('object');
    expect(Array.isArray(out.payload.personsAndTeams)).toBe(true);
    const entry = out.payload.personsAndTeams[0];
    if (entry === undefined) throw new Error('expected one entry');
    expect(typeof entry).toBe('object');
    // Plain primitives — id is a number, kind is the literal
    // 'person' string. JSON.stringify produces the right wire shape.
    expect(JSON.stringify(out.payload)).toBe(
      '{"personsAndTeams":[{"id":42,"kind":"person"}]}',
    );
  });
});

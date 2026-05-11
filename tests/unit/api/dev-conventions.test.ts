/**
 * Surface tests for `src/api/dev-conventions.ts` — the v0.3-M26a
 * IMPL runtime bodies for the `dev` namespace (cli-design §5.9 +
 * §11.3 + v0.3-plan §3 M26).
 *
 * Scope: schemas + types + the four pure helpers
 * (`matchBoardByConvention`, `groupCandidatesByDevNoun`,
 * `buildDiscoverMappingFromMatches`, plus the doctor's per-check
 * helpers indirectly via `runDevDoctor`) + the four runtime
 * fetchers (`discoverDevBoards`, `runDevDoctor`, `loadDevMapping`,
 * `saveDevMapping`).
 *
 * Network mocks: seam-injected `MondayClient` stub matching the
 * board-favorites test pattern (mock-at-the-network-boundary per
 * testing.md — only the typed `raw` surface is stubbed). File-
 * system tests use `mkdtemp(tmpdir())` per the existing
 * credentials/profiles test pattern.
 */
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEV_DOCTOR_CHECK_NAMES,
  DEV_NOUN_PATTERNS,
  buildDiscoverMappingFromMatches,
  devConfigureOutputSchema,
  devDiscoverOutputSchema,
  devDoctorOutputSchema,
  devMappingSchema,
  discoverBoardCandidateSchema,
  discoverDevBoards,
  groupCandidatesByDevNoun,
  loadDevMapping,
  matchBoardByConvention,
  runDevDoctor,
  saveDevMapping,
  type DevDoctorCheckResult,
  type DevMapping,
  type DiscoverBoardCandidate,
} from '../../../src/api/dev-conventions.js';
import { ApiError, ConfigError } from '../../../src/utils/errors.js';
import type {
  MondayClient,
  MondayResponse,
} from '../../../src/api/client.js';

const candidate = (
  id: string,
  name: string,
  workspace_id: string | null = '6269142',
): DiscoverBoardCandidate => ({ id, name, workspace_id });

describe('DEV_NOUN_PATTERNS', () => {
  it('pins 5 dev-noun slots in canonical order', () => {
    expect(DEV_NOUN_PATTERNS.map((p) => p.noun)).toEqual([
      'tasks_board',
      'sprints_board',
      'epics_board',
      'releases_board',
      'bugs_board',
    ]);
  });

  it('every slot has at least one pattern', () => {
    for (const { patterns } of DEV_NOUN_PATTERNS) {
      expect(patterns.length).toBeGreaterThan(0);
    }
  });
});

describe('DEV_DOCTOR_CHECK_NAMES', () => {
  it('pins 10 check names post round-1 + round-2 Codex fix-ups', () => {
    expect(DEV_DOCTOR_CHECK_NAMES.length).toBe(10);
  });

  it('includes the renamed sprints_date_columns_present (round-1 P1-1)', () => {
    expect(DEV_DOCTOR_CHECK_NAMES).toContain('sprints_date_columns_present');
    expect(DEV_DOCTOR_CHECK_NAMES).not.toContain('sprints_state_column_present');
  });

  it('includes bugs_board_exists (round-1 P2-2)', () => {
    expect(DEV_DOCTOR_CHECK_NAMES).toContain('bugs_board_exists');
  });

  it('includes tasks_to_epics_relation (round-2 P2-3 replacement)', () => {
    expect(DEV_DOCTOR_CHECK_NAMES).toContain('tasks_to_epics_relation');
    expect(DEV_DOCTOR_CHECK_NAMES).not.toContain('epics_to_releases_relation');
  });
});

describe('matchBoardByConvention', () => {
  it('exact-matches the stock English noun', () => {
    expect(matchBoardByConvention(candidate('1', 'Tasks'), ['tasks', 'task'])).toBe(true);
  });

  it('substring-matches with extra suffix ("Bugs Queue")', () => {
    expect(matchBoardByConvention(candidate('1', 'Bugs Queue'), ['bugs', 'bug'])).toBe(true);
  });

  it('is case-insensitive (lowercase pattern, uppercase name)', () => {
    expect(matchBoardByConvention(candidate('1', 'TASKS'), ['tasks'])).toBe(true);
  });

  it('handles Unicode NFC normalisation', () => {
    // 'Épics' as a decomposed sequence vs a composed sequence — the
    // NFC normalisation collapses both to the same form.
    const decomposed = 'Épics'; // E + combining acute
    expect(matchBoardByConvention(candidate('1', decomposed), ['épics'])).toBe(true);
  });

  it('collapses internal whitespace', () => {
    expect(matchBoardByConvention(candidate('1', 'Tasks   Backlog'), ['tasks backlog'])).toBe(true);
  });

  it('returns false on unrelated name', () => {
    expect(matchBoardByConvention(candidate('1', 'Marketing'), ['tasks'])).toBe(false);
  });

  it('returns false on empty patterns', () => {
    expect(matchBoardByConvention(candidate('1', 'Tasks'), [])).toBe(false);
  });
});

describe('groupCandidatesByDevNoun', () => {
  it('groups one-match-per-noun', () => {
    const result = groupCandidatesByDevNoun([
      candidate('1', 'Tasks'),
      candidate('2', 'Sprints'),
      candidate('3', 'Epics'),
      candidate('4', 'Releases'),
      candidate('5', 'Bugs'),
    ]);
    expect(result.map((r) => r.noun)).toEqual([
      'tasks_board',
      'sprints_board',
      'epics_board',
      'releases_board',
      'bugs_board',
    ]);
    for (const r of result) {
      expect(r.matched.length).toBe(1);
    }
  });

  it('surfaces ambiguity (substring match across two boards)', () => {
    const result = groupCandidatesByDevNoun([
      candidate('1', 'Tasks'),
      candidate('2', 'Subitems of Tasks'),
    ]);
    const tasksGroup = result.find((r) => r.noun === 'tasks_board');
    expect(tasksGroup?.matched.length).toBe(2);
  });

  it('surfaces zero-match for nouns without a match', () => {
    const result = groupCandidatesByDevNoun([candidate('1', 'Tasks')]);
    const sprintsGroup = result.find((r) => r.noun === 'sprints_board');
    expect(sprintsGroup?.matched).toEqual([]);
  });

  it('returns 5 entries always (one per noun)', () => {
    expect(groupCandidatesByDevNoun([]).length).toBe(5);
  });
});

describe('buildDiscoverMappingFromMatches', () => {
  it('maps slots with exactly one match', () => {
    const result = buildDiscoverMappingFromMatches([
      { noun: 'tasks_board', matched: [candidate('100', 'Tasks')] },
      { noun: 'sprints_board', matched: [] },
      { noun: 'epics_board', matched: [candidate('300', 'Epics')] },
      { noun: 'releases_board', matched: [] },
      { noun: 'bugs_board', matched: [] },
    ]);
    expect(result).toEqual({
      tasks_board: '100',
      epics_board: '300',
    });
  });

  it('skips ambiguous slots (>1 match)', () => {
    const result = buildDiscoverMappingFromMatches([
      {
        noun: 'tasks_board',
        matched: [candidate('100', 'Tasks'), candidate('101', 'Subitems of Tasks')],
      },
    ]);
    expect(result.tasks_board).toBeUndefined();
  });

  it('returns empty mapping when no slots resolve', () => {
    expect(buildDiscoverMappingFromMatches([])).toEqual({});
  });
});

describe('schemas + types', () => {
  it('devMappingSchema accepts all 5 dev-noun slots as optional strings', () => {
    expect(() =>
      devMappingSchema.parse({
        tasks_board: '100',
        sprints_board: '200',
        epics_board: '300',
        releases_board: '400',
        bugs_board: '500',
      }),
    ).not.toThrow();
  });

  it('devMappingSchema rejects empty-string slots', () => {
    expect(() => devMappingSchema.parse({ tasks_board: '' })).toThrow();
  });

  it('devMappingSchema rejects unknown keys (strict)', () => {
    expect(() =>
      devMappingSchema.parse({ tasks_board: '100', unknown_slot: '999' }),
    ).toThrow();
  });

  it('discoverBoardCandidateSchema accepts a fully-populated candidate', () => {
    expect(() =>
      discoverBoardCandidateSchema.parse({
        id: '1',
        name: 'Tasks',
        workspace_id: '50',
      }),
    ).not.toThrow();
  });

  it('discoverBoardCandidateSchema accepts null workspace_id', () => {
    expect(() =>
      discoverBoardCandidateSchema.parse({
        id: '1',
        name: 'Tasks',
        workspace_id: null,
      }),
    ).not.toThrow();
  });

  it('devDiscoverOutputSchema requires profile + mapping + matches + applied', () => {
    expect(() =>
      devDiscoverOutputSchema.parse({
        profile: 'work',
        mapping: {},
        matches: [],
        applied: false,
      }),
    ).not.toThrow();
  });

  it('devConfigureOutputSchema requires profile + mapping', () => {
    expect(() =>
      devConfigureOutputSchema.parse({ profile: 'work', mapping: {} }),
    ).not.toThrow();
  });

  it('devDoctorOutputSchema parses a complete envelope', () => {
    expect(() =>
      devDoctorOutputSchema.parse({
        profile: 'work',
        mapping: {},
        checks: [],
        summary: { ok_count: 0, warn_count: 0, fail_count: 0 },
      }),
    ).not.toThrow();
  });
});

/**
 * Builds a seam-injected `MondayClient` stub for the resolver tests.
 * Mock-at-the-network-boundary per testing.md: only `raw` is
 * stubbed (the typed surface the runtime bodies consume).
 *
 * Mirrors `tests/unit/api/board-favorites.test.ts:buildClientStub`
 * but adds operation-name-based per-call sequencing — the discover
 * walker calls the same operationName N times with incrementing
 * page numbers, so each entry can be a single response or an
 * array of responses to drain via FIFO.
 */
const buildClientStub = (
  responses: Readonly<Record<string, MondayResponse<unknown> | MondayResponse<unknown>[]>>,
): { client: MondayClient; raw: ReturnType<typeof vi.fn> } => {
  const queues: Record<string, MondayResponse<unknown>[]> = {};
  for (const [opName, value] of Object.entries(responses)) {
    queues[opName] = Array.isArray(value) ? [...value] : [value];
  }
  const raw = vi.fn(
    (
      _query: string,
      _variables: Readonly<Record<string, unknown>> | undefined,
      options: { operationName?: string } = {},
    ): Promise<MondayResponse<unknown>> => {
      const opName = options.operationName ?? '<anon>';
      const queue = queues[opName];
      if (queue === undefined || queue.length === 0) {
        return Promise.reject(
          new Error(`buildClientStub: no canned response for ${opName}`),
        );
      }
      const last = queue.length === 1 ? queue[0] : queue.shift();
      if (queue.length === 0 && queues[opName] !== undefined) {
        // Drain to a single repeating response if only one was given;
        // otherwise pop to FIFO-empty so a "too many calls" surfaces.
      }
      return Promise.resolve(last!);
    },
  );
  const client = { raw } as unknown as MondayClient;
  return { client, raw };
};

const fakeStats = (): { attempts: number; sleeps: number[] } => ({
  attempts: 1,
  sleeps: [],
});

describe('discoverDevBoards', () => {
  it('walks one page when results fit under the page limit', async () => {
    const { client, raw } = buildClientStub({
      DevDiscoverBoards: {
        data: {
          boards: [
            { id: '100', name: 'Tasks', workspace_id: '50', type: 'board' },
            { id: '200', name: 'Sprints', workspace_id: '50', type: 'board' },
          ],
        },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await discoverDevBoards({ client });
    expect(result.candidates.map((c) => c.id)).toEqual(['100', '200']);
    expect(result.matches.length).toBe(5);
    expect(result.source).toBe('live');
    expect(result.cacheAgeSeconds).toBe(null);
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('drops Board.type !== "board" entries (sub_items_board virtual)', async () => {
    const { client } = buildClientStub({
      DevDiscoverBoards: {
        data: {
          boards: [
            { id: '100', name: 'Tasks', workspace_id: '50', type: 'board' },
            {
              id: '101',
              name: 'Subitems of Tasks',
              workspace_id: '50',
              type: 'sub_items_board',
            },
            { id: '102', name: 'Tasks Custom Object', workspace_id: '50', type: 'custom_object' },
            { id: '103', name: 'Tasks Document', workspace_id: '50', type: 'document' },
          ],
        },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await discoverDevBoards({ client });
    // Only the real `type: 'board'` row survives.
    expect(result.candidates.map((c) => c.id)).toEqual(['100']);
  });

  it('drops null rows (defensive against Monday returning null entries)', async () => {
    const { client } = buildClientStub({
      DevDiscoverBoards: {
        data: {
          boards: [
            null,
            { id: '100', name: 'Tasks', workspace_id: '50', type: 'board' },
            null,
          ],
        },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await discoverDevBoards({ client });
    expect(result.candidates.map((c) => c.id)).toEqual(['100']);
  });

  it('paginates: walks multiple pages until a short page indicates end', async () => {
    // Page 1: 200 boards (full page) → walker continues to page 2.
    // Page 2: 10 boards (short page) → walker stops.
    const fullPage = Array.from({ length: 200 }, (_, i) => ({
      id: String(1000 + i),
      name: `Board ${String(i)}`,
      workspace_id: '50',
      type: 'board',
    }));
    const shortPage = [
      { id: '9001', name: 'Tasks', workspace_id: '50', type: 'board' },
    ];
    const { client, raw } = buildClientStub({
      DevDiscoverBoards: [
        { data: { boards: fullPage }, complexity: null, stats: fakeStats() },
        { data: { boards: shortPage }, complexity: null, stats: fakeStats() },
      ],
    });
    const result = await discoverDevBoards({ client });
    expect(result.candidates.length).toBe(201);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it('scopes via workspace_ids when workspaceId is set', async () => {
    const { client, raw } = buildClientStub({
      DevDiscoverBoardsScoped: {
        data: {
          boards: [
            { id: '100', name: 'Tasks', workspace_id: '50', type: 'board' },
          ],
        },
        complexity: null,
        stats: fakeStats(),
      },
    });
    await discoverDevBoards({ client, workspaceId: '50' });
    expect(raw).toHaveBeenCalledTimes(1);
    expect(raw.mock.calls[0]?.[1]).toEqual({
      limit: 200,
      page: 1,
      wsids: ['50'],
    });
    expect(raw.mock.calls[0]?.[2]).toEqual({
      operationName: 'DevDiscoverBoardsScoped',
    });
  });

  it('captures the last page complexity', async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) => ({
      id: String(1000 + i),
      name: `B${String(i)}`,
      workspace_id: '50',
      type: 'board',
    }));
    const lastComplexity = { before: 100, after: 90, query: 10, reset_in_x_seconds: 60 };
    const { client } = buildClientStub({
      DevDiscoverBoards: [
        { data: { boards: fullPage }, complexity: { before: 200, after: 150, query: 50, reset_in_x_seconds: 60 }, stats: fakeStats() },
        { data: { boards: [] }, complexity: lastComplexity, stats: fakeStats() },
      ],
    });
    const result = await discoverDevBoards({ client });
    expect(result.complexity).toEqual(lastComplexity);
  });

  it('rejects with internal_error on schema mismatch', async () => {
    const { client } = buildClientStub({
      DevDiscoverBoards: {
        data: { boards: 'not-an-array' },
        complexity: null,
        stats: fakeStats(),
      },
    });
    await expect(discoverDevBoards({ client })).rejects.toBeInstanceOf(ApiError);
  });

  it('treats null boards as empty', async () => {
    const { client } = buildClientStub({
      DevDiscoverBoards: {
        data: { boards: null },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await discoverDevBoards({ client });
    expect(result.candidates).toEqual([]);
  });
});

describe('loadDevMapping + saveDevMapping (filesystem)', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'monday-cli-dev-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('loadDevMapping throws dev_not_configured (no_config_file) when no config.toml exists', async () => {
    await expect(loadDevMapping('work', { home })).rejects.toMatchObject({
      code: 'dev_not_configured',
      details: { reason: 'no_config_file' },
    });
  });

  it('loadDevMapping throws dev_not_configured (profile_absent) when profile is missing', async () => {
    const path = join(home, '.monday-cli', 'config.toml');
    await mkdtempThenWrite(home, path, '[profiles.other]\napi_token_env = "X"\n');
    await expect(loadDevMapping('work', { home })).rejects.toMatchObject({
      code: 'dev_not_configured',
      details: { reason: 'profile_absent' },
    });
  });

  it('loadDevMapping throws dev_not_configured (no_dev_block) when profile has no dev sub-block', async () => {
    const path = join(home, '.monday-cli', 'config.toml');
    await mkdtempThenWrite(home, path, '[profiles.work]\napi_token_env = "X"\n');
    await expect(loadDevMapping('work', { home })).rejects.toMatchObject({
      code: 'dev_not_configured',
      details: { reason: 'no_dev_block' },
    });
  });

  it('loadDevMapping returns the dev block when present', async () => {
    const path = join(home, '.monday-cli', 'config.toml');
    await mkdtempThenWrite(
      home,
      path,
      '[profiles.work.dev]\ntasks_board = "987"\nepics_board = "654"\n',
    );
    const mapping = await loadDevMapping('work', { home });
    expect(mapping).toEqual({ tasks_board: '987', epics_board: '654' });
  });

  it('saveDevMapping creates config.toml with mode 0600 (first-write)', async () => {
    await saveDevMapping('work', { tasks_board: '987' }, { home });
    const path = join(home, '.monday-cli', 'config.toml');
    const stats = await stat(path);
    expect(stats.mode & 0o777).toBe(0o600);
    const content = await readFile(path, 'utf8');
    expect(content).toContain('tasks_board');
    expect(content).toContain('987');
  });

  it('saveDevMapping creates parent directory with mode 0700', async () => {
    await saveDevMapping('work', { tasks_board: '987' }, { home });
    const dir = join(home, '.monday-cli');
    const stats = await stat(dir);
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it('saveDevMapping is idempotent (round-trip preserves the mapping)', async () => {
    const mapping: DevMapping = {
      tasks_board: '100',
      sprints_board: '200',
      epics_board: '300',
    };
    await saveDevMapping('work', mapping, { home });
    const read = await loadDevMapping('work', { home });
    expect(read).toEqual(mapping);
  });

  it('saveDevMapping preserves non-dev profile fields (additive merge)', async () => {
    const path = join(home, '.monday-cli', 'config.toml');
    await mkdtempThenWrite(
      home,
      path,
      '[profiles.work]\napi_token_env = "MONDAY_API_TOKEN_WORK"\napi_version = "2026-01"\n',
    );
    await saveDevMapping('work', { tasks_board: '987' }, { home });
    const content = await readFile(path, 'utf8');
    expect(content).toContain('api_token_env');
    expect(content).toContain('MONDAY_API_TOKEN_WORK');
    expect(content).toContain('api_version');
    expect(content).toContain('tasks_board');
  });

  it('saveDevMapping preserves OTHER profiles in the config', async () => {
    const path = join(home, '.monday-cli', 'config.toml');
    await mkdtempThenWrite(
      home,
      path,
      '[profiles.personal]\napi_token_env = "PERSONAL_TOKEN"\n\n[profiles.work]\napi_token_env = "WORK_TOKEN"\n',
    );
    await saveDevMapping('work', { tasks_board: '987' }, { home });
    const content = await readFile(path, 'utf8');
    expect(content).toContain('personal');
    expect(content).toContain('PERSONAL_TOKEN');
    expect(content).toContain('WORK_TOKEN');
  });

  it('saveDevMapping replaces existing dev block on re-write', async () => {
    await saveDevMapping('work', { tasks_board: '100' }, { home });
    await saveDevMapping('work', { tasks_board: '200', sprints_board: '300' }, { home });
    const mapping = await loadDevMapping('work', { home });
    expect(mapping).toEqual({ tasks_board: '200', sprints_board: '300' });
  });

  it('saveDevMapping rejects unknown slots via the schema re-validation', async () => {
    await expect(
      saveDevMapping(
        'work',
        { tasks_board: '100', unknown_slot: '999' } as unknown as DevMapping,
        { home },
      ),
    ).rejects.toThrow();
  });
});

const mkdtempThenWrite = async (
  home: string,
  path: string,
  content: string,
): Promise<void> => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(home, '.monday-cli'), { recursive: true, mode: 0o700 });
  await writeFile(path, content);
  // Don't chmod here — the read path doesn't check file mode on
  // config.toml (only credentials.json), so the test can leave the
  // default umask mode. Saving Mod=0o600 is the WRITE path; reading
  // accepts any mode.
  void path;
};
void chmod;

describe('runDevDoctor', () => {
  const mappingAllSlots: DevMapping = {
    tasks_board: '100',
    sprints_board: '200',
    epics_board: '300',
    releases_board: '400',
    bugs_board: '500',
  };

  const fullyHealthyBoards = [
    {
      id: '100',
      name: 'Tasks',
      state: 'active',
      columns: [
        {
          id: 'status',
          title: 'Status',
          type: 'status',
          settings_str: JSON.stringify({
            labels: { '0': 'Working on it', '1': 'Done', '2': 'Stuck' },
          }),
        },
        {
          id: 'rel_sprints',
          title: 'Sprint',
          type: 'board_relation',
          settings_str: JSON.stringify({ boardIds: ['200'] }),
        },
        {
          id: 'rel_epics',
          title: 'Epic',
          type: 'board_relation',
          settings_str: JSON.stringify({ boardIds: ['300'] }),
        },
      ],
    },
    {
      id: '200',
      name: 'Sprints',
      state: 'active',
      columns: [
        {
          id: 'timeline',
          title: 'Sprint Range',
          type: 'timeline',
          settings_str: null,
        },
      ],
    },
    { id: '300', name: 'Epics', state: 'active', columns: [] },
    { id: '400', name: 'Releases', state: 'active', columns: [] },
    { id: '500', name: 'Bugs', state: 'active', columns: [] },
  ];

  it('returns one result per check name (10 total)', async () => {
    const { client } = buildClientStub({
      DevDoctorBoards: {
        data: { boards: fullyHealthyBoards },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: mappingAllSlots,
    });
    expect(result.checks.length).toBe(10);
    expect(result.checks.map((c) => c.name)).toEqual([...DEV_DOCTOR_CHECK_NAMES]);
  });

  it('passes every check when mapping is fully healthy', async () => {
    const { client } = buildClientStub({
      DevDoctorBoards: {
        data: { boards: fullyHealthyBoards },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: mappingAllSlots,
    });
    expect(result.summary.fail_count).toBe(0);
    expect(result.summary.warn_count).toBe(0);
    expect(result.summary.ok_count).toBe(10);
  });

  it('fails *_board_exists when slot not in mapping', async () => {
    const { client } = buildClientStub({
      DevDoctorBoards: {
        data: { boards: [] },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: {},
    });
    const exists = result.checks.filter((c) => c.name.endsWith('_board_exists'));
    for (const c of exists) {
      expect(c.status).toBe('fail');
      expect(c.details).toMatchObject({ reason: 'not_in_mapping' });
    }
  });

  it('warns *_board_exists when board is archived', async () => {
    const { client } = buildClientStub({
      DevDoctorBoards: {
        data: {
          boards: [
            { id: '100', name: 'Tasks', state: 'archived', columns: [] },
          ],
        },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: { tasks_board: '100' },
    });
    const check = result.checks.find((c) => c.name === 'tasks_board_exists');
    expect(check?.status).toBe('warn');
    expect(check?.details).toMatchObject({ state: 'archived' });
  });

  it('fails *_board_exists when board is in state "deleted"', async () => {
    const { client } = buildClientStub({
      DevDoctorBoards: {
        data: {
          boards: [
            { id: '100', name: 'Tasks', state: 'deleted', columns: [] },
          ],
        },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: { tasks_board: '100' },
    });
    const check = result.checks.find((c) => c.name === 'tasks_board_exists');
    expect(check?.status).toBe('fail');
    expect(check?.details).toMatchObject({ reason: 'board_deleted' });
  });

  it('fails *_board_exists when board ID is inaccessible (silently omitted by Monday)', async () => {
    const { client } = buildClientStub({
      DevDoctorBoards: {
        data: { boards: [] },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: { tasks_board: '999' },
    });
    const check = result.checks.find((c) => c.name === 'tasks_board_exists');
    expect(check?.status).toBe('fail');
    expect(check?.details).toMatchObject({ reason: 'not_accessible' });
  });

  it('fails tasks_status_column_present when no status-shaped column', async () => {
    const { client } = buildClientStub({
      DevDoctorBoards: {
        data: {
          boards: [
            { id: '100', name: 'Tasks', state: 'active', columns: [
              { id: 't', title: 'Text', type: 'text', settings_str: null },
            ] },
          ],
        },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: { tasks_board: '100' },
    });
    const check = result.checks.find((c) => c.name === 'tasks_status_column_present');
    expect(check?.status).toBe('fail');
    expect(check?.details).toMatchObject({ reason: 'no_status_column' });
  });

  it('accepts "color" column type as a status-shaped column', async () => {
    const { client } = buildClientStub({
      DevDoctorBoards: {
        data: {
          boards: [
            { id: '100', name: 'Tasks', state: 'active', columns: [
              {
                id: 'status_color',
                title: 'Status',
                type: 'color',
                settings_str: JSON.stringify({ labels: { '0': 'Done', '1': 'Working on it', '2': 'Stuck' } }),
              },
            ] },
          ],
        },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: { tasks_board: '100' },
    });
    expect(result.checks.find((c) => c.name === 'tasks_status_column_present')?.status).toBe('ok');
  });

  it('warns tasks_status_labels_canonical when canonical labels are missing', async () => {
    const { client } = buildClientStub({
      DevDoctorBoards: {
        data: {
          boards: [
            { id: '100', name: 'Tasks', state: 'active', columns: [
              {
                id: 'status',
                title: 'Status',
                type: 'status',
                settings_str: JSON.stringify({ labels: { '0': 'Todo', '1': 'Doing' } }),
              },
            ] },
          ],
        },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: { tasks_board: '100' },
    });
    const check = result.checks.find((c) => c.name === 'tasks_status_labels_canonical');
    expect(check?.status).toBe('warn');
    expect(check?.details).toMatchObject({
      missing_labels: expect.arrayContaining(['Done']) as readonly string[],
    });
  });

  it('warns tasks_status_labels_canonical on unparseable settings_str', async () => {
    const { client } = buildClientStub({
      DevDoctorBoards: {
        data: {
          boards: [
            { id: '100', name: 'Tasks', state: 'active', columns: [
              { id: 'status', title: 'Status', type: 'status', settings_str: 'not-json' },
            ] },
          ],
        },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: { tasks_board: '100' },
    });
    const check = result.checks.find((c) => c.name === 'tasks_status_labels_canonical');
    expect(check?.status).toBe('warn');
    expect(check?.details).toMatchObject({ reason: 'settings_unparseable' });
  });

  it('fails sprints_date_columns_present when no date-range columns', async () => {
    const { client } = buildClientStub({
      DevDoctorBoards: {
        data: {
          boards: [
            { id: '200', name: 'Sprints', state: 'active', columns: [] },
          ],
        },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: { sprints_board: '200' },
    });
    const check = result.checks.find((c) => c.name === 'sprints_date_columns_present');
    expect(check?.status).toBe('fail');
    expect(check?.details).toMatchObject({ reason: 'no_date_columns' });
  });

  it('passes sprints_date_columns_present with two split date columns', async () => {
    const { client } = buildClientStub({
      DevDoctorBoards: {
        data: {
          boards: [
            { id: '200', name: 'Sprints', state: 'active', columns: [
              { id: 'start', title: 'Start', type: 'date', settings_str: null },
              { id: 'end', title: 'End', type: 'date', settings_str: null },
            ] },
          ],
        },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: { sprints_board: '200' },
    });
    expect(result.checks.find((c) => c.name === 'sprints_date_columns_present')?.status).toBe('ok');
  });

  it('warns sprints_date_columns_present with only one date column', async () => {
    const { client } = buildClientStub({
      DevDoctorBoards: {
        data: {
          boards: [
            { id: '200', name: 'Sprints', state: 'active', columns: [
              { id: 'start', title: 'Start', type: 'date', settings_str: null },
            ] },
          ],
        },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: { sprints_board: '200' },
    });
    const check = result.checks.find((c) => c.name === 'sprints_date_columns_present');
    expect(check?.status).toBe('warn');
  });

  it('fails tasks_to_*_relation when no board_relation column exists', async () => {
    const { client } = buildClientStub({
      DevDoctorBoards: {
        data: {
          boards: [
            { id: '100', name: 'Tasks', state: 'active', columns: [] },
            { id: '200', name: 'Sprints', state: 'active', columns: [] },
          ],
        },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: { tasks_board: '100', sprints_board: '200' },
    });
    const check = result.checks.find((c) => c.name === 'tasks_to_sprints_relation');
    expect(check?.status).toBe('fail');
    expect(check?.details).toMatchObject({ reason: 'no_relation_column' });
  });

  it('fails tasks_to_*_relation when relation column targets wrong board', async () => {
    const { client } = buildClientStub({
      DevDoctorBoards: {
        data: {
          boards: [
            { id: '100', name: 'Tasks', state: 'active', columns: [
              {
                id: 'rel',
                title: 'Rel',
                type: 'board_relation',
                settings_str: JSON.stringify({ boardIds: ['999'] }),
              },
            ] },
            { id: '200', name: 'Sprints', state: 'active', columns: [] },
          ],
        },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: { tasks_board: '100', sprints_board: '200' },
    });
    const check = result.checks.find((c) => c.name === 'tasks_to_sprints_relation');
    expect(check?.status).toBe('fail');
    expect(check?.details).toMatchObject({ reason: 'no_matching_relation' });
  });

  it('accepts board_ids (snake_case) as an alias for boardIds in relation settings', async () => {
    const { client } = buildClientStub({
      DevDoctorBoards: {
        data: {
          boards: [
            { id: '100', name: 'Tasks', state: 'active', columns: [
              {
                id: 'rel',
                title: 'Rel',
                type: 'board_relation',
                settings_str: JSON.stringify({ board_ids: ['200'] }),
              },
            ] },
            { id: '200', name: 'Sprints', state: 'active', columns: [] },
          ],
        },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: { tasks_board: '100', sprints_board: '200' },
    });
    expect(result.checks.find((c) => c.name === 'tasks_to_sprints_relation')?.status).toBe('ok');
  });

  it('skips the wire call when mapping is entirely empty (no configured IDs)', async () => {
    const { client, raw } = buildClientStub({});
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: {},
    });
    expect(raw).toHaveBeenCalledTimes(0);
    expect(result.checks.length).toBe(10);
    expect(result.summary.fail_count).toBe(10);
  });

  it('summary counts match the per-check statuses', async () => {
    const { client } = buildClientStub({
      DevDoctorBoards: {
        data: { boards: [] },
        complexity: null,
        stats: fakeStats(),
      },
    });
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: { tasks_board: '999' },
    });
    const ok = result.checks.filter((c: DevDoctorCheckResult) => c.status === 'ok').length;
    const warn = result.checks.filter((c: DevDoctorCheckResult) => c.status === 'warn').length;
    const fail = result.checks.filter((c: DevDoctorCheckResult) => c.status === 'fail').length;
    expect(result.summary).toEqual({
      ok_count: ok,
      warn_count: warn,
      fail_count: fail,
    });
  });

  it('result carries the wire complexity', async () => {
    const cpx = { before: 100, after: 90, query: 10, reset_in_x_seconds: 60 };
    const { client } = buildClientStub({
      DevDoctorBoards: {
        data: { boards: [] },
        complexity: cpx,
        stats: fakeStats(),
      },
    });
    const result = await runDevDoctor({
      client,
      profile: 'work',
      mapping: { tasks_board: '100' },
    });
    expect(result.complexity).toEqual(cpx);
  });
});

// Sanity reference — used to ensure ConfigError import isn't pruned.
void ConfigError;

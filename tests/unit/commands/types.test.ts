import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  NOUN_DESCRIPTIONS,
  lookupNounDescription,
} from '../../../src/commands/noun-descriptions.js';
import { ensureSubcommand } from '../../../src/commands/types.js';
import {
  InternalError,
  type MondayCliError,
} from '../../../src/utils/errors.js';

describe('ensureSubcommand', () => {
  it('creates a subcommand on first call, looking the description up in NOUN_DESCRIPTIONS', () => {
    const program = new Command();
    const child = ensureSubcommand(program, 'config');
    expect(child.name()).toBe('config');
    expect(child.description()).toBe(NOUN_DESCRIPTIONS.config);
    expect(program.commands.length).toBe(1);
  });

  it('returns the existing subcommand on second call without re-creating', () => {
    const program = new Command();
    const first = ensureSubcommand(program, 'config');
    const second = ensureSubcommand(program, 'config');
    expect(second).toBe(first);
    expect(program.commands.length).toBe(1);
  });

  it('only matches by name', () => {
    const program = new Command();
    ensureSubcommand(program, 'config');
    ensureSubcommand(program, 'cache');
    expect(program.commands.map((c) => c.name())).toEqual([
      'config',
      'cache',
    ]);
  });

  it('uses an explicit summary override when provided (M53 IMPL-migration window)', () => {
    const program = new Command();
    const child = ensureSubcommand(program, 'config', 'Override summary');
    expect(child.description()).toBe('Override summary');
  });

  it('explicit summary on an existing subcommand is ignored (find-or-create wins)', () => {
    const program = new Command();
    const first = ensureSubcommand(program, 'config');
    const second = ensureSubcommand(program, 'config', 'Should be ignored');
    expect(second).toBe(first);
    expect(first.description()).toBe(NOUN_DESCRIPTIONS.config);
  });

  it('throws InternalError with details.reason "unknown_noun" when name has no map entry and no summary', () => {
    const program = new Command();
    expect(() => ensureSubcommand(program, 'nonexistent-noun')).toThrow(
      InternalError,
    );
    try {
      ensureSubcommand(program, 'nonexistent-noun');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InternalError);
      expect((err as MondayCliError).code).toBe('internal_error');
      expect((err as MondayCliError).details).toMatchObject({
        reason: 'unknown_noun',
        noun: 'nonexistent-noun',
      });
    }
  });

  it('explicit summary bypasses the map lookup so unknown nouns do NOT throw when overridden', () => {
    const program = new Command();
    const child = ensureSubcommand(program, 'unknown-noun', 'Explicit desc');
    expect(child.name()).toBe('unknown-noun');
    expect(child.description()).toBe('Explicit desc');
  });
});

describe('NOUN_DESCRIPTIONS', () => {
  it('carries an entry for every noun the runtime registers', () => {
    const expected = [
      'account',
      'auth',
      'board',
      'cache',
      'config',
      'dev',
      'doc',
      'epic',
      'item',
      'notification',
      'release',
      'sprint',
      'task',
      'time-track',
      'update',
      'user',
      'webhook',
      'workspace',
    ];
    expect(Object.keys(NOUN_DESCRIPTIONS).sort()).toEqual(expected);
  });

  it('every entry is a non-empty string', () => {
    for (const [noun, desc] of Object.entries(NOUN_DESCRIPTIONS)) {
      expect(desc, `noun '${noun}' must have a non-empty description`).toBeTypeOf('string');
      expect(desc.length, `noun '${noun}' description must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('no entry contains internal-doc references per feedback_public_docs_clean (§ refs, M-numbers, plan-doc paths, deferral slots, TODOs)', () => {
    const internalRefPattern =
      /§\s*\d+|\bM\d{1,3}\b|v0\.\d+-M\d+|docs\/v0\.\d+-plan\.md|deferred_to|\bTODO\b|\bFIXME\b/iu;
    for (const [noun, desc] of Object.entries(NOUN_DESCRIPTIONS)) {
      expect(
        desc,
        `noun '${noun}' description '${desc}' leaks an internal reference`,
      ).not.toMatch(internalRefPattern);
    }
  });
});

describe('lookupNounDescription', () => {
  it('returns the mapped string for a known noun', () => {
    expect(lookupNounDescription('item')).toBe(NOUN_DESCRIPTIONS.item);
  });

  it('throws InternalError with details.reason "unknown_noun" + known_nouns list', () => {
    try {
      lookupNounDescription('not-a-real-noun');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InternalError);
      expect((err as MondayCliError).code).toBe('internal_error');
      const details = (err as MondayCliError).details as {
        reason: string;
        noun: string;
        known_nouns: readonly string[];
      };
      expect(details.reason).toBe('unknown_noun');
      expect(details.noun).toBe('not-a-real-noun');
      expect(details.known_nouns).toContain('item');
      expect(details.known_nouns).toContain('board');
    }
  });
});

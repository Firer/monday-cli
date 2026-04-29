import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { ensureSubcommand } from '../../../src/commands/types.js';

describe('ensureSubcommand', () => {
  it('creates a subcommand on first call', () => {
    const program = new Command();
    const child = ensureSubcommand(program, 'config', 'Configuration commands');
    expect(child.name()).toBe('config');
    expect(child.description()).toBe('Configuration commands');
    expect(program.commands.length).toBe(1);
  });

  it('returns the existing subcommand on second call', () => {
    const program = new Command();
    const first = ensureSubcommand(program, 'config', 'Configuration commands');
    const second = ensureSubcommand(program, 'config', 'Configuration commands');
    expect(second).toBe(first);
    expect(program.commands.length).toBe(1);
  });

  it('only matches by name', () => {
    const program = new Command();
    ensureSubcommand(program, 'config', 'A');
    ensureSubcommand(program, 'cache', 'B');
    expect(program.commands.map((c) => c.name())).toEqual(['config', 'cache']);
  });
});

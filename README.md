# monday-cli

A TypeScript CLI for interacting with [Monday.com](https://monday.com) and
Monday Dev — designed first for AI coding agents (Claude Code, Codex, etc.)
that need to pull tasks, file backlog items, and edit boards from the
terminal, with humans as a welcome second audience.

> **Status:** pre-zero. Toolchain and skeleton only — no commands wired up
> yet. See [CLAUDE.md](./CLAUDE.md) for the build plan.

## Requirements

- Node.js ≥ 22
- A Monday.com API token (admin or member; guests cannot mint one)

## Install (once published)

```bash
npm install -g monday-cli
```

For local development, see [docs/development.md](./docs/development.md).

## Configuration

Configuration is read from environment variables. The simplest setup:

```bash
export MONDAY_API_TOKEN="<your-token>"
```

A `.env` file in the working directory is also picked up. See
[`.env.example`](./.env.example) for the full set of supported variables.

## Usage

Once commands are wired up, the CLI surface will look like:

```bash
monday boards list
monday items get <item-id>
monday items create --board <id> --name "..."
monday dev sprint current
# ...
```

For now, only `--help` and `--version` are available.

## Documentation

- [CLAUDE.md](./CLAUDE.md) — agent-facing project context, conventions, workflow.
- [docs/architecture.md](./docs/architecture.md) — module boundaries and design.
- [docs/api-reference.md](./docs/api-reference.md) — Monday concepts cheat sheet.
- [docs/development.md](./docs/development.md) — local dev, tests, adding commands.

## License

UNLICENSED — internal/private project.

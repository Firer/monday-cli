// Library entry point — re-exports the pieces consumers might want to embed
// in another tool (e.g. an MCP server). The CLI itself lives in `src/cli/`.

export { loadConfig } from './config/load.js';
export type { Config } from './config/load.js';

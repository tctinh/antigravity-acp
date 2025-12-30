#!/usr/bin/env node
import { createAcpServer } from './acp-server.js';

const originalLog = console.log;

console.log = (...args) => console.error('[LOG]', ...args);
console.info = (...args) => console.error('[INFO]', ...args);
console.warn = (...args) => console.error('[WARN]', ...args);
console.debug = (...args) => console.error('[DEBUG]', ...args);

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    originalLog(`
antigravity-acp - ACP server for Antigravity API

Usage:
  antigravity-acp              Start ACP server (stdio mode)
  antigravity-acp login        Authenticate with Google OAuth
  antigravity-acp --help       Show this help

Environment:
  ANTIGRAVITY_MODEL            Default model (default: gemini-2.0-flash)
  ANTIGRAVITY_CONFIG           Config file path (default: ~/.config/opencode/antigravity.json)

For more information: https://github.com/anthropics/antigravity-acp
`);
    process.exit(0);
  }

  if (args[0] === 'login') {
    const { authorize } = await import('./auth.js');
    await authorize();
    return;
  }

  const defaultModel = process.env.ANTIGRAVITY_MODEL || 'gemini-2.0-flash';

  const server = createAcpServer({
    defaultModel,
  });

  server.start();

  process.stdin.resume();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

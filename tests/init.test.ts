import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runInit } from '../src/init.js';

/**
 * `init` edits files inside the user's repository. Clobbering an existing MCP config, or
 * writing a block an editor silently ignores, are the two failures that matter here.
 */

let root: string;
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf-8'));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creed-init-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export function a(): number { return 1; }\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"demo"}');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const init = (extra = {}) => runInit({ projectRoot: root, skipIndex: true, ...extra });

describe('creed init', () => {
  test('preserves MCP servers that are already configured', async () => {
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.cursor/mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'node', args: ['x.js'] } } })
    );

    await init();

    const config = read('.cursor/mcp.json');
    // Losing an unrelated server would break whatever the user had working.
    expect(config.mcpServers.other).toEqual({ command: 'node', args: ['x.js'] });
    expect(config.mcpServers.creed.command).toBe('creed-kg');
  });

  test('keeps unrelated top-level settings in a shared config file', async () => {
    fs.mkdirSync(path.join(root, '.gemini'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.gemini/settings.json'),
      JSON.stringify({ theme: 'dark', telemetry: false })
    );

    await init();

    const config = read('.gemini/settings.json');
    // settings.json isn't only MCP config — the rest of it has to survive.
    expect(config.theme).toBe('dark');
    expect(config.telemetry).toBe(false);
    expect(config.mcpServers.creed).toBeDefined();
  });

  test('uses the key each editor actually reads', async () => {
    fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });

    await init();

    // VS Code reads `servers`; everyone else reads `mcpServers`. Getting this wrong
    // produces a config that looks right and does nothing.
    expect(read('.vscode/mcp.json').servers.creed).toBeDefined();
    expect(read('.vscode/mcp.json').mcpServers).toBeUndefined();
    expect(read('.cursor/mcp.json').mcpServers.creed).toBeDefined();
  });

  test('writes no project path, so the same block works in any repo', async () => {
    await init({ all: true });
    const args = read('.mcp.json').mcpServers.creed.args;
    expect(args).toEqual(['mcp']);
    expect(args.some((a: string) => a.includes(root))).toBe(false);
  });

  test('never launches through npx', async () => {
    // npx defers a ~77 MB install to the moment the editor spawns the server, inside the
    // client's startup deadline. It gets killed mid-download, and because npx only caches
    // after a successful run, every later launch re-downloads and fails identically. The
    // install belongs in `init`, in the foreground — so no config may name npx.
    await init({ all: true });

    for (const file of ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json',
                        '.kiro/settings/mcp.json', '.gemini/settings.json']) {
      const config = read(file);
      const entry = (config.mcpServers ?? config.servers).creed;
      expect(entry.command, file).toBe('creed-kg');
      expect(entry.args, file).not.toContain('-y');
      expect(JSON.stringify(entry), file).not.toContain('npx');
    }
  });

  test('only touches editors that are actually used here', async () => {
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });

    await init();

    expect(fs.existsSync(path.join(root, '.cursor/mcp.json'))).toBe(true);
    // No .vscode/ or .kiro/ in this project — don't create them.
    expect(fs.existsSync(path.join(root, '.vscode'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.kiro'))).toBe(false);
  });

  test('falls back to .mcp.json when no editor is detected', async () => {
    await init();
    expect(read('.mcp.json').mcpServers.creed).toBeDefined();
  });

  test('--all configures every supported editor', async () => {
    const result = await init({ all: true });
    expect(result.written.length).toBeGreaterThanOrEqual(5);
    for (const f of ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json',
                     '.kiro/settings/mcp.json', '.gemini/settings.json']) {
      expect(fs.existsSync(path.join(root, f)), f).toBe(true);
    }
  });

  test('re-running reports no change rather than rewriting', async () => {
    await init();
    const second = await init();
    expect(second.written).toEqual([]);
    expect(second.alreadyPresent.length).toBeGreaterThan(0);
  });

  test('adds the index dir to .gitignore exactly once', async () => {
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');

    expect((await init()).gitignoreUpdated).toBe(true);
    expect((await init()).gitignoreUpdated).toBe(false);

    const content = fs.readFileSync(path.join(root, '.gitignore'), 'utf-8');
    expect(content).toContain('node_modules/');
    expect(content.match(/\.creed\//g)?.length).toBe(1);
  });

  test('does not create a .gitignore outside a git repo', async () => {
    // No .git here — leaving a .gitignore behind would just be litter.
    expect((await init()).gitignoreUpdated).toBe(false);
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
  });

  test('replaces an unparseable config rather than crashing', async () => {
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(root, '.cursor/mcp.json'), '{ this is not json');

    await init();

    expect(read('.cursor/mcp.json').mcpServers.creed).toBeDefined();
  });
});

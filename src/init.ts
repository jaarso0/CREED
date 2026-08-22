import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { Pipeline } from './pipeline.js';
import { SqliteSemanticModelStorage } from './storage/sqlite/sqlite-model-storage.js';
import { SqlitePartialCache } from './storage/sqlite/partial-cache.js';
import { INDEX_DIR } from './storage/sqlite/db.js';

/**
 * The server entry written into every MCP config.
 *
 * No project path: `creed-kg mcp` resolves the project by walking up from wherever the
 * editor launches it. That's what makes one identical block work in every repository —
 * and lets a user drop it in a global config once instead of per project.
 */
const SERVER_ENTRY = {
  command: 'npx',
  args: ['-y', 'creed-kg', 'mcp']
};

const SERVER_NAME = 'creed';

interface EditorTarget {
  id: string;
  label: string;
  /** Config file, relative to the project root. */
  file: string;
  /** Paths whose presence means this editor is already in use here. */
  markers: string[];
  /** Top-level key holding the server map. VS Code is the odd one out. */
  key: 'mcpServers' | 'servers';
}

/**
 * Editors configured by a JSON file inside the repository. Global-only or non-JSON
 * clients are handled by `MANUAL_TARGETS` instead — writing to a user's home directory
 * or rewriting their TOML is more invasive than `init` should be without being asked.
 */
const EDITOR_TARGETS: EditorTarget[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    file: '.mcp.json',
    markers: ['.mcp.json', '.claude'],
    key: 'mcpServers'
  },
  {
    id: 'cursor',
    label: 'Cursor',
    file: path.join('.cursor', 'mcp.json'),
    markers: ['.cursor'],
    key: 'mcpServers'
  },
  {
    id: 'vscode',
    label: 'VS Code / GitHub Copilot',
    file: path.join('.vscode', 'mcp.json'),
    markers: ['.vscode'],
    // VS Code names this `servers`. Using `mcpServers` here silently does nothing.
    key: 'servers'
  },
  {
    id: 'kiro',
    label: 'Kiro',
    file: path.join('.kiro', 'settings', 'mcp.json'),
    markers: ['.kiro'],
    key: 'mcpServers'
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    file: path.join('.gemini', 'settings.json'),
    markers: ['.gemini'],
    key: 'mcpServers'
  }
];

/**
 * Clients that can't be configured safely from here — either the config lives outside the
 * repo, or it isn't JSON. Printed as instructions rather than guessed at: writing a wrong
 * config into someone's editor is worse than writing none.
 */
const MANUAL_TARGETS = [
  ['Claude Desktop', 'run `npx creed-kg setup` — it writes the config for you'],
  ['Windsurf', '~/.codeium/windsurf/mcp_config.json'],
  ['Codex CLI', '~/.codex/config.toml — TOML, add an [mcp_servers.creed] section'],
  ['OpenCode', 'opencode.json — uses its own `mcp` schema'],
  ['Antigravity', 'add it from the editor’s MCP settings panel']
];

export interface InitOptions {
  projectRoot: string;
  /** Write configs for every known editor, not just the ones detected. */
  all?: boolean;
  /** Explicit editor ids; overrides detection. */
  editors?: string[];
  /** Skip building the index (config only). */
  skipIndex?: boolean;
}

export interface InitResult {
  indexed: { files: number; symbols: number; parsed: number; reused: number } | null;
  written: string[];
  alreadyPresent: string[];
  gitignoreUpdated: boolean;
}

/** Merges the Creed server into one config file, preserving everything already there. */
async function writeEditorConfig(
  projectRoot: string,
  target: EditorTarget
): Promise<'written' | 'already-present'> {
  const filePath = path.join(projectRoot, target.file);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let config: Record<string, any> = {};
  try {
    config = JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    // Missing, empty or unparseable — start fresh rather than refusing. An unparseable
    // config is already broken; overwriting it with something valid is the better outcome.
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) config = {};

  const servers = (config[target.key] && typeof config[target.key] === 'object')
    ? config[target.key]
    : {};

  const existing = servers[SERVER_NAME];
  const alreadyCorrect =
    existing &&
    existing.command === SERVER_ENTRY.command &&
    JSON.stringify(existing.args) === JSON.stringify(SERVER_ENTRY.args);

  servers[SERVER_NAME] = { ...SERVER_ENTRY };
  config[target.key] = servers;

  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return alreadyCorrect ? 'already-present' : 'written';
}

/** Adds the index directory to .gitignore if it isn't covered already. */
async function ensureGitignore(projectRoot: string): Promise<boolean> {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const entry = `${INDEX_DIR}/`;

  let content = '';
  try {
    content = await fs.readFile(gitignorePath, 'utf-8');
  } catch {
    // No .gitignore. Only create one inside an actual git repo — dropping the file into a
    // non-repo directory is litter.
    if (!fsSync.existsSync(path.join(projectRoot, '.git'))) return false;
  }

  const alreadyIgnored = content
    .split(/\r?\n/)
    .some(line => line.trim().replace(/\/$/, '') === INDEX_DIR);
  if (alreadyIgnored) return false;

  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  await fs.writeFile(
    gitignorePath,
    `${content}${prefix}\n# Creed code index (derived — rebuildable from source)\n${entry}\n`,
    'utf-8'
  );
  return true;
}

/** Which editors to configure: explicit list, everything, or whatever is detected. */
function selectTargets(projectRoot: string, opts: InitOptions): EditorTarget[] {
  if (opts.editors && opts.editors.length > 0) {
    return EDITOR_TARGETS.filter(t => opts.editors!.includes(t.id));
  }
  if (opts.all) return EDITOR_TARGETS;

  const detected = EDITOR_TARGETS.filter(t =>
    t.markers.some(m => fsSync.existsSync(path.join(projectRoot, m)))
  );

  // Nothing detected: write the one config most clients read, rather than scattering
  // folders for editors this project may never open.
  return detected.length > 0
    ? detected
    : EDITOR_TARGETS.filter(t => t.id === 'claude-code');
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const { projectRoot } = opts;
  const result: InitResult = {
    indexed: null,
    written: [],
    alreadyPresent: [],
    gitignoreUpdated: false
  };

  console.log(`\nCreed init — ${projectRoot}\n`);

  if (!opts.skipIndex) {
    console.log('Indexing…');
    const cache = new SqlitePartialCache(projectRoot);
    let build;
    try {
      build = await new Pipeline().build(projectRoot, { cache });
    } finally {
      cache.close();
    }
    await new SqliteSemanticModelStorage().save(build.model, projectRoot, build.fileRecords);
    result.indexed = {
      files: build.model.fileCount,
      symbols: build.model.symbolCount,
      parsed: build.stats.parsed,
      reused: build.stats.reused
    };
    console.log(
      `  ${result.indexed.files} files, ${result.indexed.symbols} symbols ` +
      `→ ${INDEX_DIR}/graph.db\n`
    );
  }

  const targets = selectTargets(projectRoot, opts);
  console.log('Connecting agents…');
  for (const target of targets) {
    try {
      const outcome = await writeEditorConfig(projectRoot, target);
      if (outcome === 'already-present') {
        result.alreadyPresent.push(target.label);
        console.log(`  = ${target.label.padEnd(24)} ${target.file} (already configured)`);
      } else {
        result.written.push(target.label);
        console.log(`  ✓ ${target.label.padEnd(24)} ${target.file}`);
      }
    } catch (err: any) {
      console.log(`  ✗ ${target.label.padEnd(24)} ${err.message || err}`);
    }
  }

  result.gitignoreUpdated = await ensureGitignore(projectRoot);
  if (result.gitignoreUpdated) {
    console.log(`\n  ✓ added ${INDEX_DIR}/ to .gitignore`);
  }

  console.log('\nOther clients (configure manually):');
  for (const [label, where] of MANUAL_TARGETS) {
    console.log(`  · ${label.padEnd(16)} ${where}`);
  }

  console.log(`\nRestart your editor, then ask it: "what MCP tools do you have?"`);
  console.log(`Or try it right now:  npx creed-kg query "how does this project work"\n`);

  return result;
}

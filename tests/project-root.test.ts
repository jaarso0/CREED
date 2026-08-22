import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findProjectRoot } from '../src/index.js';

/**
 * Root detection is what lets the MCP config block be path-free and therefore identical in
 * every project. If it regresses, users are back to hard-coding an absolute path per repo.
 */

let tmp: string;
const real = (p: string) => fs.realpathSync(p);

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creed-root-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function make(rel: string, marker?: string): string {
  const dir = path.join(tmp, rel);
  fs.mkdirSync(dir, { recursive: true });
  if (marker) fs.writeFileSync(path.join(dir, marker), '{}');
  return dir;
}

describe('findProjectRoot', () => {
  test('finds the root when started in a deep subdirectory', () => {
    const root = make('repo', 'package.json');
    const deep = make('repo/src/services/auth');
    expect(real(findProjectRoot(deep))).toBe(real(root));
  });

  test('recognises each supported marker on its own', () => {
    for (const marker of ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml']) {
      const root = make(`p-${marker.replace('.', '')}`, marker);
      const deep = make(`p-${marker.replace('.', '')}/a/b`);
      expect(real(findProjectRoot(deep)), marker).toBe(real(root));
    }
  });

  test('stops at the nearest root, so a monorepo package wins over the repo', () => {
    make('mono', '.git');
    const pkg = make('mono/packages/api', 'package.json');
    const deep = make('mono/packages/api/src');
    // The whole monorepo is rarely the scope you meant when working inside one package.
    expect(real(findProjectRoot(deep))).toBe(real(pkg));
  });

  test('ignores package.json belonging to a dependency', () => {
    const root = make('app', 'package.json');
    const dep = make('app/node_modules/lodash', 'package.json');
    // Spawned inside node_modules, the answer is still the user's project.
    expect(real(findProjectRoot(dep))).toBe(real(root));
  });

  test('falls back to the starting directory when nothing marks a root', () => {
    const bare = make('nothing-here/deep');
    // No marker below the home directory — behave as before rather than wandering off.
    expect(real(findProjectRoot(bare))).toBe(real(bare));
  });

  test('never infers the home directory as a project root', () => {
    // Most machines have a stray package.json or a dotfiles .git in $HOME. Walking up into
    // it would silently aim Creed at every file the user owns, which is catastrophic on a
    // large home folder — so ascent stops before it.
    const bare = make('unmarked/nested/deeper');
    const resolved = real(findProjectRoot(bare));
    expect(resolved).not.toBe(real(os.homedir()));
    expect(resolved).toBe(real(bare));
  });

  test('an already-indexed directory is a root even without other markers', () => {
    const root = path.join(tmp, 'indexed');
    fs.mkdirSync(path.join(root, '.creed'), { recursive: true });
    const deep = make('indexed/src');
    expect(real(findProjectRoot(deep))).toBe(real(root));
  });
});

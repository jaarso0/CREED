import {
  FileCode2,
  Layers,
  Blocks,
  Cpu,
  Play,
  Terminal,
  Code,
  Type,
  FolderGit,
  Package,
  Box,
  Globe,
  Database,
} from 'lucide-react';

/*
 * Canvas rendering can't resolve CSS custom properties, so kind colours live here
 * as literal values and the sidebar reads the same table. Keep in sync with the
 * --color-* variables in index.css.
 */
const KIND_COLORS: Record<string, string> = {
  project: '#3b82f6',
  file: '#0ea5e9',
  package: '#ef4444',
  module: '#e2e8f0',
  class: '#a855f7',
  interface: '#ec4899',
  struct: '#14b8a6',
  function: '#10b981',
  method: '#f59e0b',
  variable: '#14b8a6',
  type_alias: '#6366f1',
  api_route: '#10b981',
  data_model: '#f59e0b',
};

const KIND_ICONS: Record<string, typeof Code> = {
  project: FolderGit,
  file: FileCode2,
  package: Package,
  module: Box,
  class: Layers,
  interface: Blocks,
  struct: Cpu,
  function: Play,
  method: Terminal,
  variable: Code,
  type_alias: Type,
  api_route: Globe,
  data_model: Database,
};

export function symbolColor(kind: string): string {
  return KIND_COLORS[kind] ?? '#3b82f6';
}

export function getSymbolTheme(kind: string) {
  return { color: symbolColor(kind), Icon: KIND_ICONS[kind] ?? Code };
}

/** Colours for the relation kinds drawn between nodes. */
export function relationColor(kind: string): string {
  switch (kind) {
    case 'call':
      return '#10b981';
    case 'inherit':
    case 'implement':
      return '#a855f7';
    case 'import':
      return '#0ea5e9';
    case 'instantiate':
      return '#f59e0b';
    case 'renders':
      return '#ec4899';
    case 'contains':
      return '#64748b';
    default:
      return '#64748b';
  }
}

/** Dash pattern per relation kind, or null for a solid line. */
export function relationDash(kind: string): number[] | null {
  switch (kind) {
    case 'import':
      return [2, 2];
    case 'inherit':
    case 'implement':
      return [4, 4];
    case 'contains':
      return [1, 3];
    default:
      return null;
  }
}

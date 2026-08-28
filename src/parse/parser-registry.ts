import Parser from 'tree-sitter';
import { createRequire } from 'module';
import { Language } from './lang-detect.js';

const require = createRequire(import.meta.url);

/**
 * Grammars are loaded on first use, not at module load.
 *
 * Statically importing all ten pulled every native addon into the process before anything
 * had been parsed — ~140 ms of startup, of which a TypeScript-only repository used ~40 ms
 * and wasted the rest. That cost was paid on every MCP server spawn, inside the window a
 * client allows for the handshake.
 *
 * Loading through `createRequire` rather than `await import()` keeps `getParser` synchronous,
 * which its callers (`parseSourceFile`, the query runner) depend on.
 */
const GRAMMARS: Record<Language, () => unknown> = {
  javascript: () => require('tree-sitter-javascript'),
  jsx:        () => require('tree-sitter-javascript'),
  typescript: () => require('tree-sitter-typescript').typescript,
  tsx:        () => require('tree-sitter-typescript').tsx,
  python:     () => require('tree-sitter-python'),
  java:       () => require('tree-sitter-java'),
  html:       () => require('tree-sitter-html'),
  go:         () => require('tree-sitter-go'),
  csharp:     () => require('tree-sitter-c-sharp'),
  cpp:        () => require('tree-sitter-cpp'),
  r:          () => require('@davisvaughan/tree-sitter-r')
};

export class ParserRegistry {
  private parsers = new Map<Language, Parser>();

  public getParser(lang: Language): Parser {
    let parser = this.parsers.get(lang);
    if (!parser) {
      parser = new Parser();
      parser.setLanguage(this.getLanguageObject(lang));
      this.parsers.set(lang, parser);
    }
    return parser;
  }

  public hasParser(lang: Language): boolean {
    return this.parsers.has(lang);
  }

  private getLanguageObject(lang: Language): any {
    const load = GRAMMARS[lang];
    if (!load) throw new Error(`Unsupported language: ${lang}`);

    try {
      return load();
    } catch (err: any) {
      // Reported against the language rather than the module specifier: once grammars become
      // optional dependencies, a missing one is a normal state ("this repo has R files, that
      // grammar isn't installed") and the message has to say which language went unparsed.
      throw new Error(
        `Grammar for "${lang}" could not be loaded: ${err?.message || err}`
      );
    }
  }
}

// Single export of lazy parser registry
export const parserRegistry = new ParserRegistry();

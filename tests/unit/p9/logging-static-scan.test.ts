import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Phase 9, FR-073 ("Never log selected document content/key by default"; "Production logging
// test shows metadata-only diagnostic events if any") and the sink rules of docs/architecture.md
// section 10 (no `innerHTML`, no `eval`, no remote code). The runtime checks (the worker's console
// during failures, the reply envelopes) are in the E2E and integration suites; this is the
// STRUCTURAL guard: every place the extension can write to the console or build HTML or run code
// from a string is listed here, so a new one fails this test until someone looks at it.
//
// Source is read from the repository (extension code only: entrypoints, components, lib).

const ROOT = path.resolve(__dirname, '../../..');
const DIRS = ['entrypoints', 'components', 'lib'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = DIRS.flatMap((d) => sourceFiles(path.join(ROOT, d)));
const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');

/** `source` with comments and string-free noise kept; only line comments are dropped. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

/** The argument text of every `<name>(...)` call, balanced over parentheses. */
function calls(source: string, name: RegExp): { call: string; args: string }[] {
  const out: { call: string; args: string }[] = [];
  const re = new RegExp(name.source + '\\(', 'g');
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    out.push({ call: m[0], args: source.slice(start, i - 1) });
  }
  return out;
}

/** The property names at the top level of an object literal's body (nested calls and objects skipped). */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let start = 0;
  const flush = (end: number): void => {
    const part = body.slice(start, end).trim();
    const name = /^(\w+)\s*(:|$)/.exec(part)?.[1];
    if (name !== undefined) keys.push(name);
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if ('([{'.includes(ch!)) depth += 1;
    else if (')]}'.includes(ch!)) depth -= 1;
    else if (ch === ',' && depth === 0) {
      flush(i);
      start = i + 1;
    }
  }
  flush(body.length);
  return keys;
}

describe('console output (FR-073)', () => {
  const consoleCalls = FILES.flatMap((file) =>
    calls(code(file), /console\.(log|info|debug|trace|dir|table|warn|error)/).map((c) => ({
      file: rel(file),
      ...c,
    })),
  );

  it('there is no console.log/info/debug/trace/dir/table anywhere in the extension', () => {
    expect(consoleCalls.filter((c) => !/console\.(warn|error)\($/.test(c.call))).toEqual([]);
  });

  it('every console.warn/error is the redacting logger, or a fixed message plus an error NAME', () => {
    const allowed: Record<string, RegExp> = {
      // The logger: formats an allowlisted-metadata event.
      'lib/security/logger.ts': /^format\(event\), sanitizeMetadata\(meta\)$/,
      // The rest log a constant string and `error.name` only.
      'lib/security/storage-lockdown.ts':
        /^'Clavis: could not restrict storage access', \(error as Error\)\?\.name$/,
      'lib/pdf/controller.ts':
        /^'PDF viewer cleanup failed', error instanceof Error \? error\.name : 'error'$/,
      'lib/site-access/background.ts':
        /^`Clavis: \$\{what\} failed`, error instanceof Error \? error\.name : ''$/,
      'lib/selection/controller.ts':
        /^'Clavis: toolbar UI failed to load', error instanceof Error \? error\.name : '',?$/,
    };
    const problems: string[] = [];
    for (const c of consoleCalls) {
      const pattern = allowed[c.file];
      const args = c.args.replace(/\s+/g, ' ').trim();
      if (pattern === undefined) problems.push(`${c.file}: unlisted ${c.call}${args})`);
      else if (!pattern.test(args))
        problems.push(`${c.file}: ${c.call}${args}) does not match its allowed form`);
    }
    expect(problems).toEqual([]);
    // ...and each allowed site really exists (the list does not rot).
    for (const file of Object.keys(allowed)) {
      expect(
        consoleCalls.some((c) => c.file === file),
        `${file} no longer logs`,
      ).toBe(true);
    }
  });

  it('the logger accepts only the five metadata fields, so nothing else can be passed to it', () => {
    const source = code(path.join(ROOT, 'lib/security/logger.ts'));
    const fields = /LOG_METADATA_FIELDS = \[([^\]]*)\]/.exec(source)?.[1] ?? '';
    expect(
      fields
        .split(',')
        .map((f) => f.trim().replace(/['"]/g, ''))
        .filter(Boolean),
    ).toEqual(['requestId', 'mode', 'status', 'durationMs', 'errorCode']);
  });

  it('every call to the logger passes only allowlisted metadata (no text, url, key or model output)', () => {
    const problems: string[] = [];
    for (const file of FILES) {
      for (const c of calls(code(file), /logger\.(debug|warn|error)/)) {
        const args = c.args.replace(/\s+/g, ' ').trim();
        const names = topLevelKeys(/\{([\s\S]*)\}/.exec(args)?.[1] ?? '');
        for (const name of names) {
          if (!['requestId', 'mode', 'status', 'durationMs', 'errorCode'].includes(name)) {
            problems.push(`${rel(file)}: logger field "${name}" in ${c.call}${args})`);
          }
        }
        // The event name is a fixed identifier, never built from data.
        if (!/^'[A-Za-z0-9_.:-]{1,48}'/.test(args))
          problems.push(`${rel(file)}: event is not a literal: ${args.slice(0, 60)}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('code and HTML sinks (FR-041, FR-075, D-10)', () => {
  it('no eval, new Function, string timers, document.write, innerHTML/outerHTML assignment, insertAdjacentHTML or dangerouslySetInnerHTML', () => {
    const forbidden: [string, RegExp][] = [
      ['eval(', /(^|[^.\w])eval\s*\(/],
      ['new Function', /new\s+Function\s*\(/],
      ['setTimeout with a string', /set(Timeout|Interval)\(\s*['"`]/],
      ['document.write', /document\.write(ln)?\s*\(/],
      ['innerHTML/outerHTML assignment', /\.(innerHTML|outerHTML)\s*=[^=]/],
      ['insertAdjacentHTML', /insertAdjacentHTML\s*\(/],
      ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
      ['srcdoc assignment', /\.srcdoc\s*=[^=]/],
      ['import() of a remote URL', /import\(\s*['"`]https?:/],
      ['a script element from a URL', /createElement\(\s*['"]script['"]/],
    ];
    const problems: string[] = [];
    for (const file of FILES) {
      const source = code(file);
      for (const [name, pattern] of forbidden) {
        if (pattern.test(source)) problems.push(`${rel(file)}: ${name}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('no network call in the extension targets anything but the Groq API (fetch/XMLHttpRequest/WebSocket/EventSource/sendBeacon)', () => {
    const problems: string[] = [];
    for (const file of FILES) {
      const source = code(file);
      for (const c of calls(source, /(?<![.\w])fetch/)) {
        const where = rel(file);
        // The Groq adapter is the one place; PDF.js and the speech/UI code never call fetch directly.
        if (where !== 'lib/ai/groq.ts') problems.push(`${where}: fetch(${c.args.slice(0, 50)})`);
      }
      for (const pattern of [
        /new\s+XMLHttpRequest/,
        /new\s+WebSocket/,
        /new\s+EventSource/,
        /sendBeacon\s*\(/,
      ]) {
        if (pattern.test(source)) problems.push(`${rel(file)}: ${pattern.source}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every http(s) URL literal in the extension code is a documentation or provider link, never a place data is sent', () => {
    const known = [
      /^https:\/\/api\.groq\.com\//,
      /^https:\/\/console\.groq\.com\//,
      /^https:\/\/groq\.com\//,
      /^https:\/\/omakidx\.github\.io\/clavis\//,
      /^https?:\/\/\*\//,
      /^https?:\/\/localhost/,
      /^https?:\/\/127\.0\.0\.1/,
      /^https?:\/\/example\.(com|org)/,
      /^https?:\/\/www\.w3\.org\//,
      /^https:\/\/developer\.chrome\.com\//,
      // The Chrome Web Store, which content scripts are never registered on (an exclusion list).
      /^https:\/\/chromewebstore\.google\.com\//,
      /^https:\/\/chrome\.google\.com\/webstore/,
      // A hostname the user typed for the per-site disable list, only validated, never fetched.
      /^https:\/\/\$\{/,
      /^https:\/\/github\.com\/(mozilla|omakidx)\//,
    ];
    const problems: string[] = [];
    for (const file of FILES) {
      for (const m of code(file).matchAll(/['"`](https?:\/\/[^'"`\s)]+)/g)) {
        const url = m[1]!;
        if (!known.some((k) => k.test(url))) problems.push(`${rel(file)}: ${url}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('self-check: the scanners find what they are looking for', () => {
  it('flags a console.log of selected text, a logger field that carries text, and an innerHTML assignment', () => {
    const bad = `
      console.log(selection.text);
      logger.error('failed', { text: selection.text, errorCode: String(error) });
      el.innerHTML = model.summary;
    `;
    expect(calls(bad, /console\.(log|warn)/).map((c) => c.args)).toEqual(['selection.text']);
    const logged = calls(bad, /logger\.error/)[0]!.args;
    expect(topLevelKeys(/\{([\s\S]*)\}/.exec(logged)?.[1] ?? '')).toEqual(['text', 'errorCode']);
    expect(/\.(innerHTML|outerHTML)\s*=[^=]/.test(bad)).toBe(true);
    // Nested calls with commas do not confuse the key reader.
    expect(topLevelKeys(`errorCode: x.slice(0, 40), mode: 'core'`)).toEqual(['errorCode', 'mode']);
  });
});

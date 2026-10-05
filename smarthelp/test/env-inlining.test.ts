import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the `NEXT_PUBLIC_*` inlining pattern.
 *
 * This is the only kind of test in the project that asserts something about the
 * *source text* rather than behaviour, and it earns its place: Next.js replaces
 * literal `process.env.NEXT_PUBLIC_FOO` with the value at build time and hands
 * the browser an empty `{}` in place of `process.env`. A computed lookup such
 * as `process.env[key]` therefore reads as undefined in the browser for every
 * key, while working perfectly on the server.
 *
 * The consequence is nasty and silent: the app declares itself unconfigured on
 * every page load with a valid `.env.local`, the server routes work, `next
 * build` passes, and every unit test passes — because all of them run in Node,
 * where `process.env` is real. The bug was found by opening the browser.
 *
 * So this asserts the shape of the code that decides whether the app is
 * configured, in every file that ships to the browser.
 */

/** Files that run in the browser and therefore get `process.env` inlined. */
const BROWSER_SIDE = [
  'lib/supabase.ts',
  'lib/roles.ts',
  'lib/api.ts',
  'contexts/AuthContext.tsx',
];

const root = join(__dirname, '..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');

/** A line that only talks *about* the pattern is not using it. */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

describe('NEXT_PUBLIC_ variable access', () => {
  it('never uses a computed lookup of process.env in browser-side code', () => {
    const offenders: string[] = [];

    for (const file of BROWSER_SIDE) {
      read(file)
        .split('\n')
        .forEach((line, i) => {
          if (isComment(line)) return;
          // `process.env.SOMETHING` is fine. `process.env[x]` and
          // `process.env[key.toLowerCase()]` are not.
          if (/process\.env\s*\[/.test(line)) {
            offenders.push(`${file}:${i + 1}  ${line.trim()}`);
          }
        });
    }

    expect(
      offenders,
      'Computed process.env lookups break NEXT_PUBLIC_ inlining in the browser:\n' +
        offenders.join('\n')
    ).toEqual([]);
  });

  it('reads the browser credentials as literal member access', () => {
    const source = read('lib/supabase.ts');
    expect(source).toContain('process.env.NEXT_PUBLIC_SUPABASE_URL');
    expect(source).toContain('process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY');
  });
});

/**
 * The inlining has a second consequence, on the server side, and this is the
 * half that decides who becomes super_admin.
 *
 * `lib/owner.ts` reads the allow-list once, at module load. A `NEXT_PUBLIC_`
 * member access is substituted at build time with whatever the bundler loaded
 * from the env files, so such a read does not observe the live process
 * environment — the allow-list silently compares against a stale value. Aliasing
 * `process.env` does not help; the substitution is not tied to that spelling.
 *
 * The value is also compiled into the client bundle and readable by anyone who
 * loads the page, so it has no business gating a privilege escalation. This
 * asserts the server-only variable is the only input, which is a claim about
 * source text on purpose: a behavioural test cannot see the substitution, since
 * a stale baked value still looks like a working comparison.
 */
describe('super_admin allow-list sourcing', () => {
  const readOwner = () =>
    read('lib/owner.ts')
      .split('\n')
      .filter((line) => !isComment(line))
      .join('\n');

  it('reads the server-only variable', () => {
    expect(readOwner()).toContain('process.env.SMARTHELP_OWNER_LOGIN');
  });

  it('never reads a NEXT_PUBLIC_ variable as an authorisation input', () => {
    const offenders: string[] = [];

    readOwner()
      .split('\n')
      .forEach((line) => {
        if (/process\.env\.NEXT_PUBLIC_/.test(line)) {
          offenders.push(line.trim());
        }
      });

    expect(
      offenders,
      'NEXT_PUBLIC_ values are inlined at build time and shipped to the browser; ' +
        'the super_admin allow-list must not read one:\n' + offenders.join('\n')
    ).toEqual([]);
  });
});

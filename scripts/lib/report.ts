/**
 * The end-to-end scripts' output: colors, and a counter of checks that decides
 * the exit code. Shared so that every script states its results the same way.
 */

const ESC = String.fromCharCode(27);
const paint = (code: string) => (text: string) => `${ESC}[${code}m${text}${ESC}[0m`;
export const green = paint('32');
export const red = paint('31');
export const bold = paint('1');
export const dim = paint('2');
export const write = (text: string) => process.stdout.write(text);

/** A counter of checks: `record()` writes an OK/KO line and counts it. */
export function createReport() {
  let passes = 0;
  let failures = 0;
  return {
    record(scope: string, label: string, ok: boolean, detail = ''): boolean {
      if (ok) passes += 1;
      else failures += 1;
      write(
        `  ${ok ? green('OK') : red('KO')} [${scope}] ${label}${detail ? ` ${dim(`— ${detail}`)}` : ''}\n`,
      );
      return ok;
    },
    get passes() {
      return passes;
    },
    get failures() {
      return failures;
    },
    /** The summary, in one line, then the verdict. */
    summary(success: string): void {
      write(`\n  ${passes} check(s) green, ${failures} failing\n`);
      write(failures === 0 ? green(bold(`\n${success}\n`)) : red(bold('\nFailure.\n')));
    },
  };
}

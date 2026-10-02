/**
 * La sortie des scripts de bout en bout : des couleurs, et un compteur de
 * vérifications qui décide du code de sortie. Partagé pour que chaque script
 * dise ses résultats de la même façon.
 */

const ESC = String.fromCharCode(27);
const paint = (code: string) => (text: string) => `${ESC}[${code}m${text}${ESC}[0m`;
export const green = paint('32');
export const red = paint('31');
export const bold = paint('1');
export const dim = paint('2');
export const write = (text: string) => process.stdout.write(text);

/** Un compteur de vérifications : `record()` écrit une ligne OK/KO et la compte. */
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
    /** Le bilan, en une ligne, puis le verdict. */
    summary(success: string): void {
      write(`\n  ${passes} vérification(s) au vert, ${failures} en échec\n`);
      write(failures === 0 ? green(bold(`\n${success}\n`)) : red(bold('\nÉchec.\n')));
    },
  };
}

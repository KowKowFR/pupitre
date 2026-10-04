/**
 * Un mini-analyseur lexical de TypeScript/TSX — juste assez pour répondre à
 * une question : « où sont les chaînes de caractères et les textes JSX, et
 * qu'est-ce qui n'est qu'un commentaire ? »
 *
 * Pourquoi pas une expression régulière : parce qu'elle se trompe sur
 * `'http://exemple'` (qu'elle prend pour un commentaire), sur `// il a dit "x"`
 * (dont elle extrait une fausse chaîne) et sur les gabarits imbriqués. Une
 * garde qui crie au loup une fois sur dix finit désactivée, et une seconde
 * langue meurt le jour où sa garde est désactivée.
 *
 * Pourquoi pas le compilateur TypeScript : il est là, mais le charger
 * rendrait ce test lent et dépendant. Le balayage ci-dessous fait cent lignes,
 * il est exact sur ce qu'on lui demande, et il ne coûte rien.
 */

/**
 * Rend les chaînes littérales et les textes JSX d'un source, chacun avec sa
 * ligne. Les commentaires sont ignorés : la langue du projet est le français,
 * et ce fichier n'a rien à dire dessus.
 */
export function scanSource(source, { jsx = true } = {}) {
  const strings = [];
  const jsxTexts = [];

  let i = 0;
  let line = 1;
  const n = source.length;

  const at = (offset = 0) => source[i + offset];

  /**
   * Dernier caractère qui compte pour la grammaire — ni espace, ni commentaire.
   * Il ne sert qu'à trancher entre une division et une expression régulière.
   */
  let lastSignificant = '';

  /** Un `/` ici ouvre-t-il une expression régulière plutôt qu'une division ? */
  function startsRegex() {
    if (lastSignificant === '') return true;
    return !/[)\]}\w$'"`]/.test(lastSignificant);
  }

  function advance(count = 1) {
    for (let k = 0; k < count; k += 1) {
      if (source[i] === '\n') line += 1;
      i += 1;
    }
  }

  /** Avale un gabarit `…`, en relevant ses morceaux littéraux. */
  function readTemplate() {
    const startLine = line;
    advance(); // le backtick ouvrant
    let chunk = '';
    while (i < n) {
      if (at() === '\\') {
        chunk += at(1) ?? '';
        advance(2);
        continue;
      }
      if (at() === '`') {
        advance();
        break;
      }
      if (at() === '$' && at(1) === '{') {
        if (chunk !== '') strings.push({ value: chunk, line: startLine });
        chunk = '';
        advance(2);
        // On saute l'interpolation en comptant les accolades. Le code qu'elle
        // contient est réanalysé au tour suivant seulement s'il porte lui-même
        // un gabarit — ce que le comptage traverse sans le manger.
        let depth = 1;
        while (i < n && depth > 0) {
          if (at() === '{') depth += 1;
          else if (at() === '}') depth -= 1;
          else if (at() === '`') {
            readTemplate();
            continue;
          } else if (at() === "'" || at() === '"') {
            readQuoted(at());
            continue;
          }
          advance();
        }
        continue;
      }
      chunk += at();
      advance();
    }
    if (chunk !== '') strings.push({ value: chunk, line: startLine });
  }

  /** Avale une chaîne `'…'` ou `"…"`. */
  function readQuoted(quote) {
    const startLine = line;
    advance();
    let value = '';
    while (i < n && at() !== quote) {
      if (at() === '\\') {
        value += at(1) ?? '';
        advance(2);
        continue;
      }
      if (at() === '\n') break; // chaîne non terminée : on ne devine pas
      value += at();
      advance();
    }
    advance();
    strings.push({ value, line: startLine });
  }

  /**
   * Trois appels dont le contenu n'est jamais montré à personne, et que la
   * garde doit donc traverser sans rien relever :
   *
   *   `logger.*()`   — la journalisation Pino, `log.*()` compris (un logger
   *                    enfant, dans le worker). La langue du projet est le
   *                    français, c'est écrit dans le brief, et un opérateur qui
   *                    lit `docker compose logs` n'est pas un utilisateur.
   *   `console.*()`  — les avertissements de démarrage, même statut.
   *   `new Error()`  — un invariant de programmation. Il n'a pas d'écran ; s'il
   *                    s'affiche un jour, c'est déjà un bug plus grave que sa
   *                    langue. Les erreurs *destinées* à l'utilisateur passent
   *                    par `HttpError` et ses sous-classes, qui ne sont pas
   *                    couvertes par cette exception.
   *
   * On saute l'appel entier, parenthèses équilibrées, en respectant les
   * chaînes qu'il contient — sinon une parenthèse dans un message fermerait le
   * comptage trop tôt.
   */
  function atIgnoredCall() {
    // En début de mot seulement : `dialog.info(` n'est pas un appel à `log`.
    if (i > 0 && /[\w$]/.test(source[i - 1] ?? '')) return false;
    const rest = source.slice(i, i + 40);
    return (
      /^(?:logger|log)\s*\.\s*(?:trace|debug|info|warn|error|fatal)\s*\(/.test(rest) ||
      /^console\s*\.\s*\w+\s*\(|^new\s+Error\s*\(/.test(rest)
    );
  }

  function skipCall() {
    while (i < n && at() !== '(') advance();
    let depth = 0;
    while (i < n) {
      const c = at();
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        advance();
        if (depth === 0) return;
        continue;
      } else if (c === "'" || c === '"') {
        const quote = c;
        advance();
        while (i < n && at() !== quote) {
          if (at() === '\\') advance();
          advance();
        }
      } else if (c === '`') {
        advance();
        while (i < n && at() !== '`') {
          if (at() === '\\') advance();
          advance();
        }
      }
      advance();
    }
  }

  while (i < n) {
    const c = at();

    if ((c === 'l' || c === 'c' || c === 'n') && atIgnoredCall()) {
      skipCall();
      continue;
    }

    if (c === '/' && at(1) === '/') {
      while (i < n && at() !== '\n') advance();
      lastSignificant = ';';
      continue;
    }
    if (c === '/' && at(1) === '*') {
      advance(2);
      while (i < n && !(at() === '*' && at(1) === '/')) advance();
      advance(2);
      continue;
    }

    /**
     * Une expression régulière, avalée en bloc.
     *
     * Sans ce cas, `/(`+'`'+`[^`+'`'+`]+`+'`'+`|\\*\\*[^*]+\\*\\*)/g` ouvrait un faux gabarit :
     * le lexer partait à la recherche d'un backtick fermant et engloutissait
     * les quatre-vingts lignes suivantes, commentaires compris, qu'il rendait
     * ensuite comme une chaîne « française ». La garde accusait alors le seul
     * fichier qui avait pris la peine de se rendre traduisible.
     *
     * Distinguer une expression régulière d'une division demande le contexte :
     * après une valeur (`)`, `]`, un identifiant, un nombre) le `/` divise ;
     * après un opérateur, une virgule ou une ouvrante, il ouvre une regex.
     */
    if (c === '/' && startsRegex()) {
      advance();
      let inClass = false;
      while (i < n) {
        if (at() === '\\') {
          advance(2);
          continue;
        }
        if (at() === '[') inClass = true;
        else if (at() === ']') inClass = false;
        else if (at() === '/' && !inClass) {
          advance();
          break;
        } else if (at() === '\n') break;
        advance();
      }
      while (i < n && /[dgimsuvy]/.test(at() ?? '')) advance();
      lastSignificant = ')';
      continue;
    }

    if (c === "'" || c === '"') {
      readQuoted(c);
      lastSignificant = ')';
      continue;
    }
    if (c === '`') {
      readTemplate();
      lastSignificant = ')';
      continue;
    }

    /**
     * Texte JSX. On ne suit pas la grammaire : on relève ce qui sépare un `>`
     * d'un `<`, d'un `{` ou d'un autre `>`. Un `a > b` en code produit un
     * fragment sans mot français, donc sans conséquence.
     *
     * Le balayage s'arrête aussi sur un début de commentaire : sans cela, un
     * `=>` suivi d'un bloc `/** … *\/` ferait passer la prose du commentaire
     * pour du texte affiché — et la garde signalerait des commentaires, ce
     * qu'elle n'a aucun droit de faire.
     *
     * Les fichiers `.ts` n'ont pas de JSX du tout : on ne le cherche pas.
     */
    if (c === '>' && jsx) {
      const startLine = line;
      advance();
      let value = '';
      while (
        i < n &&
        at() !== '<' &&
        at() !== '{' &&
        at() !== '>' &&
        at() !== '`' &&
        !(at() === '/' && (at(1) === '/' || at(1) === '*'))
      ) {
        value += at();
        advance();
      }
      if (value.trim() !== '') jsxTexts.push({ value: value.trim(), line: startLine });
      lastSignificant = '>';
      continue;
    }

    if (!/\s/.test(c)) lastSignificant = c;
    advance();
  }

  return { strings, jsxTexts };
}

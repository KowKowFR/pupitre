# Pupitre · Design system

The new design system of **Pupitre**, a self-hosted control plane that deploys your applications to your machines, over SSH, with Docker Compose or K3s, from the same description.

## Contents

- `png/`: the 50 boards at full size (1440 px wide), plus 24 captures of open states (`*-drawer.png`, `*-palette.png`, `*-purge.png`…).
- `canvas/`: the boards' sources (`*.dc.html`), the `canvas.json` index and `support.js`, the engine that displays them.
- `tokens/`:
  - `pupitre.css`: all the light and dark tokens, with the component classes.
  - `tailwind-theme.css`: the Tailwind v4 theme, ready to paste.
  - `tokens.json`: the same tokens in JSON.
- `brand/`: the logo in SVG and PNG (ultramarine, dark, graphite tile, glyph alone), `favicon.svg`, `favicon-32.png` and `apple-touch-icon.png`.
- `KIT.md`: the system's rules. `DATA.md`: the sample data.
- `CLAUDE_CODE_PROMPT.md`: the migration prompt to give to Claude Code.

The boards show the panel in French, its first language: the screens they designed are bilingual today, and their English wording lives in the dictionaries (`apps/web/src/i18n`).

## Opening the boards locally

The boards must go through a small local server: double-clicking the file is not enough.

    cd canvas
    python3 -m http.server 8000

Then open http://localhost:8000/Main.dc.html (the table of contents, with links to every board).

The fonts (Instrument Sans and Geist Mono) are loaded from Google Fonts. Without an internet connection, the browser shows a fallback font.

## Playable boards (26)

- **Application screens**: in all of them, ⌘K (the "Search, run…" button) opens the palette, which filters as you type. Start the input with `›` to keep only the commands.
- **Targets, Applications, Deployments, Probes, Log**: clicking a row opens the animated drawer.
- **Dialogs**: purge, destruction, thresholds, cadence, 2FA reset, skipping or leaving the setup guide.
- **Toasts**: they have a 5 s timer bar.
- **FoundMotion**: a sandbox for every animation.

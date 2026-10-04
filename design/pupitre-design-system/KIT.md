# Pupitre design system · KIT

## Concept

A music stand (*pupitre*) holds the score. Here, the AppSpec is the score, and Docker Compose or K3s perform it. The logo is a P whose bowl is the tilted board of a lectern, with two staff lines.

## Tokens

- **Scales.** Graphite (N0 to N950) and ultramarine (O50 to O900).
- **Semantic tokens**: `bg`, `bg-subtle`, `surface`, `surface-2`, `surface-3`, `border`, `border-strong`, `text`, `text-2`, `text-3`, `accent`, the `ok`, `warn`, `danger` and `idle` tones (each with its `-soft`, `-line` and `-text` variants), `sev-*` and `term-*`.
- **Two complete themes.** The dark theme is turned on with the `.dark` class. The System, Light or Dark choice is made in the user menu.
- **Radii**: 4, 6, 8, 12 and 14 px, plus `999` for the pills.
- **Shadows**: `xs` (cards), `sm` (active element), `md` (menus and toasts), `lg` (drawer and dialog).
- **Motion.**
  - Curves: enter `cubic-bezier(.16,1,.3,1)`, exit `cubic-bezier(.5,0,.75,0)`, standard `cubic-bezier(.2,0,0,1)`.
  - Durations: 120, 180, 240 and 320 ms.
  - The drawer enters in 320 ms, with its sections cascading every 40 ms, and exits in 200 ms.
  - The dialog and the palette enter in 240 ms. Toasts have a 5 s timer.

## Typography

- **Instrument Sans** for the UI. Headings are slightly condensed (width 88 to 96 %).
- **Geist Mono** for identifiers.
- **Scale**:

  | Role | Size / line height |
  |---|---|
  | Caption | 12/16 |
  | Tables | 13/20 |
  | Body | 14/20 |
  | Section | 15/22 |
  | Heading | 18/26 |
  | Drawer | 20/28 |
  | Page | 24/32 |
  | Readout | 26/32 |
  | Documentation boards' title | 48/52 |

## Shell

| Zone | Dimensions |
|---|---|
| Rail | 240 px |
| Top bar | 52 px, with breadcrumb, worker and help |
| Content | 1200 px at most, padding 28/32 |
| Drawer | 540 px (680 when wide), inset 8 |
| Dialog | 460 px |
| Palette | 640 px |

## Invariants

1. Color tells a state, never a category. Ultramarine is for interaction and for what is in progress.
2. Every state reads without color: a led has a label, a badge has a text, a chart has a summary.
3. Identifiers are in mono.
4. A disabled button says why, in plain words.
5. A destructive action goes through a dialog that lists its consequences. Destroying asks to type the name again.
6. What a permission forbids disappears: it is not greyed out.
7. A single primary action per zone.
8. Every screen must hold in French as in English.
9. `prefers-reduced-motion` is respected.
10. A preview opens in a drawer, long work happens on a page. ⌘K is available everywhere.

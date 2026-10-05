# Claude Code prompt: migrating Pupitre to the new design system

> Copy everything below into Claude Code, at the root of the Pupitre repository.
> First place the `pupitre-design-system/` folder (the unzipped archive) in `design/`, at the root of the repository.
>
> This prompt drove the migration that is now done (branch `feat/design-system`). It is kept as the record of what was asked. The boards show the panel in French; the English wording of each screen lives in the dictionaries.

---

You are going to migrate **Pupitre**'s interface to its new design system. Pupitre is a self-hosted control plane that deploys applications to machines, over SSH, with Docker Compose or K3s, from an AppSpec.

This is a **visual and interaction redesign**. The business logic, the APIs, the server actions, the permissions, the routes and the database schema do not change. If a mockup seems to require a logic change, stop and report it instead of making it up.

## 0. Sources of truth (read them before writing code)

| File | Role |
|---|---|
| `design/pupitre-design-system/tokens/pupitre.css` | Complete reference: light and dark tokens, plus every component class. It is the expected behavior, down to the pixel. |
| `design/pupitre-design-system/tokens/tailwind-theme.css` | Ready-to-use Tailwind v4 theme: variables, `@theme inline`, keyframes, reduced-motion. |
| `design/pupitre-design-system/tokens/tokens.json` | The same tokens in JSON. |
| `design/pupitre-design-system/png/*.png` | The 50 boards at full size. The `*-drawer.png`, `*-palette.png`, `*-purge.png`… files show the open states. **Open each screen's PNG before coding it.** |
| `design/pupitre-design-system/canvas/*.dc.html` | The boards' sources: readable HTML with the exact texts, the classes and the structures. Useful to copy a label or a structure. |
| `design/pupitre-design-system/KIT.md` | The system's rules, in prose. |
| `design/pupitre-design-system/brand/` | Logo (SVG and PNG), favicon, apple-touch-icon. |

Key boards per screen:

| Screen | Boards |
|---|---|
| `/` | `AppDashboard`, `AppDashboardDark` |
| `/targets` | `AppTargets` (+ `-drawer`, `-drawer-warn`, `-palette`) |
| `/targets/:id` | `AppTarget` |
| `/applications` | `AppApplications` (+ `-drawer`, `-delete`) |
| `/applications/new` | `AppAppNew` |
| `/apps` | `AppSupervision` (+ `-thresholds`) |
| `/apps/:id` | `AppConsole` (+ `-destroy`) |
| `/deployments` | `AppDeployments` (+ `-drawer`, `-drawer-live`, `-purge`) |
| `/deployments/:id` | `AppDeployment` |
| `/monitors` | `AppMonitors` |
| `/monitors/:id` | `AppMonitor` |
| `/jobs` | `AppJobs` (+ `-cadence`) |
| `/admin/logs` | `AppLogs` |
| `/admin/users` | `AppUsers` |
| `/admin/roles` | `AppRoles` |
| `/admin/settings` | `SetOverview`, `SetNotifications` |
| `/account` | `AppAccount` |
| `/login` and the whole access group | `AuthSignIn`, `AuthTotp`, `AuthFlows` |
| `/onboarding` | `AppOnboarding` |
| Loading, empty and error states | `StateLoading`, `StateEmpty`, `StateErrors` |
| Mobile | `MobScreens` |

Components: `CompButtons`, `CompForms`, `CompSelection`, `CompBadges`, `CompData`, `CompNav`, `CompOverlays`, `CompDrawer`, `CompPalette`, `CompFeedback`, `CompCharts`, `CompTerminal`. Patterns: `PatPrinciples`, `PatPermissions`, `PatDestructive`.

## 1. Direction (to follow strictly)

- **Colors.** Cool graphite for the structure, **ultramarine `#2E44D6`** (dark: `#7F92FF`) for interaction, selection and what is "in progress". Green, amber and red are reserved for state, never for decoration. The old `signal` token (petrol blue) goes away.
- **Typography.**
  - **Instrument Sans** for the UI. Headings use `font-stretch: 88–96 %` and negative letter spacing.
  - **Geist Mono** for every identifier: slug, host, port, version, date, permission key, log.
  - IBM Plex Sans, IBM Plex Sans Condensed and JetBrains Mono are removed.
  - Load both fonts with `next/font/google`: `Instrument_Sans` with the `wdth` and `wght` axes, `Geist_Mono`.
- **No more uppercase overlines** (eyebrow). The top bar's breadcrumb replaces them. A readout's label is in sentence case.
- **Density.** Body at 14 px, tables at 13 px, captions at 12 px. The page title goes to 24/32, a drawer's to 20/28.
- **Radii.** 8 px for controls, 12 px for cards, 14 px for drawers and dialogs, 6 px for badges.
- **Logo.** Replace the signal square with the Pupitre tile (`brand/pupitre-mark.svg`) in the rail, the access screens, the favicon and the emails.

## 2. Setup (phase 1)

1. Bring `tailwind-theme.css` into `app/globals.css`, replacing the current OKLCH tokens. Keep the names shadcn expects (`--background`, `--foreground`, `--primary`, `--border`, `--ring`…) as **aliases** of the new tokens, so that the existing primitives keep compiling:

   ```css
   :root {
     --background: var(--bg);
     --foreground: var(--text);
     --card: var(--surface);
     --primary: var(--accent);
     --primary-foreground: #fff;
     --muted: var(--surface-3);
     --muted-foreground: var(--text-3);
     --border: var(--border);
     --input: var(--border-strong);
     --ring: var(--accent);
     --destructive: var(--danger);
   }
   ```

2. **Theme.**
   - It still follows the system by default.
   - **New:** a System / Light / Dark choice in the user menu (see `CompNav`). It is persisted in a cookie and applied with a `.dark` or `.light` class on `<html>`, without a flash at load.
   - The terminal stays dark in both themes.
3. Replace the fonts, the favicon (`brand/favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`) and the logo.
4. Remove the dead tokens and utilities of the old system: `signal*`, `ground*`, `ink/muted/faint` and the condensed families.

## 3. Primitives (phase 2)

Rewrite `components/ui/*` from `pupitre.css` and the Comp* boards. Keep the shadcn APIs.

- **Button.**
  - Variants: `default` (ultramarine), `secondary`, `ghost`, `destructive` (outlined: red text, pale red border), `destructive-solid` (reserved for the final confirmation of a destruction), `link`.
  - Sizes: `sm` 28, default 32, `lg` 40, `icon` 32. On touch screens, targets are at least 44 px.
  - Press: `translateY(.5px) scale(.985)`.
  - `loading` prop: spinner and "…" label.
  - `disabledReason` prop: when given, the button is disabled and shows the reason on a `text-cap text-3` line under the row. It is an invariant.
- **Badge.** 20 px, soft background and a border of the same hue. Variants `ok`, `warn`, `danger`, `accent`, `outline`, `solid`, `count`. `dot` option.
- **Led** (the new name of the old indicator). 8 px with a 3 px halo of the same hue at 20 %, through `color-mix`. Tones `ok`, `warn`, `danger`, `accent`, `idle`, `hollow`. `pulse` is only allowed for "in progress".
- **Input, Textarea, Select.**
  - Input 34 px, with an ultramarine focus, a 3 px ring and an `aria-invalid` state.
  - Native select with a data-URI chevron.
  - `Field` (label, help, error with icon) and `SecretInput` components (always empty when editing, explanatory placeholder, Show button).
  - `OtpInput`: 6 boxes, spacing after the 3rd, `inputmode=numeric`, `autocomplete=one-time-code`.
- **Selection.** 16 px Checkbox (mixed state included), Radio, 32×18 Switch with the `ease-out` curve, SegmentedControl, Tabs underlined in ultramarine with a counter, FilterChip with a counter.
- **Identifiers and labels.** `CodeBadge`, `TargetLabelChip` (hue derived from the text among 6 colors, never green, amber or red), `RuntimePill`, `SeverityBadge`.
- **Surfaces.** `Card` (with `CardHeader`, `CardFooter` in `surface-2`), `Table` (36 px header in `surface-2`, 48 px rows or 40 when dense, clickable `tr`, selected state with a 2 px ultramarine left rule), `KeyValue`, `Readout`, `ReadoutBar`, `EmptyState`, `Skeleton` with shimmer.

## 4. Animated layers (phase 3, the heart of the redesign)

Use the Radix primitives already present through shadcn: Dialog, Tooltip, DropdownMenu, Popover. Animate them with the `data-state` attributes and the theme's keyframes (`pp-drawer-in/out`, `pp-dialog`, `pp-cmdk`, `pp-pop`, `pp-toast`, `pp-rise`). **No animation library is needed.** Everything must respect `prefers-reduced-motion`.

1. **Drawer** (`components/ui/drawer.tsx`, based on `Dialog`, see `CompDrawer` and `AppTargets-drawer.png`).
   - Geometry: right-hand panel, 8 px inset, 540 px wide (680 when `wide`), radius 14, `lg` shadow.
   - Scrim: light (`--scrim-soft`), **over the content only** (`left: 240px`). The rail stays visible.
   - Motion: enters in 320 ms `ease-out` (48 px and fade), exits in 200 ms `ease-in`. The body's sections appear in cascade (`animation-delay` of 40 ms per child, `pp-rise`).
   - Header: context (icon, type, route in mono), ↑ and ↓ buttons (previous and next row, K and J shortcuts), full page, close (esc). Title in 20/28, then a state line.
   - Footer: primary action first, "Open the record" link on the right. A "Sensitive zone" at the bottom of the body holds the deletions.
   - URL state: sync the open item in the URL (`?target=prod-1`, `?run=127`…) to allow sharing and the back button.
   - Below `lg`, the drawer becomes a **bottom sheet** (see `MobScreens`).
   - **Where to use it**: previewing a row of Targets, Applications (with quick deployment), Deployments (summarized pipeline), Probes, Log (JSON payload), inviting a user, editing a notification channel. The existing detail pages stay: the drawer is a preview, the page is the place for long work.
2. **Confirmation dialog** (`CompOverlays`, `PatDestructive`).
   - Geometry: 460 px (560 when wide), 28 % scrim with a 2 px blur. Enters with `pp-dialog` in 240 ms, exits in 160 ms.
   - Content: the title is a question that names the object and the place. The body gives the consequences as a bulleted list. Footer in `surface-2`, with "Cancel" (ghost) then the verb. Initial focus goes to Cancel for a destructive action.
   - Three levels: reversible (primary), loss of history (outlined destructive), loss of data ("Type {name} again" field and `destructive-solid`, disabled until the input matches exactly).
3. **⌘K palette** (`CompPalette`, `AppTargets-palette.png`). Use **`cmdk`**, through shadcn's `Command`.
   - Opening: ⌘K or Ctrl K everywhere, plus the "Search, run…" button at the top of the rail. 640 px, 96 px from the top, enters with `pp-cmdk`.
   - Groups: Suggestions, Go to, Objects, Preferences. An empty group is hidden.
   - Object search: targets, applications, runs (`#127`), probes. Create a `GET /api/search?q=` route (or a server action) that reuses the existing queries, **filtered by permission**.
   - A `›` prefix keeps only the commands.
   - Item: 28 px icon tile, title, meta, "Open" or "Run" verb with ↵ on hover or when active.
   - A forbidden command does not appear.
   - Global shortcuts: `G` then `D`, `C`, `A`, `P` or `S` to navigate, `?` to show the list of shortcuts, `J` and `K` in lists.
4. **Tooltip.** 260 ms delay, `n900` background (light on dark), 12/16, 120 ms entrance. Mandatory on every icon button, with an `aria-label`. Can contain a `Kbd`. **Never the sole carrier of an essential piece of information.**
5. **Menus and popovers.** Radius 11, `md` shadow, `pp-pop` entrance in 180 ms. Items are 32 px, with a shortcut or a meta on the right. A destructive item is red and placed last, after a separator.
6. **Toasts.** Use **`sonner`** (themed) or a home-made component.
   - Geometry: 360 px, bottom right. Tone icon, title, subline, optional action (Follow, Undo), close button.
   - **5 s timer bar** in ultramarine at the bottom. Paused on hover. An error stays displayed. Three toasts at most.
   - The text repeats the verb of the button that triggered it ("Deployment queued").

## 5. Shell (phase 4, see `CompNav`)

- **Rail**
  - 240 px, `bg-subtle` background, right border.
  - At the top: instance block (28 px tile, name, tagline, chevron toward an instance menu), then the ⌘K search button.
  - "Operations" groups (Overview, Targets, Applications, Monitoring, Deployments, Probes, Jobs) and "Administration" (Log, Users, Roles, Settings).
  - 32 px items. The active state uses the `surface` background, the `sm` shadow and an ultramarine icon. The old vertical marker disappears.
  - Metas on the right: counters, a red counter for anomalies, a pulsing led if a deployment is in flight.
  - Footer: **"Setup n of 7" card** with a progress bar. It replaces the resume banner, which appeared at the top of every page. Then the user block (avatar, name, role, menu: My account, Theme, Shortcuts, Documentation, Sign out).
- **Top bar**
  - 52 px.
  - Breadcrumb on the left (instance / section / object).
  - On the right: "Worker active" pill (led and tooltip "last heartbeat…"), Documentation, Shortcuts.
- **PageHeader**
  - Title 24/32, description of at most 68 characters per line, actions on the right.
  - No more overline. The current PageHeader loses its eyebrow.
- **Content**: padding 28/32, maximum width 1200 px.
- **Below lg**: sticky blurred top bar, flat navigation scrolling horizontally, drawers as bottom sheets (`MobScreens`).

## 6. Screens (phase 5, one by one, comparing with the PNG)

For each screen: open its PNG and those of its states, reproduce it with the primitives, then check the three profiles (admin, operator, viewer). Notable changes compared with today:

- **Overview.**
  - Attention block: red left rule, led rows, subject in mono, detail and verb.
  - "The last 24 hours" card: 4 readouts, then 4 tracks on a shared axis (RatioBars, SeriesLine with a dashed threshold, EventRail with tooltips).
  - Wider Machines panel: 240 px sparkline, number of apps, runtime, mini gauges.
  - Running and Latest deployments side by side, then the inventory bar.
  - "Deploy" button (shortcut D) that opens the palette.
- **Targets.**
  - Status chips with counters, search and labels.
  - New "24 h load" column (sparkline and mini gauges).
  - Actions as icons with a tooltip.
  - **Clicking a row: drawer.**
  - Deletion is in the drawer's "Sensitive zone", disabled with its reason.
- **A target's record.**
  - Title with the state.
  - Tabs Overview, Workloads (n), Ports (n/m), Preflight, Configuration.
  - A band of 4 readouts, then Runtimes and Ports (gauge and table), then "What is running" and Preflight.
- **Applications.**
  - "Automatic rollback" switch at the top.
  - "Running on" column.
  - Drawer with the spec's review and quick deployment.
  - Deletion through the level 3 dialog.
- **New application.** Two columns: input (AI or JSON tabs, then deployment right after) on the left, "What will run" review and JSON on the right.
- **Monitoring.** One card per server: band of readouts in `bg-subtle`, breach alert, apps table. Thresholds dialog.
- **App console.**
  - "Operations" card in the header.
  - 352 px left column (Services, Release, Machine, Probe).
  - Dark terminal: title bar, separate filter bar, error lines with a rule.
  - **Translate along the way every text hard-coded in French**: it must go through the i18n like the rest of the panel.
- **Deployments.**
  - Filter chips.
  - Ultramarine selection bar (purge).
  - Disabled boxes with their reason in a tooltip **and** in the bar.
  - The run's drawer.
  - Pagination with buttons.
- **A run's detail.**
  - Summary card with a 3 px progress bar at the bottom.
  - Pipeline, Security, Frozen AppSpec tabs.
  - Vertical pipeline in `.steps` (succeeded in green, in progress in ultramarine with a spinner, failed in red with an error inset, not applicable dotted).
  - Terminal at the same height as the pipeline.
- **Probes.** A list of row cards: name and type, state, one-hour strip, latency, 24 h and 7 d rates, actions. A red incident banner or an amber notice banner built into the card.
- **A probe's record.** Four readouts, then the latency with hatched no-answer zones (broken line), then the incidents timeline (captures before and during).
- **Jobs.** Table, then the Cadence dialog (Simple or Expert segmented control, day pills, preview of the next occurrences).
- **Log.** Filters in a grid, refusals as a red mono badge. Clicking a row: drawer with the indented JSON payload.
- **Users.** Table with avatars and an inline role select. Invitation in a drawer (with the "What … receives" preview). "Reset 2FA" dialog.
- **Roles.** Expandable cards. The permissions are grouped in fieldsets, and a checked box takes the `surface-2` background.
- **Settings.** 216 px section navigation with icons. The Summary is in term/value cards. Notifications: channels as a list, editing in a drawer.
- **Access.**
  - Shell with a 48 px grid faded into an ellipse, with the logo and the "pupitre" wordmark.
  - 400 px card, radius 14, `md` shadow.
  - OTP in 6 boxes.
  - Every state is in `AuthFlows`.
- **Setup guide.** Thin header, stepper on the left (green, ultramarine or amber pills), step card, Skip and Leave dialogs.
- **States.** Skeletons with the exact silhouette (`StateLoading`), empty states with an icon tile (`StateEmpty`), system pages (`StateErrors`).

## 7. Invariants (to check on every screen, blocking in review)

1. Red, amber and green only serve state. Ultramarine only serves interaction, selection and what is in progress.
2. Every state reads without color: a led always has a label next to it (or a tooltip in a very dense list), a badge has a text, a chart has a summary and an equivalent table.
3. Technical identifiers are in Geist Mono.
4. A disabled button shows its reason in plain words, not only in a tooltip.
5. Every destructive action goes through a dialog that lists its consequences. Destroy and Force delete ask to type the name again.
6. What a permission forbids **disappears** (rail, buttons, tracks, ⌘K commands). Nothing is greyed out for that.
7. A single primary action per zone.
8. French is often 15 to 30 % longer: test every screen in `fr` **and** in `en`.
9. `prefers-reduced-motion`: no more sliding, no more shimmer, no more pulsing.
10. Accessibility: visible focus (3 px ring), `aria-label` on icon buttons, `role="dialog"` and `aria-modal`, focus trap in the layers, esc to close, AA contrast (`text-3` is calibrated for 4.5:1).

## 8. Way of working

- Move forward **phase by phase**, with one commit per phase: `feat(ui): tokens & fonts`, `feat(ui): primitives`, `feat(ui): overlays (drawer, dialog, cmdk, toasts)`, `feat(ui): app shell`, then one commit per screen.
- Before each phase, give in 5 lines at most what you are going to touch. After each screen, take a capture (Playwright if available) and compare it with the board's PNG. List the remaining gaps.
- Create no heavy dependency. Only `cmdk` and `sonner` are accepted if they are missing.
- Keep the existing tests green. Add rendering tests for: Button `disabledReason`, permission-based hiding of the rail and the palette, Drawer (opening and closing, esc, URL sync), confirmation by typing the name.
- Finish with a **report**: migrated screens, accepted gaps, suggested follow-ups.

Start with phase 1: read the token files and 3 PNGs (`AppDashboard`, `AppTargets-drawer`, `CompButtons`), then propose your plan for changing `globals.css` and the fonts configuration before writing.

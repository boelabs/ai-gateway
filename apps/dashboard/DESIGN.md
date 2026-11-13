# AI Gateway Dashboard — Design Guidelines

Source of truth for how the operator dashboard looks and is built. Read it before adding a screen
or component; follow it exactly. When something is missing here, extend this document in the same
change instead of improvising.

The dashboard is a sibling of Billete's (`billete/apps/dashboard/DESIGN.md`): same tokens, same
vendored coss UI primitives, same shell, same page anatomy. A screen that would look out of place in
Billete is wrong here too. Product behavior, permissions, API contracts and server boundaries remain
AI Gateway's own; the shared appearance never introduces a dependency on Billete.

The visual language is **quiet, dense and precise**: neutral surfaces, one accent (the primary
neutral), soft hairline borders, rounded panels, tabular numbers. Color only carries meaning
(status, chart series), never decoration.

## 1. Foundations

### Stack

- **coss UI** primitives (Base UI + Tailwind CSS), vendored in `src/components/ui/primitives`.
  Treat them as a library: extend with variants in the component file, never fork a copy.
  `src/components/ui/<component>.tsx` adapts them to the dashboard's callers (`label`/`description`
  props on fields, `variant="secondary"` for coss `outline`…). Import from `#/components/ui/<name>`.
- **New components:** reuse or compose the local kit first. If one is missing, take coss UI's
  official component, example or particle ([coss.com/ui/docs](https://coss.com/ui/docs)) — or
  Billete's vendored copy, which is the same source — into `primitives`, keeping Base UI's behavior
  and accessibility. Only build from scratch when coss has nothing suitable, following its geometry,
  states, focus and keyboard patterns.
- **Particles first.** coss particles (card radios, inputs with badges, segmented meters, stat
  blocks…) are the default answer to "how should this block look". Reach for one before writing a
  bespoke layout. [efferd](https://efferd.com), [blocks.so](https://blocks.so) and
  [7ovr](https://7ovr.com) are references for *which blocks* to build (stat rows, meters, empty
  states), never for their visual design: the result is always built from coss primitives and
  these tokens.
- **Icons:** [Phosphor](https://phosphoricons.com) only, imported from
  `@phosphor-icons/react/dist/ssr` by their `…Icon` names (`CaretDownIcon`, not the deprecated
  `CaretDown`) — the SSR build renders in Server and Client Components alike. Regular weight;
  `weight="bold"` only where a small glyph must hold its own (the composer's send and attach).
  `aria-hidden` when decorative, sized with `size-*` classes; the type of an icon prop is `Icon`
  from `@phosphor-icons/react`. The
  AI Gateway logotype (`AiGatewayLogo`) is the one brand asset; never set the product name in the UI font.
- **Charts:** Rosen Charts' approach (rosencharts.com): `d3-scale`/`d3-shape` for the math only,
  drawn as plain SVG + HTML in `src/components/ui/chart.tsx`. No charting library.
- **Font:** Google Sans Flex, the only UI font, headings included (`src/shared/fonts`). Google Sans
  Code for identifiers and code. Never set a font family anywhere else.

### Tokens (never raw palette classes)

| Purpose | Token classes |
| --- | --- |
| Page background | `bg-background` |
| Primary text / secondary text | `text-foreground` / `text-muted-foreground` |
| Subtle fills, hovers | `bg-muted`, `bg-accent`, `hover:bg-accent/50` |
| Hairlines | `border` (inherits `--border`) |
| Primary action / selected nav | `bg-primary text-primary-foreground`, `bg-primary/10 text-primary` |
| Status | `success`, `warning`, `destructive`, `info` (+ `-foreground`) |
| Charts | `var(--chart-1…5)` |

Light and dark tokens live in `src/components/ui/styles.css` and are Billete's, value for value.
Add a token there before using a new color. `--alpha()` is intentional Tailwind syntax. The older
aliases (`fg`, `fg-muted`, `surface`, `danger`…) resolve to these tokens; new code uses the
semantic names.

### Typography

| Use | Classes |
| --- | --- |
| Page title | `font-semibold text-xl` (`PageHeader`) |
| Section title | `font-semibold text-base` (`Section`) |
| Panel title | `font-semibold text-sm` (provided by `Panel`, `FrameTitle`, `CardTitle`) |
| Body | inherited: 14px, line-height 1.5 (`styles.css`); never set it per page |
| Secondary / helper | `text-muted-foreground text-sm` or `text-xs` |
| Big figures | `font-semibold text-2xl tabular-nums` |
| IDs, keys, model ids | `font-mono text-xs` |

Amounts, counts, durations and dates use `tabular-nums`.

### Spacing, radius, elevation

- Layout with `flex flex-col gap-*` / `grid gap-*`; never `space-*`.
- Page sections `gap-6`; panels of one form or one record `gap-3`; inside a panel and between form
  fields `gap-4`; inline items `gap-2`.
- Radius comes from the primitives: outer surfaces `rounded-2xl`, inner panels `rounded-xl`,
  controls `rounded-lg`. Do not add radius classes to primitives.
- **Nested radii are concentric:** an inner element's radius is its parent's radius minus the
  inset between them (padding plus border). Popup options use `--ui-radius-item`
  (`radius-lg − 5px`: a 1px border and 4px padding). Anything flush against a popup's edge (its
  search field) has no radius or border of its own; a hairline separates it.
- Options in a select, combobox or menu are as tall as the trigger that opened them (36px).
- Elevation is the primitives' built-in hairline shadow. No extra shadows, except popovers'
  `shadow-lg/5` on things that float over content.

### Controls

**Every clickable or editable element is at least 36px tall** — buttons, inputs, selects,
comboboxes, number fields, tabs, toggles, and the items of menus, selects and comboboxes — on
every screen size. Controls that deserve more weight (a dialog's or sign-in's main action, a
command palette's input) use 40–44px. The primitives encode this; never shrink a control below
36px with a class. Mobile controls use 16px text so iOS does not zoom.

| Adapter size | Height | Use |
| --- | --- | --- |
| `xs`, `sm` | 36px, tighter padding and gap | inside table rows, popups and dense toolbars |
| `md` (default) | 36px | page, form and toolbar controls |
| `lg` | 40px | prominent actions |
| `xl` (primitive) | 44px | hero actions |

The only controls smaller than 36px are affordances *inside* another control (the × that clears a
search field, a combobox's chevron, a chip's remove button): the 36px control around them is the
target. Checkboxes, radios and switches are 16–20px marks, but their label is part of the hit
target, so the row they sit in is at least 36px. The playground composer keeps its own geometry
(§8).

Page, form and toolbar controls (search, filters, export, header buttons) use the default size,
matching the inputs beside them.

**Dates are picked with `RangeFilter`** (`#/shared/components/RangeFilter`): one button saying the
range in force, opening coss's popover with the presets on the left and a range `Calendar`
(`#/components/ui/calendar`) on the right; presets apply at once, custom dates on *Apply*. Never a
plain select of periods plus native date inputs. Filters sit in one toolbar row, never inside a
card or frame of their own.

Button variants (adapter names, coss names in parentheses):

- `primary` (`default`): the single main action of a page, form or dialog.
- `secondary` (`outline`): every other decision — *Cancel*, *Back*, *Disable*, *Load more*, a
  report or secondary page linked from a list.
- `danger-outline` (`destructive-outline`): destructive actions in a page header (*Delete*,
  *Revoke*). `danger` (filled) only for the confirm button of a destructive dialog.
- `ghost`: where a border would fight the surface — icon buttons inside a field or a row, the
  shell's chrome (search, menu, close), option lists inside a popup.
- `link`: a quiet text action that is not one of the decisions in front of the operator (*View
  all*, *Change*).

Icon-only buttons are square (`mode="icon"`) and always have an `aria-label`.

## 2. Surfaces

- **`Frame`** is the default container: a muted tray (`rounded-2xl bg-muted/72 p-1`) holding one or
  more `FramePanel`s (`rounded-xl border bg-background p-5`). Use it for stat tiles, tables, detail
  lists, charts and form sections.
- **`Panel`** (`src/shared/components/Panel.tsx`) is a `Frame` with its title, description and
  action in the tray and the content in the panel: every titled block (a form section, a detail
  list, a table with a heading). `flush` drops the padding for edge-to-edge content.
- **`Card`** is for standalone, self-contained flows: sign-in, confirmations.
- **`Dialog`** only for short create/edit forms (**six fields or fewer**), confirmations and
  show-once secrets. Longer or multi-section editors get their own page. Records are inspected and
  edited on their own pages with real URLs, never in a modal or side sheet. A dialog is coss's:
  `DialogTitle` (20px, `leading-none`) and `DialogDescription` 8px under it, never a hand-written
  heading; the body starts 4px under the header; the close ✕ sits at the top right; the footer is
  the muted strip with *Cancel* (outline) and the single primary submit.
- A `Panel`'s content fills its frame: panels side by side in a grid row share one height, and
  the shorter one's panel stretches rather than leaving its tray empty below. No gutter is reserved
  for a label that has nothing to name (one overall bar takes the full width).
- Never nest a `Frame` inside a `Frame` or a `Card` inside a `Card`. Tables and empty states inside
  an existing panel use their plain variant. No decorative fieldsets.

## 3. App shell

Billete's shell, value for value (`src/features/shell`):

```
┌ Sidebar (268px) ──┬──────────────────────────────────────────────────┐
│ ◠ AI Gateway      🔍 │                                                  │
│ ───────────────── │  main: max-w-6xl, p-4/6, pb-12/16, gap-6        │
│ Overview          │                                                  │
│ Metrics           │                                                  │
│ Gateway           │                                                  │
│   Models …        │                                                  │
│ Administration    │                                                  │
│   Extensions …    │                                                  │
│ ───────────────── │                                                  │
│ (A) admin      ⇅  │                                                  │
└───────────────────┴──────────────────────────────────────────────────┘
```

- **The page ends with room to spare.** The main column pads its sides and top 16/24px and its
  bottom 48/64px (phone/desktop), in the shell, so no page adds its own: a last panel 24px from
  the window's edge reads as stuck to it. Pages that fill the viewport (`data-fill-viewport`) keep
  the tight padding.
- **No header.** The desktop sidebar is `--app-sidebar-width` (268px, shared with Billete), with no
  collapsed mode. Top: the logo (link to Overview) and a quiet square search button, separated
  from the navigation by a hairline. Middle: the navigation groups in a `ScrollArea` with
  `scrollFade` and the thin `edge` scrollbar. Foot: *Documentation* (`DocsLink`, only when
  `DOCS_URL` is set; it leaves the dashboard, so it opens in a new tab with a quiet ↗ and says so to
  screen readers; the palette lists it under *Help*), then the operator (`UserMenu`).
- **Navigation** is one list, `src/features/shell/navigation.ts` (`NAVIGATION`), read by the
  sidebar, the command palette and the keyboard shortcuts. Each entry declares the permissions it
  needs; an operator never sees a page whose calls would come back 403. Rows are quiet (`NAV_ROW`:
  `text-muted-foreground`, `p-2`, 16px icon); the open page is `bg-primary/10 text-primary`
  (`aria-current="page"`) and is active on every page nested under it (`/models/new`,
  `/models/<id>`). Group captions are `text-xs font-medium text-muted-foreground`. A new page joins
  the group of its area; a new group is for a new area. While the role is read, the sidebar draws
  every page as it is (names are static; never placeholders) and drops what the role cannot use
  once it is known; that first paint belongs to the prerendered shell, so it marks no page open.
- **Pinned and Recent** (`src/features/shell/RecentPages.tsx`, Billete's *Fijados* and
  *Recientes*): a record's page passes `recent` to its `Breadcrumbs` (its name: *batch-jobs*,
  *gpt-5 · openai*, *gpt-5 · 3f2a9c1e*), which remembers the visit and ends the trail in the pin
  button (*Pin to sidebar* / *Unpin*, `aria-pressed`). **Pinned** is a sidebar section right below
  the main pages, only once something is pinned, in pinning order; its rows are the title and the
  area in muted text (`areaOf`: *Models*, *API keys*, *Logs*), no icon, and on hover or focus the
  area gives way to an unpin button (always shown on touch screens). The latest visits live only
  in the command palette (*Pinned*, then *Recent*, never the page open), so the menu never moves
  under the pointer. Per operator, in this browser's `localStorage` (`src/shared/lib/browserStore.ts`,
  every access guarded); nothing depends on it.
- **Create menu:** a quiet square "+" beside the search, in the sidebar and the mobile bar. Its menu
  (*Create*) lists what the role can create (`CREATE_ACTIONS`), each with its shortcut as a
  `MenuShortcut` (`C D`); items navigate, never mutate. A role that creates nothing gets no button.
- **UserMenu** at the sidebar's foot: a 24px round initial (`bg-primary/10 text-primary`), the name
  in `font-medium` and a chevron; it opens upward, as wide as its trigger, with name and role, the
  theme as radio items with the check on the left (*Light theme*, *Dark theme*, *Automatic*),
  *Settings* (`G ,`), *Keyboard shortcuts* (`?`) and *Sign out* (destructive). Built on the coss
  menu primitives, not the adapter, so it renders exactly as Billete's.
- The Next.js dev indicator sits bottom-right (`next.config.ts`): the default corner covers the
  operator at the sidebar's foot.
- **Command palette:** the search button beside the logo (and in the mobile bar) or Ctrl/⌘+K opens
  one coss `CommandDialog` with the pages and the create actions the role allows. The trigger has
  no visible text; its accessible name and title carry the action and shortcut. Triggers reach the
  dialog through a Base UI handle (`CommandCreateHandle`), never by wrapping the app in a dialog
  root (that would make every other dialog a nested one, drawn without its backdrop).
- **Keyboard shortcuts:** `g` then a letter goes to a page (`NavItem.key`), `c` then a letter
  creates (`CREATE_ACTIONS`), `?` lists them (`Kbd` keycaps, uppercase). Keys typed in a field, an
  editable area, a menu, a list or a dialog are never shortcuts, nor any with Ctrl, ⌘ or Alt.
- **Phones:** a slim `MobileBar` — menu button, logo, then search and "+" right beside the logo —
  opens the same sidebar as a left `Sheet`.
- The shell never reads the pathname outside a `<Suspense>` boundary (it would block prerendering
  every dynamic route). A page that scrolls its own content (the playground) marks its root
  `data-fill-viewport` and gets the main column's exact height.

## 4. Page anatomy

Every page is built from the same pieces, in this order:

1. `Breadcrumbs` (`src/shared/components/Breadcrumbs.tsx`) — only on record and creation pages,
   back to their list (*Models › New*, *Models › gpt-5*).
2. `PageHeader` (`src/components/ui/page.tsx`) — `title`, one-line `description`, `badge` (a
   record's status) and `actions` on the right: one primary button at most, the rest `secondary`.
3. A toolbar row for lists (search and filters on one row that wraps), then the content: `Frame`s,
   `Panel`s, tables, charts, `StatCard` grids.

**List pages:** `PageHeader` with the create action as its primary button → `ListToolbar` → table
with pagination and a visible result count → empty state that says what the list is for and offers
the primary action. The toolbar has two sides: on the left the segment select (`ListSelect
kind="segment"`, filter icon: *All keys, Enabled, Disabled*) and the order select (`kind="sort"`,
arrows icon), 11rem each; on the right the search (16rem, icon inside), the other filters and the
buttons (*Export*, *Columns*, *Refresh*), all at the default control size. They share a row when the
toolbar fits them and wrap otherwise (a 40rem container query, not the window). Order is never a
header click: column headers are plain muted text, and a table that sorts locally shows the arrow
only on the sorted column. A narrowed list that comes back empty says so and
offers to clear the filters, never the first-use empty state. Filters live in the URL so a filtered
list survives reload, back and sharing. Table rows that have a page are links: the first column's
link stretches over the row (`after:absolute after:inset-0`), and the row's own controls (its menu)
sit `relative z-10` above it.

**Creation and record pages** (`/models/new`, `/models/[deployment]`, `/keys/new`, `/keys/[key]`,
`/logs/[id]`): `Breadcrumbs` → `PageHeader` (the record's name, its status badge, header actions:
destructive ones `danger-outline`, toggles `secondary`, at most one primary) → the form or the
record's body. An editable record's page is its form, pre-filled; a read-only record uses
`DetailLayout` (main column and an aside of `Panel`s holding `DetailList`s, side by side only when
the content area fits both — a container query, not the window).

**Settings:** `PageHeader` with only its title → the sections nav (a sticky column of titled groups
beside the content on wide screens, a row of tabs on phones) → the open section, one settings card
per group of values saved together. A card is a title and description, its fields, and a footer
with a note and *Save*, enabled only while the card differs from what it loaded. Each section is its
own URL under `/settings`.

**Overview and Metrics:** `PageHeader` with the period and refresh controls as its actions →
`StatCard` grids (as many columns as cards, up to four; label, value and tray each on one line) →
chart and table `Frame`s. The Overview is a glance: tiles and charts only. Per-model, per-key and
per-deployment tables belong to Metrics; an API key is named there by its name, never its id.

## 5. Shared components (use these, do not re-create them)

| Need | Component |
| --- | --- |
| Page title + actions | `#/components/ui/page` → `PageHeader` |
| Back trail on record and creation pages | `#/shared/components/Breadcrumbs` → `Breadcrumbs` |
| Titled content block, form section | `#/shared/components/Panel` → `Panel` |
| Titled block of a page above its own panels | `#/shared/components/Section` → `Section` |
| Body of a read-only record page | `#/shared/components/DetailLayout` → `DetailLayout` |
| Key/value details | `#/shared/components/DetailList` → `DetailList` (empty values read as —) |
| Full-page form footer | `#/shared/components/FormActions` → `FormActions` (error, *Cancel* link, single primary submit) |
| Metric tile | `#/features/observability/StatCard` → `StatCard` |
| Status of a resource | `#/components/ui/status` → `Status` (tone `success`, `warning`, `danger`, `neutral`, `muted`) |
| Tables | `#/components/ui/datatable` → `DataTable` (`rowHref` makes each row open its record); `#/components/ui/table` for bespoke ones |
| A row's secondary actions | `#/shared/components/RowActions` → `RowActions` (one "…" menu, destructive items set apart) |
| Nothing to show | `#/components/ui/page` → `EmptyState` (`icon`, title, description, action) |
| A list's toolbar | `#/shared/components/ListToolbar` → `ListToolbar` (`selects`, `controls`), `ListSelect` |
| Errors of a form or a page | `#/components/ui/page` → `ErrorNote`; route failures `RouteBoundary` |
| A list's search | `#/shared/components/SearchField` (icon inside, asks after a 300 ms pause, × clears; the term goes to the URL) |
| A group of settings saved together | `#/features/settings/SettingsCard` → `SettingsCard`, `SettingRow`, `SettingsCardSkeleton` |
| Model and deployment pickers | `#/shared/components/ModelPicker`, `SearchableSelect` from `#/components/ui/select` |
| Destructive confirmation | `useConfirm()` from `#/shared/feedback/confirm` |
| Results of actions | `useNotify()` from `#/shared/feedback/notifications`; mutations through `useMutation` / `useRowActions` |
| Permission-gated UI | `Can` / `useSession().can` from `#/features/auth/session` |
| Loading | `#/shared/components/Skeleton` and `TextSkeleton` (see below) |

If a pattern repeats twice, promote it to `src/shared/components` and add it to this table.
Reusable primitives belong in `src/components/ui`; product compositions in their feature or in
`src/shared/components`. A feature never imports another feature's components.

### Loading states

A skeleton is **the page with the data taken out**: nothing moves when the data arrives, at any
width. Build it from the page's own components and layout:

- Text the page always shows is itself; data is `TextSkeleton length={n}` with the usual length;
  IDs are `IdSkeleton`.
- Controls are ghosts (`ButtonSkeleton`, `GhostSkeleton` around the real control) — never a bar
  with a hand-written height. A form's skeleton is the real form inside `FormSkeleton` (inert,
  text masked), and lives next to the form (`DeploymentFormSkeleton` in `DeploymentForm.tsx`).
- Tables keep their headers, per-column placeholders and pagination. Unknown counts use the usual
  case.
- Use the shared shimmer in both themes; hide placeholders from assistive technology and announce
  loading once. Reduced motion disables shimmer and movement.

## 6. Forms

- **One primary submit** per form, showing `loading` while pending. A submit that leads to another
  page keeps loading until that page is on screen (navigate inside a transition and pass
  `pending || navigating`). A failure never navigates, so the button unlocks with the error.
- Full-page forms are a column of `Panel`s, one per group of related fields, then `FormActions`,
  across the content's full width like Billete's product form (two-column grids inside panels).
  Required panels come first; optional groups follow in their own panels, labelled *(optional)*
  field by field.
- Labels are sentence case; optional fields say "(optional)" in the label.
- Creation selects for providers, models and roles start with a placeholder and require an explicit
  choice; editing preserves stored values; filters may default to *All*.
- Put required credentials directly in the form flow. Keep help that changes a decision (*Leave a
  field blank to keep the stored value*); drop copy about encryption or adapter internals.
- Use a combobox with search inside its popup for models, deployments, adapters and definitions.
  Opening shows the options before typing; model fields that accept custom ids keep doing so.
- Preserve server errors next to the submit (`FormActions`, `ErrorNote`) and field errors on their
  field.
- **Numbers never sit empty and never go negative.** A ceiling (rate limits, budgets, idle
  timeouts) is a `LimitField` (`#/shared/components/LimitField`): it starts at 0, refuses negatives,
  and 0 means *no limit*, said by an *Unlimited* badge beside the label rather than by help text.
  The form maps 0 to the API's `null`.
- **Derive what the system can derive.** When one field is almost always a copy of another, fill
  it in and let the operator override it: the public model follows the upstream model until it is
  renamed by hand, and then stays. Don't expose knobs the gateway manages on its own (a
  deployment's routing weight).
- **Order fields by dependency.** A field that narrows the next comes first (adapter → upstream
  model → public model).
- **A choice between two meaningful outcomes is a pair of card radios** (`RadioCard` in
  `#/components/ui/radio`), each with its consequence in one line — not a switch, whose *off*
  state has no words.
- Resetting actions of a panel (*Use catalog pricing*) are a quiet `ghost` button in the panel's
  header, shown only when there is something to reset — never a full-width button under the
  fields.
- Destructive or irreversible actions confirm with `useConfirm`; cancel buttons in overlays are
  `secondary`.

## 7. Data display

- **A table holds only what is needed to compare rows, one value per cell.** Never stack a second
  value under a cell's own (an id under a name, "in · out" under a total, a share under a cost):
  that is a dictionary, not a table. What does not earn a column goes to the cell's tooltip
  (`title`) or the record's page. Prefer a rate to a count and its rate side by side (*Error rate*,
  the count in its tooltip); compact numbers (*466K*) with the exact value on hover; one column per
  identity (*Public model*, *Upstream model*), the first one the row's link. Secondary values stay
  muted.
- Optional table columns live in a *Columns* menu; tables have row pagination and a visible count.
- Repeat identifying context in each row rather than inserting group banners or nested tables.
- Dates in tables: date over time, UTC, `tabular-nums`; exact timestamp on hover.
- Statuses always through `Status`, in sentence case (*Enabled*, *Success*, *Deprecated*; never the
  raw lowercase value): success = enabled/succeeded, warning = degraded/retried, danger =
  failed/revoked, neutral = disabled.
- Numbers right-aligned in tables with `tabular-nums` (`align: "end"`); text left-aligned; the
  record's identity is the first column.
- An empty table or chart shows `EmptyState` with an icon tile, a title and one sentence, inside
  its panel (`framed={false}`), never a bare line of text.
- On phones a table of more than three columns reads as cards (`DataTable` sets `data-stack`): the
  first cell is the title, every other cell sits beside its header.

## 8. Charts

Built the Rosen way: a curve is one SVG in a `0 0 100 100` viewBox stretched to its box
(`preserveAspectRatio="none"`, `vector-effect: non-scaling-stroke`), and everything else — bars,
axis labels, gridlines, the tooltip — is HTML placed in percentages, so text is crisp, radii stay
round and nothing needs measuring to render. One hover/focus state per chart drives a guide (or a
band for bars), active dots and one `ChartTooltip` card that flips to the left past the middle; the
plot takes the focus and the arrow keys walk the intervals. A click never draws an outline.

Bars for volumes per interval (requests, tokens, cost), stacked only when the series are disjoint
parts of one total (input + output), with a rounded top; lines for latency; bars for comparisons.
Exact values are the tooltip's; the data table stays `sr-only` for screen readers. No visible
*View chart data* disclosure and no chart/table toggle. Parts
of one total are a **stacked meter** (one rounded bar split by share, with the figures above it) or
a row of ticks for request outcomes — not a donut: a ring wastes the panel's width and hides the
numbers. Success rates are green from 95%, amber below it and red only under 50%.

**Tokens always read the same way, in both themes:** input is blue (`--chart-input`), output is
orange (`--chart-output`); the parts of the input are blues — cached `--chart-input-cached`,
uncached `--chart-input`, unclassified `--chart-input-unclassified`. Never use `--chart-1…5` for
tokens: those change hue between themes. Use `--chart-1` through `--chart-5`, UTC
intervals, units, exact values, readable legends and accessible data tables. Compare each series
from zero; missing measurements stay missing, never zero. Container width decides the layout.

The playground composer is an intentional exception to the shared control geometry, after coss's
composer particle: a 26px pill holding only the attach "+" and the round send, with what it is
sent to in a quiet row underneath — *Clear* on the left; the model/effort picker and *Settings* on
the right. The picker is one button (the model's id, truncated, and its effort) opening a popover:
the effort slider over the levels the model supports (none → max, no "default"), under a row that
slides over to the searchable model list; a model without effort, or a capability that is not chat,
opens straight on the list. The settings dialog never repeats the model or the effort. An answer's
reasoning and tool calls are its *process*: one line above the text (`ProcessRow`: the thinking
glyph and phrases while it works, *Done in N steps ›* after) opens a side panel of the steps
(`ProcessPanel`, `ProcessTrace`; a bottom sheet under 1024px). The panel is a sidebar, not a card
in the page: 320px, portaled into the shell's right-edge slot (`SIDE_PANEL_SLOT`) so it spans the
window's height, with the left sidebar's anatomy (40px header row over a hairline, edge scroll area).
Opening it focuses the panel itself, never its close button.
The playground is a layout of its own, not a page in the shell's frame: its root is marked
`data-fill-viewport`, which drops the frame's max width and padding. The transcript is one
`ScrollArea` across the whole column (its bar at the column's edge), the conversation and the
composer are centred inside it, and the composer row ends 12px above the window's bottom.
An answer reads at 16px on a 24px line, like the reader's own bubble; a step's text in the panel
stays at the panel's 14px (`Markdown compact`). The steps are never unfolded inside
the transcript, where they would bury the answer. Waiting for the first chunk uses the same glyph
(`ThinkingIndicator`), so the first step takes over the line without a jump. Its
palette is scoped to the composer.

## 9. Copy

**Less text is the feature.** A panel has at most one short description; a field has a label and,
only when the label cannot carry it, a placeholder example. Help under a field is for the rare line
that changes a decision. Never repeat a unit on every label (*Input (cents / 1M tokens)* ten
times): say it once in the panel's description. Never show raw enum values (`simple-shuffle`,
`rate_limit`): give each option a human label. A paragraph that explains internals belongs in the
docs, not the screen.

English, second person, short and concrete: "Create a deployment to make its public model
available", not "Here you can manage deployments". Buttons are verbs: *Create deployment*, *Save
changes*, *Revoke key*. Domain words, used consistently: **public model**, **deployment**,
**adapter**, **upstream model**, **API key** (virtual key), **operator**.

## 10. Scrolling

Anything that scrolls *inside* the page — tables wider than their panel, payload viewers, chart
data tables, popups — scrolls through coss's `ScrollArea` (`#/components/ui/primitives/scroll-area`,
`scrollFade` on, `viewportClassName` for a `max-h-*`), never the browser's own scrollbar. The page
itself keeps the native scrollbar. Popups (selects, comboboxes, menus) keep one padding on every side, *inside* the scroll area,
and the scroll area reaches the popup's border: the `scrollbar="popup"` thumb (2px) lives in that
padding against the border, like the sidebar's, never in a gutter that shifts the options and never
over them. Lists grow up to 24rem before they scroll. A horizontal bar is a 12px target holding a 6px
thumb (8px on hover), 1px from the bottom edge, above the content; tables give it its own strip
under the last row (`scrollbarGutter`), so dragging it never clicks a row.

## 11. Accessibility and verification

- Every control has a visible label or `aria-label`; overlays trap focus (primitives handle it).
- Contrast comes from tokens; never lower text opacity below `text-muted-foreground`.
- Verify both themes, desktop and phone widths, narrow panels, empty and loading states, keyboard
  navigation and reduced motion, in the browser. Run lint, typecheck, unit tests and the dashboard
  build without weakening any gate.

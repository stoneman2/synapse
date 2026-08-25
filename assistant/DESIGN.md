---
name: Synapse
description: Privacy-first client-side AI chat for simple assistant, chatbot, and roleplay workflows.
colors:
  app-bg: "#0f1310"
  panel-bg: "#151a16"
  border-subtle: "#2a332c"
  surface-hover: "#91a89512"
  surface-raised: "#1a211b"
  message-user: "#223128"
  overlay-soft: "#ffffff1a"
  overlay-medium: "#ffffff26"
  overlay-strong: "#ffffff40"
  text-primary: "#d8ded7"
  text-secondary: "#8d998e"
  text-on-accent: "#111611"
  primary: "#789a7f"
  primary-hover: "#8aae91"
  danger: "#ef4444"
  success: "#22c55e"
  warning: "#eab308"
typography:
  display:
    fontFamily: "Figtree, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1.2em"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "normal"
  title:
    fontFamily: "Figtree, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.95em"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "Figtree, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.95em"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  label:
    fontFamily: "Figtree, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.85em"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "normal"
  mono:
    fontFamily: "Menlo, Monaco, Consolas, monospace"
    fontSize: "0.9em"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "9px"
  xl: "12px"
  pill: "999px"
  round: "50%"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  xxl: "16px"
  content: "20px"
  modal: "28px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.text-on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "10px 20px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.text-on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "10px 20px"
  button-secondary:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.text-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "12px"
  icon-button:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    size: "44px"
  input-field:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "12px"
  message-user:
    backgroundColor: "{colors.message-user}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  message-assistant:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.xs}"
    padding: "12px 16px"
  modal-panel:
    backgroundColor: "{colors.panel-bg}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.xl}"
    padding: "28px"
---

# Design System: Synapse

## 1. Overview

**Creative North Star: "The Clean Workbench"**

Synapse is a practical conversation tool first. The interface should feel like a clear desk with the right instruments within reach: quiet surfaces, compact controls, predictable panels, and enough polish that beginners trust it immediately.

The system is dark by default because the app supports long chat sessions, code blocks, roleplay, and late-night tinkering. Theme presets can change the mood, but the baseline vocabulary stays restrained: one primary accent, soft surface layers, readable type, and no decoration that fights the chat.

This system explicitly rejects the PRODUCT.md anti-references: it must not feel janky, clunky, visually noisy, or like a demo glued together from disconnected tools. Advanced features can be dense, but the main send-and-reply loop must remain effortless.

**Key Characteristics:**
- Three-pane workbench with conversations, chat, and a collapsible context panel.
- Restrained color with a single primary accent for action, selection, focus, and active state.
- Soft tonal layering instead of heavy decoration.
- Rounded, touch-friendly controls that remain professional rather than playful.
- Motion that reports state changes and never performs for its own sake.

## 2. Colors

The palette is a restrained dark product system: forest-tinted near-black surfaces, green-gray dividers, and a muted sage primary accent.

### Primary
- **Moss Control** (`primary`): Used for primary actions, active filters, focus borders, links, and status emphasis.
- **Lifted Sage** (`primary-hover`): Used only for hover and active feedback on primary actions and accent links.

### Neutral
- **Forest Ink** (`app-bg`): The main page background behind the chat.
- **Canopy Panel** (`panel-bg`): Sidebar, context panel, toolbar, input dock, modal, dropdown, and persistent shell surfaces.
- **Soft Border** (`border-subtle`): Default divider, card border, form border, and panel separation.
- **Hover Veil** (`surface-hover`): Hover surfaces, secondary buttons, compact search fields, and inactive chips.
- **Raised Surface** (`surface-raised`): File badges and local panels that need one step of depth.
- **Toned User Surface** (`message-user`): A quiet dark-green surface that separates user messages without turning them into bright callouts.
- **Primary Text** (`text-primary`): Main reading color for messages, titles, labels with emphasis, and field values.
- **Secondary Text** (`text-secondary`): Supporting copy, hints, timestamps, inactive controls, and metadata.
- **Accent Text** (`text-on-accent`): Text on primary buttons and user messages. Future extensions should keep it slightly tinted rather than introducing raw white.

### State
- **Danger Red** (`danger`): Destructive actions, stop streaming, removal controls, and error toasts.
- **Success Green** (`success`): Positive confirmation toasts and completed states.
- **Warning Amber** (`warning`): Tag colors, search highlights, caution labels, and soft warning state.

### Named Rules
**The One Accent Rule.** Moss Control carries action, selection, and focus. Do not add decorative accent colors to inactive UI.

**The Theme Variable Rule.** New surfaces must use semantic CSS variables, not hard-coded per-theme colors, so the built-in theme gallery and custom theme editor keep working.

**The Comfortable Dark Rule.** Dark surfaces must stay separated by subtle tonal shifts and borders. Never use harsh pure black panels or neon-on-black contrast for ordinary controls.

## 3. Typography

**Display Font:** Figtree with platform sans fallbacks.
**Body Font:** Figtree with platform sans fallbacks.
**Label/Mono Font:** Menlo, Monaco, Consolas, monospace for code and inline code only.

**Character:** Synapse uses one humanist sans family across the product. The type is compact and calm, built for forms, chat messages, settings panels, and long reading rather than brand theatrics.

### Hierarchy
- **Display** (600, `1.2em`, 1.2): Modal headings and the largest in-app headings. This is not a marketing display size.
- **Title** (600, `0.95em`, 1.3): Toolbar title, result titles, conversation titles, and compact panel headers.
- **Body** (400, `0.95em`, 1.6): Message text and primary readable content. Prose should stay near 65 to 75 characters per line where layout allows.
- **Label** (600, `0.85em`, 1.4): Buttons, settings labels, menu items, tabs, and compact control text.
- **Micro Label** (600, `0.7em` to `0.8em`, 1.4): Tags, timestamps, section dividers, counters, and helper hints.
- **Code** (400, `0.9em`, 1.5): Inline code, fenced code, and generated snippets.

### Named Rules
**The No Display Drama Rule.** Product surfaces do not use oversized type. Hierarchy comes from weight, placement, and density, not hero-scale headings.

**The One Family Rule.** Figtree carries the UI. Do not introduce decorative fonts, display fonts, or per-feature font families.

## 4. Elevation

Synapse uses tonal layering first and shadows second. Most surfaces are flat at rest and separated by background shifts, borders, and spacing. Shadows appear for floating layers such as dropdowns, popups, toasts, selected screenshot toolbars, and lightboxes.

### Shadow Vocabulary
- **Dropdown Shadow** (`0 4px 12px rgba(0,0,0,0.3)`): Menus, tag pickers, mention dropdowns, and small floating panels.
- **Menu Shadow** (`0 4px 16px rgba(0,0,0,0.4)`): Toolbar overflow menu and similarly important action menus.
- **Floating Toolbar Shadow** (`0 4px 20px rgba(0,0,0,0.4)`): Screenshot selection toolbar and persistent floating action surfaces.
- **Dialog Shadow** (`0 8px 32px rgba(0,0,0,0.5)`): Character info popup and full attention overlays.
- **Focus Ring** (`0 0 0 2px var(--accent)`): Selected messages and explicit focus-like selection states.

### Named Rules
**The Flat Until Floating Rule.** Static panels do not get heavy shadows. If an element is not floating above content, separate it with tone and border.

**The State Shadow Rule.** Shadows should communicate menu, overlay, selection, or temporary elevation. They are forbidden as decoration.

## 5. Components

Components are compact, predictable, and consistent. The same action shape and form vocabulary should be reused across setup, settings, chat, search, memory, and roleplay flows.

### Buttons
- **Shape:** Gently rounded controls, small and medium radii (`6px` to `12px`) depending on density.
- **Primary:** Moss Control background with dark Accent Text, semibold label, and compact padding (`10px 20px` for send, `12px` for modal buttons).
- **Hover / Focus:** Hover shifts to Lifted Sage. Keyboard focus uses a clear 2px accent outline with 2px offset.
- **Secondary / Ghost:** Secondary buttons use Hover Veil with Primary Text. Icon buttons stay transparent until hover and use 44px touch targets on mobile.

### Chips
- **Style:** Conversation tags, tag filters, model override badges, and file badges use small rounded forms with dense labels.
- **State:** Selected chips use Moss Control with Accent Text. Unselected chips use transparent or Hover Veil surfaces with Soft Border.

### Cards / Containers
- **Corner Style:** Default containers use compact corners (`6px` to `9px`). Modals can use `12px`; assistant messages need no container shape.
- **Background:** Use Canopy Panel for shell containers, Hover Veil for inactive controls, and Raised Surface only when content needs separation.
- **Shadow Strategy:** No shadow at rest. Floating menus and overlays use the elevation vocabulary above.
- **Border:** Use Soft Border for panel separation and form-control outlines.
- **Internal Padding:** Dense cards use `8px` to `12px`; modals use `28px`.

### Inputs / Fields
- **Style:** Inputs use Hover Veil backgrounds, Soft Border strokes, Figtree body text, and medium rounding (`8px` to `12px`).
- **Focus:** Border changes to Moss Control. Focus-visible outline remains visible for keyboard users.
- **Error / Disabled:** Error uses Danger Red. Disabled controls lower opacity and keep their shape so layout does not shift.

### Navigation
- **Style:** A conversation sidebar, central chat, and Context panel form the desktop shell. Navigation is compact, text-first, and scan-friendly.
- **States:** Active conversations receive a muted moss background and Primary Text. Hover states use Hover Veil.
- **Mobile:** The conversation and Context panels become mutually exclusive drawers with safe-area padding. Touch controls expand to at least 44px where practical.

### Messages
- **User Bubble:** Toned User Surface with Primary Text, right-aligned, and compact rounded corners.
- **Assistant Message:** Blends into the chat background so long responses read as documents rather than stacked cards.
- **Actions:** Message actions are quiet until hover on pointer devices and visible on touch devices.
- **Rich Content:** Code, tables, LaTeX, Mermaid, files, images, tool blocks, and thinking blocks inherit the same tonal layering.

### Modals And Popups
- **Structure:** Modals use Canopy Panel, Soft Border, compact rounding, and a plain dimmed overlay.
- **Density:** Settings tabs, form fields, and section dividers should remain compact enough for power users.
- **Behavior:** Prefer inline panels where possible, but existing setup, settings, shortcuts, and popups should keep clear focus trapping and escape behavior.

## 6. Do's and Don'ts

### Do:
- **Do** keep the main chat effortless: message stream, input, attachment, voice, and send controls must remain immediately findable.
- **Do** use semantic variables such as `--bg`, `--sidebar-bg`, `--accent`, `--hover`, and `--card-border` for new UI.
- **Do** preserve keyboard navigation, visible focus states, screen-reader labels, and mobile touch targets.
- **Do** keep advanced features discoverable through predictable settings tabs, menus, badges, and inline controls.
- **Do** maintain compact density for settings, prompt entries, memory tools, and search results.
- **Do** keep motion in the 150ms to 300ms range for state feedback, menu reveal, hover, and toast transitions.

### Don't:
- **Don't** make Synapse feel "janky, clunky, visually noisy, or like a demo glued together from disconnected tools."
- **Don't** bury basic chat behind configuration, overdecorate simple tasks, or assume every user is already an expert.
- **Don't** add decorative color, gradients, glass effects, or animation that does not communicate state.
- **Don't** introduce inconsistent component vocabulary across features. A save, cancel, field, tab, chip, or popup should look like it belongs to the same product.
- **Don't** use heavy shadows on static panels. If it is not floating, use tone, spacing, or border.
- **Don't** use side-stripe card accents, gradient text, nested cards, or hero-metric layouts in product UI.

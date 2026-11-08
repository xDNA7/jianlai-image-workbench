# BoardUI source provenance

Source: https://github.com/BoardUI/boardui
Commit: ec5c5eb3e29c2441be63b9422cd54f411ef23466
Retrieved: 2026-11-07
License: MIT; see LICENSE (copyright retained).

Free source copied: base/buttons/button.tsx, base/segmented-control/segmented-control.tsx, foundations/direction/direction.tsx, utils/cx.ts, styles/theme.css, styles/typography.css.

Adaptations: local import paths; Button directional Remix icon helper omitted because project uses Lucide and a Chinese LTR surface. Removed segmented thumb width/height transitions: frequent selection changes do not need motion. Semantic palette and font overrides live in playground.css. Native button semantics and React Aria segmented selection preserved. No Pro code or Next.js runtime copied.

Additional free source copied: base/input/input.tsx, label.tsx, hint-text.tsx, base/textarea/textarea.tsx. Label Remix info glyph replaced with Lucide Info; field behavior and React Aria associations retained.

## Remaining interaction adapters (2026-11-07)

- Reviewed the same MIT free source commit's `components/base/select/select.tsx` for React Aria selection/popover composition; no paid/Pro source or registry was used.
- `modal.tsx` is a project-authored React Aria ModalOverlay/Modal/Dialog adapter. React Aria provides focus containment/restoration, Escape, outside dismissal and background scroll locking.
- `chat/Pick.tsx` is a project-authored select-only combobox using the existing BoardUI Button and React Aria Popover/ListBox, preserving this project's accessible combobox contract.
- `chat/SideDrawer.tsx` composes that modal adapter with the already installed Motion primitives and project-authored horizontal touch handling; vertical scrolling and pinch zoom remain available.
- AI presentation wrappers retain their existing MIT attribution; their button/input behavior now uses BoardUI/React Aria and scrolling uses native browser APIs. Unused attachment/item/separator wrappers and the unused upstream stylesheet were removed.
- These adapters are not claimed to be copied upstream BoardUI components.

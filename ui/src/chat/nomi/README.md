# Nomi adaptation

`storyboard-edits.ts` adapts `moveShot` from
https://github.com/aqm857886159/Nomi/blob/0fdd0da72e9be98430b300e491b6bd47f7d79976/src/workbench/generationCanvas/agent/storyboardPlanEdits.ts
under AGPL-3.0-only. The upstream source SHA256 is
`714605f4097f6f1878451c699785e5f00ff9525444df7f3c4aeaaeca57f52797`.

Changes remove scene ownership, plan identity, renumbering and desktop state;
the adapted operation only reorders an immutable array. Full terms are in
`LICENSE`. No other Nomi component, model provider, timeline or MCP code is included.

/*
 * Adapted from aqm857886159/Nomi, AGPL-3.0-only.
 * Source: src/workbench/generationCanvas/agent/storyboardPlanEdits.ts, moveShot
 * Commit: 0fdd0da72e9be98430b300e491b6bd47f7d79976
 * Modifications: generic scalar rows; removed sceneId adoption, renumbering,
 * PlanShot identity and Electron/workbench state. Full license: ./LICENSE.
 */
export function moveShot<T>(shots: T[], from: number, to: number): T[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to || from < 0 || to < 0 || from >= shots.length || to >= shots.length) return shots
  const next = [...shots]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

import type { PdfPage } from "./api.ts"

const MAX_TEXT = 500_000
const MAX_MATCHES = 500

export type Match = { id: number; start: number; end: number }

export function findReplacement(pages: PdfPage[], search: string, replacement: string) {
  if (!search.trim()) throw new Error("Escribe el texto que quieres buscar.")
  if (search === replacement) throw new Error("El reemplazo debe ser distinto al texto original.")

  let total = 0
  const groups = pages.flatMap((page) => {
    const matches: Match[] = []
    let offset = 0
    while (true) {
      const start = page.text.indexOf(search, offset)
      if (start < 0) break
      if (total === MAX_MATCHES) {
        throw new Error("Hay más de 500 coincidencias. Busca un texto más específico.")
      }
      offset = start + search.length
      matches.push({ id: ++total, start, end: offset })
    }
    return matches.length ? [{ number: page.number, text: page.text, matches }] : []
  })
  return { pages, groups, search, replacement, total }
}

export type ReplacementPlan = ReturnType<typeof findReplacement>

export function applyReplacement(plan: ReplacementPlan, selected?: ReadonlySet<number>) {
  let total = 0
  let outputLength = 0
  const groups = new Map(plan.groups.map((group) => [group.number, group.matches]))
  const changes: { number: number; before: string; after: string; matches: number }[] = []
  const revised = plan.pages.map((page) => {
    const active = (groups.get(page.number) ?? []).filter((match) => !selected || selected.has(match.id))
    const matches = active.length
    total += matches
    let length = page.text.length
    for (const { start, end } of active) {
      length += plan.replacement.length - (end - start)
    }
    outputLength += length
    if (outputLength > MAX_TEXT) throw new Error("La copia supera el límite de texto.")
    if (!matches) return page
    let cursor = 0
    const parts = active.map(({ start, end }) => {
      const part = page.text.slice(cursor, start)
      cursor = end
      return part + plan.replacement
    })
    const text = parts.join("") + page.text.slice(cursor)
    changes.push({ number: page.number, before: page.text, after: text, matches })
    return { ...page, text }
  })

  return { pages: revised, changes, total }
}

export function previewReplacement(pages: PdfPage[], search: string, replacement: string) {
  return applyReplacement(findReplacement(pages, search, replacement))
}

export const MAX_DRAFT_STEPS = 20
type ReplacementStep = {
  kind: "replacement"
  search: string
  replacement: string
  count: number
  pages: PdfPage[]
}

type DirectEditStep = { kind: "direct"; number: number; pages: PdfPage[] }
export type DraftStep = ReplacementStep | DirectEditStep

export function draftPages(original: PdfPage[], steps: readonly DraftStep[]) {
  return steps[steps.length - 1]?.pages ?? original
}

export function compareDraft(original: PdfPage[], draft: PdfPage[]) {
  const originals = new Map(original.map(({ number, text }) => [number, text]))
  return draft.flatMap(({ number, text: after }) => {
    const before = originals.get(number)
    return before !== undefined && before !== after ? [{ number, before, after }] : []
  })
}

export function addDraftStep(
  steps: readonly DraftStep[],
  plan: ReplacementPlan,
  selected: ReadonlySet<number>,
): DraftStep[] {
  if (steps.length >= MAX_DRAFT_STEPS) throw new Error("La copia admite hasta 20 pasos.")
  if (steps.length && steps[steps.length - 1].pages !== plan.pages) {
    throw new Error("La copia cambió. Vuelve a preparar la vista previa.")
  }
  const result = applyReplacement(plan, selected)
  if (!result.total) return [...steps]
  return [...steps, { kind: "replacement", search: plan.search, replacement: plan.replacement, count: result.total, pages: result.pages }]
}

export function addDirectEdit(
  original: PdfPage[],
  steps: readonly DraftStep[],
  number: number,
  text: string,
): DraftStep[] {
  if (steps.length >= MAX_DRAFT_STEPS) throw new Error("La copia admite hasta 20 pasos.")
  const pages = draftPages(original, steps)
  const previous = pages.find((page) => page.number === number)
  if (!previous) throw new Error("Selecciona un segmento válido.")
  if (previous.text === text) return [...steps]
  const length = pages.reduce((total, page) => total + page.text.length, 0)
  if (length - previous.text.length + text.length > MAX_TEXT) {
    throw new Error("La copia supera el límite de texto.")
  }
  const revised = pages.map((page) => page.number === number ? { ...page, text } : page)
  return [...steps, { kind: "direct", number, pages: revised }]
}

export function undoDraftStep(steps: readonly DraftStep[]): DraftStep[] {
  return steps.slice(0, -1)
}

export type DraftHistory = {
  steps: readonly DraftStep[]
  undone: readonly DraftStep[]
}

export function recordDraftSteps(history: DraftHistory, next: readonly DraftStep[]): DraftHistory {
  return next.length > history.steps.length ? { steps: next, undone: [] } : history
}

export function undoDraft(history: DraftHistory): DraftHistory {
  const last = history.steps[history.steps.length - 1]
  if (!last) return history
  return { steps: undoDraftStep(history.steps), undone: [...history.undone, last] }
}

export function redoDraft(history: DraftHistory): DraftHistory {
  const next = history.undone[history.undone.length - 1]
  if (!next) return history
  return { steps: [...history.steps, next], undone: history.undone.slice(0, -1) }
}

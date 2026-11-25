import type { PdfPage } from "./api.ts"

export type BlockResult = {
  number: number
  segments: number[]
  answer: string | null
  citations: { page: number; excerpt: string }[]
}

type Progress = { total: number; completed: BlockResult[] }

async function post(route: string, payload: object, signal: AbortSignal, request: typeof fetch): Promise<unknown> {
  const response = await request(`/api/documents/summary/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  })
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    if (data && typeof data === "object" && "detail" in data && typeof data.detail === "string") {
      throw new Error(data.detail)
    }
    throw new Error("No se pudo completar el resumen local.")
  }
  return data
}

export async function summarizeGlobally(
  pages: PdfPage[], blocks: BlockResult[], signal: AbortSignal, request: typeof fetch = fetch,
): Promise<{ answer: string; citations: BlockResult["citations"] }> {
  const data = await post("global", {
    pages,
    blocks: blocks.map(({ answer, citations }) => ({ answer, citations })),
  }, signal, request)
  if (!data || typeof data !== "object" || !("provider" in data) || data.provider !== "ollama" ||
    !("status" in data) || data.status !== "summarized" ||
    !("answer" in data) || typeof data.answer !== "string" || !data.answer.trim() ||
    !("citations" in data) || !Array.isArray(data.citations) || !data.citations.length) {
    throw new Error("La API no devolvió un resumen global válido.")
  }
  const citations = data.citations.map((citation: unknown) => {
    if (!citation || typeof citation !== "object" || !("page" in citation) || typeof citation.page !== "number" ||
      !("excerpt" in citation) || typeof citation.excerpt !== "string" || !citation.excerpt.trim()) {
      throw new Error("La API devolvió una cita no válida.")
    }
    const { page, excerpt } = citation
    if (!blocks.some((block) => block.citations.some((source) => source.page === page && source.excerpt === excerpt)) ||
      !pages.some((source) => source.number === page && source.text.includes(excerpt))) {
      throw new Error("No se pudo verificar una cita del resumen global.")
    }
    return { page, excerpt }
  })
  if (!blocks.every((block) => block.citations.some((source) =>
    citations.some((citation) => source.page === citation.page && source.excerpt === citation.excerpt)))) {
    throw new Error("Faltan referencias de uno o más bloques.")
  }
  return { answer: data.answer, citations }
}

export async function summarizeByBlock(
  pages: PdfPage[],
  signal: AbortSignal,
  shouldStop: () => boolean,
  onProgress: (progress: Progress) => void,
  request: typeof fetch = fetch,
) {
  const plan = await post("plan", { pages }, signal, request)
  if (!plan || typeof plan !== "object" || !("blocks" in plan) ||
    !Array.isArray(plan.blocks) || !plan.blocks.length || plan.blocks.length > 8) {
    throw new Error("La API no devolvió un plan de resumen válido.")
  }
  const originals = new Map(pages.map(({ number, text }) => [number, text]))
  const blocks = plan.blocks.map((block: unknown): PdfPage[] => {
    if (!block || typeof block !== "object" || !("pages" in block) || !Array.isArray(block.pages) || !block.pages.length) {
      throw new Error("La API devolvió un bloque no válido.")
    }
    return block.pages.map((fragment: unknown) => {
      if (!fragment || typeof fragment !== "object" ||
        !("number" in fragment) || typeof fragment.number !== "number" ||
        !("text" in fragment) || typeof fragment.text !== "string" || !fragment.text.trim() ||
        !originals.get(fragment.number)?.includes(fragment.text)) {
        throw new Error("Un bloque no coincide con el documento.")
      }
      return { number: fragment.number, text: fragment.text }
    })
  })
  const completed: BlockResult[] = []
  onProgress({ total: blocks.length, completed: [] })
  for (const [index, block] of blocks.entries()) {
    if (shouldStop() || signal.aborted) break
    const data = await post("block", { pages: block }, signal, request)
    if (!data || typeof data !== "object" || !("provider" in data) || data.provider !== "ollama" ||
      !("status" in data) || (data.status !== "summarized" && data.status !== "not_found") ||
      !("citations" in data) || !Array.isArray(data.citations)) {
      throw new Error(`El bloque ${index + 1} devolvió una respuesta no válida.`)
    }
    const answer = data.status === "summarized" && "answer" in data && typeof data.answer === "string"
      ? data.answer.trim() : null
    const citations = data.citations.map((citation: unknown) => {
      if (!citation || typeof citation !== "object" || !("page" in citation) || typeof citation.page !== "number" ||
        !("excerpt" in citation) || typeof citation.excerpt !== "string" || !citation.excerpt.trim()) {
        throw new Error("La API devolvió una cita no válida.")
      }
      const { page, excerpt } = citation
      if (!block.some((segment) => segment.number === page && segment.text.includes(excerpt))) {
        throw new Error("No se pudo verificar una cita dentro de su bloque.")
      }
      return { page, excerpt }
    })
    if (data.status === "summarized" ? !answer || !citations.length : citations.length !== 0) {
      throw new Error(`El bloque ${index + 1} no devolvió un resumen con citas verificables.`)
    }
    completed.push({ number: index + 1, segments: block.map(({ number }) => number), answer, citations })
    onProgress({ total: blocks.length, completed: [...completed] })
  }
  return { stopped: completed.length !== blocks.length }
}

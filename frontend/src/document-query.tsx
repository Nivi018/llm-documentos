import { useEffect, useRef, useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DOCUMENT_LABELS, checkProvider, queryDocument, type DocumentAction, type DocumentResult, type DocumentType, type PdfPage, type ProviderName } from "./api"
import { summarizeByBlock, summarizeGlobally, type BlockResult } from "./block-summary"

export function DocumentQuery({
  pages,
  sourceType,
  onOpenPage,
}: {
  pages: PdfPage[]
  sourceType: DocumentType
  onOpenPage: (number: number) => void
}) {
  const [question, setQuestion] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState<DocumentResult | null>(null)
  const [provider, setProvider] = useState<ProviderName | "loading" | "unavailable">("loading")
  const [consent, setConsent] = useState(false)
  const [blocks, setBlocks] = useState<BlockResult[]>([])
  const [total, setTotal] = useState(0)
  const [blockStatus, setBlockStatus] = useState("")
  const [blockBusy, setBlockBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [globalSummary, setGlobalSummary] = useState<Awaited<ReturnType<typeof summarizeGlobally>> | null>(null)
  const [globalBusy, setGlobalBusy] = useState(false)
  const stop = useRef(false)
  const blockController = useRef<AbortController | null>(null)
  const remote = provider === "opencode-console"
  const ready = provider === "stub" || provider === "ollama" || (remote && consent)
  const canCombine = total > 0 && blocks.length === total && blocks.every((block) => block.answer && block.citations.length)
  const inProgress = busy || blockBusy || globalBusy

  useEffect(() => {
    const controller = new AbortController()
    void checkProvider((input, init) => fetch(input, { ...init, signal: controller.signal }))
      .then((probe) => setProvider(probe.provider))
      .catch(() => { if (!controller.signal.aborted) setProvider("unavailable") })
    return () => {
      controller.abort()
      blockController.current?.abort()
    }
  }, [])

  async function run(action: DocumentAction) {
    if (inProgress || !ready) return
    setBlocks([])
    setGlobalSummary(null)
    setBlockStatus("")
    setBusy(true)
    setResult(null)
    setError("")
    try {
      setResult(await queryDocument(pages, action, fetch, remote && consent))
    } catch (cause) {
      setError(cause instanceof Error && !(cause instanceof TypeError)
        ? cause.message
        : "No se pudo conectar con la API local.")
    } finally {
      setBusy(false)
    }
  }

  async function runBlocks() {
    if (provider !== "ollama" || inProgress || blockController.current) return
    const controller = new AbortController()
    blockController.current = controller
    stop.current = false
    setBlockBusy(true)
    setStopping(false)
    setBlocks([])
    setGlobalSummary(null)
    setTotal(0)
    setResult(null)
    setError("")
    setBlockStatus("")
    try {
      const { stopped } = await summarizeByBlock(pages, controller.signal, () => stop.current, (progress) => {
        if (controller.signal.aborted) return
        setTotal(progress.total)
        setBlocks(progress.completed)
      })
      if (!controller.signal.aborted) setBlockStatus(stopped ? "Resumen por bloques detenido." : "Resumen por bloques completado.")
    } catch (cause) {
      if (!controller.signal.aborted) {
        setBlockStatus("Resumen por bloques interrumpido.")
        setError(cause instanceof Error && !(cause instanceof TypeError)
          ? cause.message
          : "No se pudo conectar con la API local.")
      }
    } finally {
      blockController.current = null
      if (!controller.signal.aborted) setBlockBusy(false)
    }
  }

  async function runGlobal() {
    if (provider !== "ollama" || !canCombine || inProgress || blockController.current) return
    const controller = new AbortController()
    blockController.current = controller
    setGlobalBusy(true)
    setError("")
    try {
      const summary = await summarizeGlobally(pages, blocks, controller.signal)
      if (!controller.signal.aborted) setGlobalSummary(summary)
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error && !(cause instanceof TypeError)
          ? cause.message
          : "No se pudo conectar con la API local.")
      }
    } finally {
      blockController.current = null
      if (!controller.signal.aborted) setGlobalBusy(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (question.trim()) void run({ action: "ask", question: question.trim() })
  }

  return (
    <section className="space-y-3 border-t pt-4" aria-labelledby="query-heading">
      <h2 id="query-heading" className="text-lg font-semibold">Consultar el documento</h2>
      <p className="text-sm text-muted-foreground">
        {remote
          ? "GPT 6 Luna · OpenCode Console (pago por uso). La consulta envía el texto extraído del documento y, si escribes una, tu pregunta. El proveedor puede retener datos hasta 30 días."
          : provider === "stub"
            ? "Modo simulado: busca palabras o selecciona fragmentos. No llama a un modelo externo."
            : provider === "ollama" ? "Qwen3 4B · Ollama local (CPU). Para documentos largos puedes preguntar o generar resúmenes separados por bloques."
              : provider === "loading" ? "Comprobando el proveedor…" : "No se pudo comprobar el proveedor. Recarga la página para reintentar."}
      </p>
      <form className="space-y-2" onSubmit={submit}>
        {remote && (
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={consent} disabled={busy}
              onChange={(event) => setConsent(event.target.checked)} />
            Acepto enviar el texto de este documento y mis consultas a OpenCode Console.
          </label>
        )}
        <label className="block font-medium" htmlFor="document-question">Pregunta</label>
        <Input
          id="document-question"
          value={question}
          maxLength={500}
          disabled={inProgress}
          placeholder="¿Cuál es el presupuesto total aprobado?"
          onChange={(event) => setQuestion(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={inProgress || !ready || !question.trim()}>Preguntar</Button>
          <Button type="button" variant="outline" disabled={inProgress || !ready} onClick={() => void run({ action: "summarize" })}>
            Resumir documento
          </Button>
          {provider === "ollama" && (
            <Button type="button" variant="outline" disabled={inProgress} onClick={() => void runBlocks()}>
              Resumir por bloques
            </Button>
          )}
          {blockBusy && (
            <Button type="button" variant="outline" disabled={stopping} onClick={() => {
              stop.current = true
              setStopping(true)
            }}>Detener después del bloque actual</Button>
          )}
        </div>
      </form>
      <p role="status">
        {globalBusy ? "Combinando los resúmenes con Ollama…" : globalSummary ? "Resumen global disponible."
          : blockBusy ? (total ? `${blocks.length} de ${total} bloques procesados.${stopping ? " Deteniendo al terminar el bloque actual…" : ""}` : "Preparando bloques…")
          : blockStatus || (busy ? "Consultando…" : result?.status === "answered" ? (result.answer ? "Respuesta con citas." : "Fragmento encontrado.")
          : result?.status === "summarized" ? (result.answer ? "Resumen con citas." : "Resumen por fragmentos.")
          : result?.status === "not_found" ? "No encontré evidencia suficiente en el texto extraído." : "")}
      </p>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {canCombine && !globalSummary && (
        <Button type="button" disabled={inProgress} onClick={() => void runGlobal()}>Combinar en un resumen global</Button>
      )}
      {blocks.length > 0 && blocks.length === total && !canCombine && (
        <p className="text-sm text-muted-foreground">El resumen global requiere un resumen con citas de cada bloque.</p>
      )}
      {globalSummary && (
        <article className="space-y-2 rounded-md border p-3">
          <h3 className="font-semibold">Resumen global</h3>
          <p className="whitespace-pre-wrap wrap-break-word">{globalSummary.answer}</p>
          <ul className="space-y-2">
            {globalSummary.citations.map(({ page, excerpt }) => (
              <li key={`${page}:${excerpt}`}>
                <blockquote className="wrap-break-word">{excerpt}</blockquote>
                <Button type="button" variant="link" className="px-0" onClick={() => onOpenPage(page)}>
                  Ver {DOCUMENT_LABELS[sourceType].toLowerCase()} {page}
                </Button>
              </li>
            ))}
          </ul>
        </article>
      )}
      {blocks.map((block) => (
        <article key={block.number} className="space-y-2 rounded-md border p-3">
          <h3 className="font-semibold">Bloque {block.number} · {DOCUMENT_LABELS[sourceType]} {block.segments.join(", ")}</h3>
          <p className="whitespace-pre-wrap wrap-break-word">{block.answer ?? "No se obtuvo un resumen con evidencia para este bloque."}</p>
          {block.citations.length > 0 && (
            <ul className="space-y-2">
              {block.citations.map(({ page, excerpt }) => (
                <li key={`${page}:${excerpt}`}>
                  <blockquote className="wrap-break-word">{excerpt}</blockquote>
                  <Button type="button" variant="link" className="px-0" onClick={() => onOpenPage(page)}>
                    Ver {DOCUMENT_LABELS[sourceType].toLowerCase()} {page}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
      {result?.answer && <p className="whitespace-pre-wrap wrap-break-word">{result.answer}</p>}
      {result && result.citations.length > 0 && (
        <ul className="space-y-2">
          {result.citations.map(({ page, excerpt }) => (
            <li key={`${page}:${excerpt}`} className="rounded-md border p-3">
              <blockquote className="wrap-break-word">{excerpt}</blockquote>
              <Button type="button" variant="link" className="px-0" onClick={() => onOpenPage(page)}>
                Ver {DOCUMENT_LABELS[sourceType].toLowerCase()} {page}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

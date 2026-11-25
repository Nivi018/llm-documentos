import { useEffect, useMemo, useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { DOCUMENT_LABELS, checkProvider, exportDocx, rewriteFragment, type DocumentType, type PdfPage } from "./api"
import { addDirectEdit, addDraftStep, applyReplacement, compareDraft, draftPages, findReplacement, MAX_DRAFT_STEPS, recordDraftSteps, redoDraft, undoDraft, type DraftHistory, type ReplacementPlan } from "./document-edits"

export function DocumentCopy({ pages, sourceType }: { pages: PdfPage[]; sourceType: DocumentType }) {
  const [search, setSearch] = useState("")
  const [replacement, setReplacement] = useState("")
  const [plan, setPlan] = useState<ReplacementPlan | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [error, setError] = useState("")
  const [status, setStatus] = useState("")
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<DraftHistory>({ steps: [], undone: [] })
  const { steps, undone } = history
  const [mode, setMode] = useState<"replace" | "direct">("replace")
  const [number, setNumber] = useState(pages[0]?.number ?? 1)
  const [editedText, setEditedText] = useState<string | null>(null)
  const [localRewrite, setLocalRewrite] = useState(false)
  const [instruction, setInstruction] = useState("")
  const label = DOCUMENT_LABELS[sourceType]
  const draft = draftPages(pages, steps)
  const segment = draft.find((page) => page.number === number)
  const directPending = segment !== undefined && editedText !== null && editedText !== segment.text
  const changes = compareDraft(pages, draft)
  const { preview, selectionError } = useMemo(() => {
    if (!plan) return { preview: null, selectionError: "" }
    try {
      return { preview: applyReplacement(plan, selected), selectionError: "" }
    } catch (cause) {
      return { preview: null, selectionError: cause instanceof Error ? cause.message : "No se pudo aplicar la selección." }
    }
  }, [plan, selected])

  useEffect(() => {
    if (mode !== "direct") return
    const controller = new AbortController()
    void checkProvider((input, init) => fetch(input, { ...init, signal: controller.signal }))
      .then((probe) => { if (!controller.signal.aborted) setLocalRewrite(probe.provider === "ollama") })
      .catch(() => { if (!controller.signal.aborted) setLocalRewrite(false) })
    return () => controller.abort()
  }, [mode])

  function resetPreview() {
    setPlan(null)
    setEditedText(null)
    setInstruction("")
    setSelected(new Set())
    setError("")
    setStatus("")
  }

  async function suggestRewrite() {
    if (!localRewrite || !segment?.text.trim() || !instruction.trim() || busy || directPending) return
    setBusy(true)
    setStatus("Ollama está preparando la propuesta…")
    setError("")
    try {
      const proposal = await rewriteFragment(segment.text, instruction.trim())
      setEditedText(proposal)
      setStatus(proposal === segment.text
        ? "La propuesta coincide con el texto actual."
        : "Propuesta lista. Revísala en Después y agrégala solo si te convence.")
    } catch (cause) {
      setStatus("")
      setError(cause instanceof Error && !(cause instanceof TypeError)
        ? cause.message
        : "No se pudo conectar con la API local.")
    } finally {
      setBusy(false)
    }
  }

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    resetPreview()
    try {
      const result = findReplacement(draft, search, replacement)
      setPlan(result)
      setSelected(new Set(result.groups.flatMap(({ matches }) => matches.map(({ id }) => id))))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo preparar la vista previa.")
    }
  }

  function addChange() {
    if (!plan || !preview?.total || busy) return
    try {
      setHistory(recordDraftSteps(history, addDraftStep(steps, plan, selected)))
      setSearch("")
      setReplacement("")
      resetPreview()
      setStatus("Cambio agregado a la copia.")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo agregar el cambio.")
    }
  }

  function undoChange() {
    if (!steps.length || busy) return
    setHistory(undoDraft(history))
    resetPreview()
    setStatus("Se deshizo el último paso.")
  }

  function redoChange() {
    if (!undone.length || busy) return
    setHistory(redoDraft(history))
    resetPreview()
    setStatus("Se recuperó el cambio deshecho.")
  }

  function addDirectChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!directPending || editedText === null || busy) return
    try {
      setHistory(recordDraftSteps(history, addDirectEdit(pages, steps, number, editedText)))
      resetPreview()
      setStatus("Edición agregada a la copia.")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo agregar la edición.")
    }
  }

  function changeSelection(next: Set<number>) {
    setSelected(next)
    setStatus("")
    setError("")
  }

  async function download() {
    if (!changes.length || busy) return
    setBusy(true)
    setError("")
    setStatus("Generando la copia…")
    try {
      const blob = await exportDocx(draft, fetch, sourceType)
      const url = URL.createObjectURL(blob)
      try {
        const link = document.createElement("a")
        link.href = url
        link.download = "documento-editado.docx"
        document.body.append(link)
        link.click()
        link.remove()
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
      }
      setStatus("Copia generada. Revisa las descargas del navegador.")
    } catch (cause) {
      setStatus("")
      setError(cause instanceof Error && !(cause instanceof TypeError)
        ? cause.message
        : "No se pudo conectar con la API local.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-3 border-t pt-4" aria-labelledby="copy-heading">
      <h2 id="copy-heading" className="text-lg font-semibold">Crear una copia en Word</h2>
      <p className="text-sm text-muted-foreground">
        Reemplaza coincidencias exactas o edita un fragmento completo. Trabajas sobre el texto con los cambios ya agregados.
        La copia contiene texto editable, no el diseño original. El archivo original queda intacto.
      </p>
      <div className="space-y-2">
        <label className="block font-medium" htmlFor="copy-mode">Forma de editar</label>
        <NativeSelect id="copy-mode" value={mode} disabled={busy} onChange={(event) => {
          setMode(event.target.value === "direct" ? "direct" : "replace")
          resetPreview()
        }}>
          <NativeSelectOption value="replace">Buscar y reemplazar</NativeSelectOption>
          <NativeSelectOption value="direct">Editar un fragmento</NativeSelectOption>
        </NativeSelect>
        <p className="text-sm text-muted-foreground">Si cambias de modo, solo se conservan los cambios ya agregados.</p>
      </div>
      {mode === "direct" && segment && (
        <form className="space-y-3" onSubmit={addDirectChange}>
          <label className="block font-medium" htmlFor="copy-segment">{label} para editar</label>
          <NativeSelect id="copy-segment" value={number} disabled={busy} onChange={(event) => {
            setNumber(Number(event.target.value))
            resetPreview()
          }}>
            {draft.map((item) => <NativeSelectOption key={item.number} value={item.number}>
              {label} {item.number}
            </NativeSelectOption>)}
          </NativeSelect>
          {localRewrite && (
            <div className="space-y-2 rounded-md border p-3">
              <label className="block font-medium" htmlFor="copy-instruction">Instrucción para Ollama</label>
              <Input id="copy-instruction" value={instruction} maxLength={500} disabled={busy}
                placeholder="Reescribe la nota en tono formal sin cambiar las cifras."
                onChange={(event) => setInstruction(event.target.value)} />
              <p className="text-sm text-muted-foreground">
                Qwen3 recibe solo el fragmento seleccionado y la instrucción. La propuesta no se agrega sola.
              </p>
              {directPending && <p className="text-sm text-muted-foreground">Agrega la edición pendiente o descártala antes de generar otra propuesta.</p>}
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={busy || directPending || !segment.text.trim() || !instruction.trim() || steps.length >= MAX_DRAFT_STEPS}
                  onClick={() => void suggestRewrite()}>Proponer reescritura</Button>
                {directPending && <Button type="button" variant="ghost" disabled={busy} onClick={() => {
                  setEditedText(null)
                  setStatus("")
                  setError("")
                }}>Descartar edición pendiente</Button>}
              </div>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <h3 className="font-medium">Antes</h3>
              <p className="max-h-64 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border p-2">
                {segment.text || "Este segmento está vacío."}
              </p>
            </div>
            <div className="min-w-0">
              <label className="font-medium" htmlFor="copy-direct-text">Después</label>
              <Textarea
                id="copy-direct-text"
                value={editedText ?? segment.text}
                rows={6}
                maxLength={500_000}
                disabled={busy || steps.length >= MAX_DRAFT_STEPS}
                onChange={(event) => {
                  setEditedText(event.target.value)
                  setError("")
                  setStatus("")
                }}
              />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">Si cambias de fragmento sin agregar la edición, se descarta el texto pendiente.</p>
          <Button type="submit" disabled={busy || !directPending || steps.length >= MAX_DRAFT_STEPS}>Agregar a los cambios</Button>
        </form>
      )}
      {mode === "replace" && <form className="space-y-2" onSubmit={review}>
        <label className="block font-medium" htmlFor="copy-search">Buscar texto</label>
        <Input id="copy-search" value={search} maxLength={500} disabled={busy}
          onChange={(event) => { setSearch(event.target.value); resetPreview() }} />
        <label className="block font-medium" htmlFor="copy-replace">Reemplazar por</label>
        <Input id="copy-replace" value={replacement} maxLength={500} disabled={busy}
          aria-describedby="copy-replace-hint"
          onChange={(event) => { setReplacement(event.target.value); resetPreview() }} />
        <p id="copy-replace-hint" className="text-sm text-muted-foreground">
          Déjalo vacío para eliminar el texto encontrado.
        </p>
        <Button type="submit" disabled={busy || !search.trim() || steps.length >= MAX_DRAFT_STEPS}>Previsualizar cambios</Button>
      </form>}
      <p role="status">{status || (plan && (
        plan.total === 0 ? "No se encontró una coincidencia exacta en el texto extraído."
          : `Coincidencias seleccionadas: ${selected.size} de ${plan.total}.`
      ))}</p>
      {(error || selectionError) && <p role="alert" className="text-destructive">{error || selectionError}</p>}
      {plan && plan.groups.length > 0 && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={busy || selected.size === plan.total}
              onClick={() => changeSelection(new Set(plan.groups.flatMap(({ matches }) => matches.map(({ id }) => id))))}>
              Seleccionar todas
            </Button>
            <Button type="button" variant="outline" disabled={busy || selected.size === 0}
              onClick={() => changeSelection(new Set())}>
              Deseleccionar todas
            </Button>
          </div>
          {plan.groups.map(({ number, text, matches }, index) => (
            <details key={number} open={index === 0} className="space-y-2 rounded-md border p-3">
              <summary>{label} {number} · {matches.filter(({ id }) => selected.has(id)).length} de {matches.length} seleccionadas</summary>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <h3 className="font-medium">Antes</h3>
                  <p className="whitespace-pre-wrap wrap-break-word">
                    {matches.map(({ id, start, end }, position) => (
                      <span key={id}>
                        {text.slice(position ? matches[position - 1].end : 0, start)}
                        <label className="cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selected.has(id)}
                            disabled={busy}
                            aria-label={`Aplicar coincidencia ${position + 1} de ${label.toLowerCase()} ${number}`}
                            onChange={(event) => {
                              const next = new Set(selected)
                              if (event.target.checked) next.add(id)
                              else next.delete(id)
                              changeSelection(next)
                            }}
                          />
                          <mark className={selected.has(id) ? "bg-yellow-200 text-black" : "bg-muted text-muted-foreground"}>
                            {text.slice(start, end)}
                          </mark>
                        </label>
                      </span>
                    ))}
                    {text.slice(matches[matches.length - 1].end)}
                  </p>
                </div>
                <div>
                  <h3 className="font-medium">Después</h3>
                  <p className="whitespace-pre-wrap wrap-break-word">
                    {preview ? (preview.changes.find((change) => change.number === number)?.after ?? text) || "Este segmento queda sin texto."
                      : "Ajusta la selección para ver el resultado."}
                  </p>
                </div>
              </div>
            </details>
          ))}
          <Button type="button" disabled={busy || !preview?.total || steps.length >= MAX_DRAFT_STEPS} onClick={addChange}>Agregar a los cambios</Button>
        </div>
      )}
      {(steps.length > 0 || undone.length > 0) && (
        <div className="space-y-3 rounded-md border p-3">
          <h3 className="font-semibold">Cambios acumulados</h3>
          {steps.length > 0 && <ol className="list-decimal space-y-1 pl-5">
            {steps.map((step, index) => (
              <li key={index} className="wrap-break-word">
                {step.kind === "direct" ? `Edición directa · ${label} ${step.number}` : (
                  <>«{step.search}» → {step.replacement ? `«${step.replacement}»` : "(eliminar)"} · {step.count} reemplazo(s)</>
                )}
              </li>
            ))}
          </ol>}
          {steps.length >= MAX_DRAFT_STEPS && <p>Alcanzaste el límite de 20 pasos. Descarga la copia o deshaz el último paso.</p>}
          {changes.length > 0 ? (
            <details className="space-y-2">
              <summary>Comparar con el original ({changes.length} {changes.length === 1 ? "fragmento modificado" : "fragmentos modificados"})</summary>
              <p className="text-sm text-muted-foreground">
                Solo se muestran los fragmentos que difieren del original. La copia incluye también el texto sin cambios.
              </p>
              <ol className="space-y-3">
                {changes.map(({ number, before, after }) => (
                  <li key={number} className="space-y-2 rounded-md border p-3">
                    <h4 className="font-medium">{label} {number}</h4>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="min-w-0 rounded-md bg-muted p-2">
                        <h5 className="font-medium">Antes · Original</h5>
                        {before ? <p className="whitespace-pre-wrap wrap-break-word">{before}</p>
                          : <p className="italic text-muted-foreground">Sin texto en el original.</p>}
                      </div>
                      <div className="min-w-0 rounded-md border p-2">
                        <h5 className="font-medium">Después · Copia de trabajo</h5>
                        {after ? <p className="whitespace-pre-wrap wrap-break-word">{after}</p>
                          : <p className="italic text-muted-foreground">Sin texto en la copia.</p>}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </details>
          ) : <p>La copia de trabajo coincide con el original.</p>}
          {(preview?.total || directPending) ? <p className="text-sm text-muted-foreground">La edición pendiente no se descargará hasta que la agregues.</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={busy || !steps.length} onClick={undoChange}>Deshacer último cambio</Button>
            <Button type="button" variant="outline" disabled={busy || !undone.length} onClick={redoChange}>Rehacer cambio</Button>
            <Button type="button" disabled={busy || !changes.length} onClick={() => void download()}>Descargar DOCX</Button>
          </div>
        </div>
      )}
    </section>
  )
}

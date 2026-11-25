import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { DOCUMENT_LABELS, previewDocument, type DocumentType, type PdfPage } from "./api"
import { DocumentCopy } from "./document-copy"
import { DocumentQuery } from "./document-query"

export function DocumentPreview() {
  const [file, setFile] = useState<File | null>(null)
  const [type, setType] = useState<DocumentType>("pdf")
  const [pages, setPages] = useState<PdfPage[]>([])
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const page = pages[index]
  const label = DOCUMENT_LABELS[type]

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file || busy) return
    setPages([])
    setIndex(0)
    setError("")
    const extension = file.name.split(".").pop()?.toLowerCase()
    if (!file.name.includes(".") || (extension !== "pdf" && extension !== "docx" && extension !== "txt")) {
      setError("Selecciona un archivo .pdf, .docx o .txt.")
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("El archivo supera el máximo de 10 MiB.")
      return
    }
    setBusy(true)
    try {
      const result = await previewDocument(file, extension)
      setType(extension)
      setPages(result)
    } catch (cause) {
      setError(cause instanceof Error && !(cause instanceof TypeError)
        ? cause.message
        : "No se pudo conectar con la API local.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-4" aria-labelledby="pdf-heading">
      <h2 id="pdf-heading" className="text-lg font-semibold">Vista previa del documento</h2>
      <form className="space-y-3" onSubmit={submit}>
        <label htmlFor="pdf-file" className="block font-medium">Archivo PDF, Word o TXT</label>
        <Input
          id="pdf-file"
          type="file"
          accept=".pdf,.docx,.txt"
          disabled={busy}
          aria-describedby="pdf-hint"
          onChange={(event) => {
            setFile(event.currentTarget.files?.[0] ?? null)
            setPages([])
            setIndex(0)
            setError("")
          }}
        />
        <p id="pdf-hint" className="text-sm text-muted-foreground">
          Un archivo de hasta 10 MiB: PDF con texto, Word (.docx) o TXT en UTF-8.
          Máximo 100 páginas, párrafos o líneas, según el formato.
        </p>
        <Button type="submit" disabled={!file || busy}>Extraer texto</Button>
      </form>
      <p role="status">
        {busy ? "Extrayendo texto…" : pages.length > 0 ? `Segmentos leídos: ${pages.length}` : ""}
      </p>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {page && (
        <div className="space-y-2">
          <label htmlFor="pdf-page" className="block font-medium">{label}</label>
          <NativeSelect id="pdf-page" value={index} onChange={(event) => setIndex(Number(event.target.value))}>
            {pages.map((item, position) => (
              <NativeSelectOption key={item.number} value={position}>
                {label} {item.number}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {page.text ? (
            <div className="whitespace-pre-wrap wrap-break-word rounded-md border p-4">{page.text}</div>
          ) : (
            <p>{type === "pdf" ? "No se detectó texto en esta página. Puede estar en blanco o escaneada; no hay OCR." : "Este segmento está vacío."}</p>
          )}
        </div>
      )}
      {pages.some((item) => item.text) && (
        <>
          <DocumentQuery pages={pages} sourceType={type} onOpenPage={(number) => {
            setIndex(number - 1)
            document.getElementById("pdf-page")?.focus()
          }} />
          <DocumentCopy pages={pages} sourceType={type} />
        </>
      )}
    </section>
  )
}

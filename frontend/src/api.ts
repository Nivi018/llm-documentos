export type ProviderName = "stub" | "opencode-console" | "ollama"

function isProvider(value: unknown): value is ProviderName {
  return value === "stub" || value === "opencode-console" || value === "ollama"
}

type Probe = {
  provider: ProviderName
  message: string
}

export async function checkProvider(
  request: typeof fetch = fetch,
): Promise<Probe> {
  const response = await request("/api/provider/probe")
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  const data: unknown = await response.json()
  if (
    typeof data !== "object" ||
    data === null ||
    !("provider" in data) ||
    !isProvider(data.provider) ||
    !("message" in data) ||
    typeof data.message !== "string"
  ) {
    throw new Error("Respuesta de la API no válida")
  }
  return { provider: data.provider, message: data.message }
}

export type PdfPage = { number: number; text: string }
export type DocumentType = "pdf" | "docx" | "txt"

export async function rewriteFragment(text: string, instruction: string, request: typeof fetch = fetch): Promise<string> {
  const response = await request("/api/documents/rewrite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, instruction }),
  })
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    if (data && typeof data === "object" && "detail" in data && typeof data.detail === "string") {
      throw new Error(data.detail)
    }
    throw new Error("No se pudo generar una propuesta de edición.")
  }
  if (!data || typeof data !== "object" || !("text" in data) || typeof data.text !== "string" || !data.text.trim()) {
    throw new Error("La API no devolvió una propuesta válida.")
  }
  return data.text
}

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const MEDIA_TYPES: Record<DocumentType, string> = { pdf: "application/pdf", docx: DOCX_TYPE, txt: "text/plain" }

export const DOCUMENT_LABELS: Record<DocumentType, string> = { pdf: "Página", docx: "Párrafo", txt: "Línea" }

export async function exportDocx(pages: PdfPage[], request: typeof fetch = fetch, sourceType: DocumentType = "pdf"): Promise<Blob> {
  const response = await request("/api/documents/docx", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sourceType === "pdf" ? { pages } : { pages, source_type: sourceType }),
  })
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null)
    if (data && typeof data === "object" && "detail" in data && typeof data.detail === "string") {
      throw new Error(data.detail)
    }
    throw new Error("No se pudo generar la copia de Word.")
  }
  if (response.headers.get("Content-Type") !== DOCX_TYPE) {
    throw new Error("La API no devolvió un archivo Word válido.")
  }
  return response.blob()
}

export type DocumentAction = { action: "ask"; question: string } | { action: "summarize" }
export type DocumentResult = {
  status: "answered" | "not_found" | "summarized"
  citations: { page: number; excerpt: string }[]
  answer?: string
}

export async function queryDocument(
  pages: PdfPage[],
  action: DocumentAction,
  request: typeof fetch = fetch,
  remoteConsent = false,
): Promise<DocumentResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (remoteConsent) headers["X-Document-Remote"] = "opencode-console"
  const response = await request("/api/documents/query", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...action, pages }),
  })
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    if (data && typeof data === "object" && "detail" in data && typeof data.detail === "string") {
      throw new Error(data.detail)
    }
    throw new Error("No se pudo consultar el documento. Comprueba que la API esté iniciada.")
  }
  if (
    !data || typeof data !== "object" ||
    !("provider" in data) || !isProvider(data.provider) ||
    !("status" in data) ||
    (data.status !== "answered" && data.status !== "not_found" && data.status !== "summarized") ||
    !("citations" in data) || !Array.isArray(data.citations) ||
    (data.citations.length === 0) !== (data.status === "not_found")
  ) {
    throw new Error("La API devolvió una consulta no válida.")
  }
  if (data.provider === "opencode-console" && !remoteConsent) {
    throw new Error("La API devolvió una respuesta remota no válida.")
  }
  if (data.provider !== "stub" && data.status !== "not_found" &&
    (!("answer" in data) || typeof data.answer !== "string" || !data.answer.trim())) {
    throw new Error("La API devolvió una respuesta del modelo no válida.")
  }
  const citations = data.citations.map((citation: unknown) => {
    if (
      !citation || typeof citation !== "object" ||
      !("page" in citation) || typeof citation.page !== "number" ||
      !("excerpt" in citation) || typeof citation.excerpt !== "string" || !citation.excerpt.trim()
    ) {
      throw new Error("La API devolvió una cita no válida.")
    }
    const { page, excerpt } = citation
    if (!pages.some((source) => source.number === page && source.text.includes(excerpt))) {
      throw new Error("No se pudo verificar una cita contra el documento.")
    }
    return { page, excerpt }
  })
  const result: DocumentResult = { status: data.status, citations }
  if (data.provider !== "stub" && data.status !== "not_found" && "answer" in data && typeof data.answer === "string") {
    result.answer = data.answer
  }
  return result
}

export async function previewPdf(
  file: Blob,
  request: typeof fetch = fetch,
): Promise<PdfPage[]> {
  return previewDocument(file, "pdf", request)
}

export async function previewDocument(
  file: Blob,
  type: DocumentType,
  request: typeof fetch = fetch,
): Promise<PdfPage[]> {
  const response = await request(`/api/documents/${type}/preview`, {
    method: "POST",
    headers: { "Content-Type": MEDIA_TYPES[type] },
    body: file,
  })
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    if (data && typeof data === "object" && "detail" in data && typeof data.detail === "string") {
      throw new Error(data.detail)
    }
    throw new Error("No se pudo procesar el documento. Verifica que la API esté iniciada.")
  }
  if (!data || typeof data !== "object" || !("pages" in data) || !Array.isArray(data.pages)) {
    throw new Error("La API devolvió una vista previa no válida.")
  }
  if (data.pages.length === 0) throw new Error("La API no devolvió texto.")
  return data.pages.map((page: unknown, index: number) => {
    if (
      !page || typeof page !== "object" ||
      !("number" in page) || page.number !== index + 1 ||
      !("text" in page) || typeof page.text !== "string"
    ) {
      throw new Error("La API devolvió un segmento no válido.")
    }
    return { number: page.number, text: page.text }
  })
}

import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { Button } from "@/components/ui/button"
import { checkProvider } from "./api"
import { DocumentPreview } from "./pdf-preview"
import "./index.css"

function App() {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("Sin comprobar")

  async function verify() {
    setBusy(true)
    setStatus("Comprobando…")
    try {
      const result = await checkProvider()
      setStatus(result.message)
    } catch {
      setStatus("No se pudo comprobar. Verifica que la API local esté iniciada.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">llm-documentos</h1>
      <DocumentPreview />
      <details className="border-t pt-4">
        <summary>Diagnóstico de la API</summary>
        <Button className="my-2" type="button" disabled={busy} onClick={verify}>
          Comprobar conexión con la API
        </Button>
        <p role="status">{status}</p>
      </details>
    </main>
  )
}

const root = document.getElementById("root")
if (!root) throw new Error("Falta el punto de entrada de React")

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

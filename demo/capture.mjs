import assert from "node:assert/strict"
import { copyFile, mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const local = (path) => fileURLToPath(new URL(path, import.meta.url))
const base = process.env.DEMO_APP_URL ?? "http://127.0.0.1:5173"
assert.equal(new URL(base).hostname, "127.0.0.1", "La demo solo usa la app en loopback.")
await mkdir(local("./assets/"), { recursive: true })
await copyFile(local("./node_modules/gsap/dist/gsap.min.js"), local("./assets/gsap.min.js"))

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 850 }, deviceScaleFactor: 2 })
  await page.goto(base)
  const probe = await page.request.get(`${base}/api/provider/probe`)
  assert.equal(probe.ok(), true, "Inicia FastAPI y el frontend antes de capturar.")
  assert.equal((await probe.json()).provider, "stub", "Usa LLM_PROVIDER=stub para la demo reproducible.")
  await page.evaluate(() => document.fonts.ready.then(() => undefined))

  async function capture(locator, name) {
    await locator.screenshot({ path: local(`./assets/${name}.png`), animations: "disabled" })
  }

  const upload = page.getByRole("button", { name: "Extraer texto" }).locator("..")
  await page.getByLabel("Archivo PDF, Word o TXT").setInputFiles(local("../ejemplos/biblioteca-horizonte.pdf"))
  await capture(upload, "01-carga")
  await page.getByRole("button", { name: "Extraer texto" }).click()
  const source = page.getByLabel("Página", { exact: true })
  await source.selectOption({ label: "Página 3" })
  const sourcePanel = page.locator("#pdf-page").locator("../..")
  await sourcePanel.getByText("Presupuesto total aprobado: USD 8.000.", { exact: false }).waitFor()
  await capture(sourcePanel, "02-pagina")

  const query = page.getByRole("region", { name: "Consultar el documento" })
  await query.getByLabel("Pregunta").fill("¿Cuál es el presupuesto total aprobado?")
  await query.getByRole("button", { name: "Preguntar" }).click()
  await query.getByText("Presupuesto total aprobado: USD 8.000.", { exact: true }).waitFor()
  await query.getByRole("button", { name: "Ver página 3" }).click()
  assert.equal(await source.inputValue(), "2")
  await capture(query, "03-consulta")

  await page.getByLabel("Buscar texto").fill("USD 8.000")
  await page.getByLabel("Reemplazar por").fill("USD 8.500")
  await page.getByRole("button", { name: "Previsualizar cambios" }).click()
  const match = page.getByRole("checkbox", { name: "Aplicar coincidencia 1 de página 3" })
  assert.equal(await match.isChecked(), true)
  const preview = match.locator("xpath=ancestor::details")
  await preview.getByText(/Presupuesto total aprobado: USD 8.500/).waitFor()
  await capture(preview, "04-revision")

  await page.getByRole("button", { name: "Agregar a los cambios" }).click()
  const accumulated = page.getByText(/Comparar con el original/)
  await accumulated.click()
  await accumulated.locator("..").getByText(/Presupuesto total aprobado: USD 8.500/).waitFor()
  await accumulated.click()
  const waiting = page.waitForEvent("download")
  const downloadButton = page.getByRole("button", { name: "Descargar DOCX" })
  await downloadButton.click()
  const download = await waiting
  assert.equal(download.suggestedFilename(), "documento-editado.docx")
  await download.saveAs(local("./assets/documento-editado.docx"))
  await page.getByText("Copia generada. Revisa las descargas del navegador.").waitFor()
  await capture(downloadButton.locator("../.."), "05-exportacion")
  console.log("Playwright: carga, cita, revisión y descarga verificadas.")
} finally {
  await browser.close()
}

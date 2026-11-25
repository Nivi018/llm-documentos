import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { setTimeout as pause } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const local = (path) => fileURLToPath(new URL(path, import.meta.url))
const base = new URL(process.env.DEMO_APP_URL ?? "http://127.0.0.1:5173")
assert.equal(base.hostname, "127.0.0.1", "La demo solo usa la app en loopback.")
await mkdir(local("./assets/recordings/"), { recursive: true })
await copyFile(local("./node_modules/gsap/dist/gsap.min.js"), local("./assets/gsap.min.js"))

const browser = await chromium.launch()
const viewport = { width: 1120, height: 630 }
const context = await browser.newContext({
  viewport,
  recordVideo: { dir: local("./assets/recordings/"), size: viewport },
})
const page = await context.newPage()
const video = page.video()
assert(video)
const recording = local("./assets/flujo.webm")

// A viewport recording does not include the OS pointer. Draw a demo pointer
// that follows browser mouse events; do not alter the app or intercept clicks.
await page.addInitScript(() => {
  addEventListener("DOMContentLoaded", () => {
    const dot = document.createElement("div")
    dot.setAttribute("aria-hidden", "true")
    dot.style.cssText = "position:fixed;top:0;left:0;width:22px;height:22px;margin:-11px;z-index:2147483647;pointer-events:none;border:2px solid #137e60;border-radius:50%;background:#a7f3d0aa;box-shadow:0 0 0 2px white;opacity:0"
    document.body.append(dot)
    addEventListener("mousemove", (event) => {
      dot.style.opacity = "1"
      dot.style.transform = `translate(${event.clientX}px,${event.clientY}px)`
    }, { passive: true })
    addEventListener("mousedown", () => {
      dot.animate([{ scale: 1.65 }, { scale: 1 }], { duration: 330, easing: "ease-out" })
    }, { passive: true })
  }, { once: true })
})

async function pointAt(locator) {
  await locator.waitFor()
  await locator.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "smooth" }))
  await pause(650) // Editorial pacing: let the recorded scroll finish.
  const box = await locator.boundingBox()
  assert(box)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 })
  await pause(280)
}
async function click(locator) {
  await pointAt(locator)
  await locator.click()
}
async function type(locator, text, delay = 50) {
  await click(locator)
  await locator.pressSequentially(text, { delay })
}

try {
  await page.goto(base.href)
  const probe = await page.request.get(new URL("/api/provider/probe", base).href)
  assert(probe.ok(), "Inicia FastAPI y el frontend antes de capturar.")
  assert.equal((await probe.json()).provider, "stub", "Usa LLM_PROVIDER=stub para la demo.")
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await pause(1600)

  const input = page.getByLabel("Archivo PDF, Word o TXT")
  await pointAt(input)
  await input.setInputFiles(local("../ejemplos/biblioteca-horizonte.pdf"))
  await pause(1300)
  await click(page.getByRole("button", { name: "Extraer texto" }))
  const source = page.getByLabel("Página", { exact: true })
  await pointAt(source)
  await source.press("End")
  await pause(1450)

  const query = page.getByRole("region", { name: "Consultar el documento" })
  await type(query.getByLabel("Pregunta"), "¿Cuál es el presupuesto total aprobado?", 58)
  await click(query.getByRole("button", { name: "Preguntar" }))
  await query.getByText("Presupuesto total aprobado: USD 8.000.", { exact: true }).waitFor()
  await pause(2000)
  await click(query.getByRole("button", { name: "Ver página 3" }))
  assert.equal(await source.inputValue(), "2")
  await pause(1600)

  await type(page.getByLabel("Buscar texto"), "USD 8.000", 92)
  await type(page.getByLabel("Reemplazar por"), "USD 8.500", 92)
  await click(page.getByRole("button", { name: "Previsualizar cambios" }))
  const match = page.getByRole("checkbox", { name: "Aplicar coincidencia 1 de página 3" })
  assert(await match.isChecked())
  const comparison = match.locator("xpath=ancestor::details")
  await pointAt(comparison.getByRole("heading", { name: "Después" }))
  await comparison.getByText(/Presupuesto total aprobado: USD 8.500/).waitFor()
  await pause(2100)

  await click(page.getByRole("button", { name: "Agregar a los cambios" }))
  const accumulated = page.getByText(/Comparar con el original/)
  await click(accumulated)
  await accumulated.locator("..").getByText(/Presupuesto total aprobado: USD 8.500/).waitFor()
  await pause(1450)
  const waiting = page.waitForEvent("download")
  await click(page.getByRole("button", { name: "Descargar DOCX" }))
  const download = await waiting
  assert.equal(download.suggestedFilename(), "documento-editado.docx")
  await download.saveAs(local("./assets/flujo-editado.docx"))
  const success = page.getByText("Copia generada. Revisa las descargas del navegador.")
  await success.waitFor()
  await success.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "smooth" }))
  await pause(2400)
  await context.close()
  await video.saveAs(recording)
} finally {
  await context.close()
  await browser.close()
}

const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
  "-of", "default=noprint_wrappers=1:nokey=1", recording], { encoding: "utf8" }).trim())
assert(Number.isFinite(seconds) && seconds > 10, "La grabación debe contener el flujo completo.")
const duration = String(Math.floor(seconds * 30) / 30)
const composition = await readFile(local("./live.template.html"), "utf8")
await writeFile(local("./live.generated.html"), composition.replaceAll("__DURATION__", duration))
console.log(`Grabación continua: ${seconds.toFixed(1)} s. Playwright verificó la cita y descargó el DOCX.`)

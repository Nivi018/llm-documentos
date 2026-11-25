import assert from "node:assert/strict"
import { test } from "node:test"
import { DOCUMENT_LABELS, checkProvider, exportDocx, previewDocument, previewPdf, queryDocument, rewriteFragment } from "../src/api.ts"
import { addDirectEdit, addDraftStep, applyReplacement, compareDraft, draftPages, findReplacement, previewReplacement, recordDraftSteps, redoDraft, undoDraft, undoDraftStep, type DraftHistory } from "../src/document-edits.ts"
import { summarizeByBlock, summarizeGlobally } from "../src/block-summary.ts"

test("el resumen global requiere citas literales de todos los bloques", async () => {
  const pages = [{ number: 1, text: "Inicio" }, { number: 13, text: "Cierre" }]
  const citations = [{ page: 1, excerpt: "Inicio" }, { page: 13, excerpt: "Cierre" }]
  const blocks = citations.map((citation, index) => ({
    number: index + 1, segments: [citation.page], answer: citation.excerpt, citations: [citation],
  }))
  const signal = new AbortController().signal
  const reply = (sources: { page: number; excerpt: string }[]) =>
    Response.json({ provider: "ollama", status: "summarized", answer: "Inicio y cierre.", citations: sources })
  const result = await summarizeGlobally(pages, blocks, signal, async (url, options) => {
    assert.equal(url, "/api/documents/summary/global")
    assert.equal(options?.signal, signal)
    assert.deepEqual(JSON.parse(String(options?.body)), {
      pages, blocks: blocks.map(({ answer, citations }) => ({ answer, citations })),
    })
    return reply(citations)
  })
  assert.equal(result.answer, "Inicio y cierre.")
  await assert.rejects(summarizeGlobally(pages, blocks, signal, async () => reply(citations.slice(0, 1))), /Faltan referencias/)
  await assert.rejects(summarizeGlobally(pages, blocks, signal, async () =>
    reply([{ page: 1, excerpt: "Inventado" }, citations[1]])), /verificar una cita/)
})

test("el resumen por bloques muestra progreso y no empieza otro bloque al detenerse", async () => {
  const pages = [{ number: 1, text: "Inicio" }, { number: 2, text: "Cierre" }]
  const calls: string[] = []
  const progress: number[] = []
  let stop = false
  const signal = new AbortController().signal
  const result = await summarizeByBlock(pages, signal, () => stop, ({ total, completed }) => {
    assert.equal(total, 2)
    progress.push(completed.length)
    if (completed.length) {
      assert.equal(completed[0].answer, "Inicio")
      stop = true
    }
  }, async (url, options) => {
    calls.push(String(url))
    assert.equal(options?.signal, signal)
    if (String(url).endsWith("/plan")) {
      return Response.json({ blocks: pages.map((page) => ({ pages: [page] })) })
    }
    assert.deepEqual(JSON.parse(String(options?.body)), { pages: [pages[0]] })
    return Response.json({
      provider: "ollama", status: "summarized", answer: "Inicio",
      citations: [{ page: 1, excerpt: "Inicio" }],
    })
  })
  assert.deepEqual(result, { stopped: true })
  assert.deepEqual(progress, [0, 1])
  assert.deepEqual(calls, ["/api/documents/summary/plan", "/api/documents/summary/block"])
})

test("la propuesta local no cambia el borrador hasta que se agrega", async () => {
  const original = [{ number: 1, text: "Nota original" }, { number: 2, text: "Importe: USD 2.400." }]
  const proposal = await rewriteFragment(original[0].text, "Usa un tono formal.", async (url, options) => {
    assert.equal(url, "/api/documents/rewrite")
    assert.deepEqual(JSON.parse(String(options?.body)), { text: "Nota original", instruction: "Usa un tono formal." })
    return Response.json({ text: "Nota formal." })
  })
  assert.equal(draftPages(original, [])[0].text, "Nota original")
  const updated = draftPages(original, addDirectEdit(original, [], 1, `${proposal} Revisada.`))
  assert.equal(updated[0].text, "Nota formal. Revisada.")
  assert.equal(updated[1], original[1])
  await assert.rejects(
    rewriteFragment("Nota", "Formal", async () => Response.json({ text: " " })),
    /propuesta válida/,
  )
})

test("carga Word y TXT por sus rutas y conserva sus referencias", async () => {
  for (const [type, media, label] of [
    ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Párrafo"],
    ["txt", "text/plain", "Línea"],
  ] as const) {
    const file = new Blob()
    const pages = [{ number: 1, text: "Presupuesto: USD 2.400." }]
    const result = await previewDocument(file, type, async (url, options) => {
      assert.equal(url, `/api/documents/${type}/preview`)
      assert.equal(new Headers(options?.headers).get("Content-Type"), media)
      assert.equal(options?.body, file)
      return Response.json({ pages })
    })
    assert.deepEqual(result, pages)
    assert.equal(DOCUMENT_LABELS[type], label)
  }
})

test("consulta la ruta del proveedor y valida el contrato", async () => {
  const payload = { provider: "stub", message: "Respuesta simulada" }
  const result = await checkProvider(async (url) => {
    assert.equal(url, "/api/provider/probe")
    return Response.json(payload)
  })
  assert.deepEqual(result, payload)
})

test("rechaza errores HTTP y respuestas no válidas", async () => {
  await assert.rejects(
    checkProvider(async () => new Response(null, { status: 503 })),
    /HTTP 503/,
  )
  await assert.rejects(
    checkProvider(async () => Response.json({ provider: "otro" })),
    /no válida/,
  )
})

test("envía el PDF como cuerpo binario y lee la vista previa", async () => {
  const file = new Blob(["%PDF-"], { type: "application/pdf" })
  const pages = [{ number: 1, text: "Primera página" }, { number: 2, text: "" }]
  const result = await previewPdf(file, async (url, options) => {
    assert.equal(url, "/api/documents/pdf/preview")
    assert.equal(options?.method, "POST")
    assert.equal(new Headers(options?.headers).get("Content-Type"), "application/pdf")
    assert.equal(options?.body, file)
    return Response.json({ pages })
  })
  assert.deepEqual(result, pages)
})

test("muestra el error del servidor y rechaza páginas fuera de orden", async () => {
  const file = new Blob()
  await assert.rejects(
    previewPdf(file, async () => Response.json({ detail: "Solo se admiten archivos PDF." }, { status: 415 })),
    /Solo se admiten archivos PDF/,
  )
  await assert.rejects(
    previewPdf(file, async () => Response.json({ pages: [{ number: 2, text: "" }] })),
    /segmento no válido/,
  )
})

test("envía la pregunta y acepta una cita verificable", async () => {
  const pages = [{ number: 1, text: "Presupuesto: USD 8.000." }]
  const action = { action: "ask", question: "¿Cuál es el presupuesto?" } as const
  const citations = [{ page: 1, excerpt: "USD 8.000" }]
  const result = await queryDocument(pages, action, async (url, options) => {
    assert.equal(url, "/api/documents/query")
    assert.deepEqual(JSON.parse(String(options?.body)), { ...action, pages })
    return Response.json({ provider: "stub", status: "answered", citations })
  })
  assert.deepEqual(result, { status: "answered", citations })
})

test("distingue falta de resultados y rechaza citas ajenas al PDF", async () => {
  const pages = [{ number: 1, text: "Presupuesto: USD 8.000." }]
  const action = { action: "summarize" } as const
  const result = await queryDocument(pages, action, async () =>
    Response.json({ provider: "stub", status: "not_found", citations: [] }),
  )
  assert.equal(result.status, "not_found")
  await assert.rejects(
    queryDocument(pages, action, async () =>
      Response.json({
        provider: "stub",
        status: "summarized",
        citations: [{ page: 1, excerpt: "USD 9.000" }],
      }),
    ),
    /No se pudo verificar/,
  )
})

test("previsualiza todas las coincidencias literales sin modificar el original", () => {
  const pages = [
    { number: 1, text: "USD 8.000 / USD 8.000 / usd 8.000" },
    { number: 2, text: "USD 8x000" },
  ]
  const preview = previewReplacement(pages, "USD 8.000", "USD 8.500")
  assert.equal(preview.total, 2)
  assert.deepEqual(preview.changes, [{
    number: 1,
    before: pages[0].text,
    after: "USD 8.500 / USD 8.500 / usd 8.000",
    matches: 2,
  }])
  assert.equal(preview.pages[1].text, "USD 8x000")
  assert.equal(pages[0].text, "USD 8.000 / USD 8.000 / usd 8.000")
})

test("admite eliminación literal, detecta ausencia y limita el tamaño de la copia", () => {
  const pages = [{ number: 1, text: "Eliminar aquí" }]
  assert.equal(previewReplacement(pages, "Eliminar ", "").pages[0].text, "aquí")
  assert.equal(previewReplacement(pages, "otro", "valor").total, 0)
  assert.throws(() => previewReplacement(pages, " ", ""), /quieres buscar/)
  assert.throws(() => previewReplacement(pages, "a", "a"), /debe ser distinto/)
  assert.throws(
    () => previewReplacement([{ number: 1, text: `${"a".repeat(499_999)}b` }], "b", "xx"),
    /límite de texto/,
  )
})

test("solo aplica las coincidencias seleccionadas, incluso en el mismo párrafo", async () => {
  const source = [
    { number: 1, text: "Histórico: USD 2.400. Vigente: USD 2.400." },
    { number: 2, text: "Límite previo: USD 2.400." },
  ]
  const plan = findReplacement(source, "USD 2.400", "USD 2.750")
  assert.equal(plan.total, 3)
  const onlyCurrent = applyReplacement(plan, new Set([2]))
  assert.equal(onlyCurrent.total, 1)
  assert.equal(onlyCurrent.pages[0].text, "Histórico: USD 2.400. Vigente: USD 2.750.")
  assert.equal(onlyCurrent.pages[1].text, source[1].text)
  assert.equal(applyReplacement(plan, new Set()).total, 0)
  assert.deepEqual(applyReplacement(plan, new Set()).pages, source)
  assert.equal(applyReplacement(plan).total, 3)

  await exportDocx(onlyCurrent.pages, async (_url, options) => {
    assert.deepEqual(JSON.parse(String(options?.body)), { pages: onlyCurrent.pages, source_type: "docx" })
    return new Response("PK", { headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    } })
  }, "docx")
})

test("los reemplazos no se solapan y las búsquedas demasiado amplias se rechazan", () => {
  const plan = findReplacement([{ number: 1, text: "aaaaa" }], "aa", "")
  assert.deepEqual(plan.groups[0].matches.map(({ start, end }) => [start, end]), [[0, 2], [2, 4]])
  assert.equal(applyReplacement(plan, new Set([2])).pages[0].text, "aaa")
  assert.throws(
    () => findReplacement([{ number: 1, text: "a".repeat(501) }], "a", "b"),
    /más de 500 coincidencias/,
  )
})

test("acumula reemplazos seleccionados y deshace un paso sin tocar el original", async () => {
  const original = [
    { number: 1, text: "Huerto del Barrio Sur" },
    { number: 2, text: "Histórico: USD 2.400." },
    { number: 3, text: "Vigente: USD 2.400." },
  ]
  const amount = findReplacement(original, "USD 2.400", "USD 2.750")
  assert.deepEqual(addDraftStep([], amount, new Set()), [])
  const first = addDraftStep([], amount, new Set([2]))
  const renamed = findReplacement(draftPages(original, first), "Huerto del Barrio Sur", "Huerto Comunitario")
  const second = addDraftStep(first, renamed, new Set([1]))
  const draft = draftPages(original, second)
  assert.deepEqual(draft.map(({ text }) => text), [
    "Huerto Comunitario", "Histórico: USD 2.400.", "Vigente: USD 2.750.",
  ])

  const continued = findReplacement(draft, "USD 2.750", "USD 2.800")
  assert.equal(continued.total, 1)
  assert.throws(() => addDraftStep(second, renamed, new Set([1])), /La copia cambió/)
  assert.equal(draftPages(original, undoDraftStep(second))[0].text, "Huerto del Barrio Sur")
  assert.equal(draftPages(original, undoDraftStep(second))[2].text, "Vigente: USD 2.750.")
  assert.equal(draftPages(original, undoDraftStep(first)), original)
  assert.equal(original[2].text, "Vigente: USD 2.400.")
  await exportDocx(draft, async (_url, options) => {
    assert.deepEqual(JSON.parse(String(options?.body)), { pages: draft, source_type: "txt" })
    return new Response("PK", { headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    } })
  }, "txt")
})

test("combina una edición directa y un reemplazo selectivo, y permite deshacer ambos", () => {
  const original = [
    { number: 1, text: "Presupuesto histórico: USD 2.400." },
    { number: 2, text: "Presupuesto vigente: USD 2.400." },
    { number: 3, text: "Nota anterior." },
  ]
  const note = "Nota revisada.\nConservar el histórico para la comparación anual."
  const direct = addDirectEdit(original, [], 3, note)
  assert.equal(direct[0].kind, "direct")
  const plan = findReplacement(draftPages(original, direct), "USD 2.400", "USD 2.750")
  const combined = addDraftStep(direct, plan, new Set([2]))
  assert.deepEqual(draftPages(original, combined).map(({ text }) => text), [
    original[0].text, "Presupuesto vigente: USD 2.750.", note,
  ])
  assert.equal(original[2].text, "Nota anterior.")
  assert.equal(draftPages(original, undoDraftStep(combined))[2].text, note)
  assert.equal(draftPages(original, undoDraftStep(direct)), original)
})

test("la edición directa admite vaciar un fragmento y valida sus límites", () => {
  const original = [{ number: 1, text: "Original" }, { number: 2, text: "Otro fragmento" }]
  assert.deepEqual(addDirectEdit(original, [], 1, "Original"), [])
  assert.equal(draftPages(original, addDirectEdit(original, [], 1, ""))[0].text, "")
  assert.throws(() => addDirectEdit(original, [], 3, "Inválido"), /segmento válido/)
  assert.throws(() => addDirectEdit(original, [], 1, "a".repeat(500_000)), /límite de texto/)
})

test("la comparación final muestra solo diferencias netas frente al original", () => {
  const original = [
    { number: 1, text: "Presupuesto histórico: USD 2.400." },
    { number: 2, text: "Presupuesto vigente: USD 2.400." },
    { number: 3, text: "Nota anterior." },
    { number: 4, text: "" },
  ]
  const plan = findReplacement(original, "USD 2.400", "USD 2.750")
  let steps = addDraftStep([], plan, new Set([2]))
  steps = addDirectEdit(original, steps, 3, "")
  steps = addDirectEdit(original, steps, 4, "Nota nueva.")
  assert.deepEqual(compareDraft(original, draftPages(original, steps)), [
    { number: 2, before: original[1].text, after: "Presupuesto vigente: USD 2.750." },
    { number: 3, before: original[2].text, after: "" },
    { number: 4, before: "", after: "Nota nueva." },
  ])
  steps = addDirectEdit(original, steps, 2, original[1].text)
  assert.deepEqual(compareDraft(original, draftPages(original, steps)).map(({ number }) => number), [3, 4])
  assert.deepEqual(compareDraft(original, draftPages(original, undoDraftStep(steps))).map(({ number }) => number), [2, 3, 4])
  assert.deepEqual(compareDraft(original, original), [])
})

test("rehace los cambios en orden, incluso después de deshacerlos todos", () => {
  const original = [{ number: 1, text: "Primero" }]
  let history: DraftHistory = { steps: [], undone: [] }
  history = recordDraftSteps(history, addDirectEdit(original, history.steps, 1, "Segundo"))
  history = recordDraftSteps(history, addDirectEdit(original, history.steps, 1, "Tercero"))
  history = undoDraft(undoDraft(history))
  assert.equal(history.steps.length, 0)
  assert.equal(draftPages(original, history.steps), original)
  history = redoDraft(history)
  assert.equal(draftPages(original, history.steps)[0].text, "Segundo")
  history = redoDraft(history)
  assert.equal(draftPages(original, history.steps)[0].text, "Tercero")
  assert.equal(redoDraft(history), history)
})

test("una edición nueva descarta lo que estaba pendiente de rehacer", () => {
  const original = [{ number: 1, text: "Original" }]
  const initial: DraftHistory = { steps: [], undone: [] }
  const edited = recordDraftSteps(initial, addDirectEdit(original, initial.steps, 1, "Antes"))
  const undone = undoDraft(edited)
  assert.equal(recordDraftSteps(undone, addDirectEdit(original, undone.steps, 1, "Original")), undone)
  const branched = recordDraftSteps(undone, addDirectEdit(original, undone.steps, 1, "Nuevo"))
  assert.equal(branched.undone.length, 0)
  assert.equal(draftPages(original, redoDraft(branched).steps)[0].text, "Nuevo")
})

test("envía las páginas revisadas y recibe el archivo Word", async () => {
  const pages = [{ number: 1, text: "USD 8.500" }]
  const type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  const result = await exportDocx(pages, async (url, options) => {
    assert.equal(url, "/api/documents/docx")
    assert.deepEqual(JSON.parse(String(options?.body)), { pages })
    return new Response("PK", { headers: { "Content-Type": type } })
  })
  assert.equal(result.type, type)
  await assert.rejects(exportDocx(pages, async () => new Response("HTML")), /Word válido/)
})

test("solo confirma el envío remoto cuando hay consentimiento", async () => {
  const pages = [{ number: 1, text: "USD 8.000" }]
  const action = { action: "ask", question: "¿Cuánto se autorizó?" } as const
  const answer = "Se autorizaron USD 8.000."
  const citations = [{ page: 1, excerpt: "USD 8.000" }]
  const reply = () => Response.json({ provider: "opencode-console", status: "answered", answer, citations })
  await assert.rejects(queryDocument(pages, action, async (_url, options) => {
    assert.equal(new Headers(options?.headers).has("X-Document-Remote"), false)
    return reply()
  }), /respuesta remota no válida/)
  const result = await queryDocument(pages, action, async (_url, options) => {
    assert.equal(new Headers(options?.headers).get("X-Document-Remote"), "opencode-console")
    return reply()
  }, true)
  assert.deepEqual(result, { status: "answered", answer, citations })
})

# Referencia de la API local

Base URL: `http://127.0.0.1:8000`. FastAPI publica el contrato completo en [`/docs`](http://127.0.0.1:8000/docs) y [`/openapi.json`](http://127.0.0.1:8000/openapi.json) al iniciar la API. No está diseñada para exponerse fuera del equipo.

## Rutas

| Método y ruta | Entrada | Resultado |
| --- | --- | --- |
| `GET /api/health` | — | `{"status":"ok"}` |
| `GET /api/provider/probe` | — | `{provider, message}`; detecta configuración, no comprueba conectividad con un modelo. |
| `POST /api/documents/pdf/preview` | PDF binario (`application/pdf`) | `{pages}` |
| `POST /api/documents/docx/preview` | DOCX binario (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`) | `{pages}` |
| `POST /api/documents/txt/preview` | TXT UTF-8 (`text/plain`) | `{pages}` |
| `POST /api/documents/query` | `{pages, action:"ask", question}` o `{pages, action:"summarize"}` | `{provider, status, citations, answer?}` |
| `POST /api/documents/summary/plan` | `{pages}` | `{blocks: [{pages}, …]}`; requiere Ollama. |
| `POST /api/documents/summary/block` | Un bloque `{pages}` | Resumen parcial con citas; conserva números de origen. |
| `POST /api/documents/summary/global` | `{pages, blocks: [{answer, citations}, …]}` | Síntesis con referencias verificadas; requiere todos los bloques con citas. |
| `POST /api/documents/rewrite` | `{text, instruction}` | `{text}` con la propuesta; requiere Ollama. |
| `POST /api/documents/docx` | `{pages, source_type?}` | Descarga `documento-editado.docx`; `source_type` acepta `pdf` (predeterminado), `docx` o `txt`. |

`pages` contiene segmentos `{number, text}`. El número identifica la página, párrafo o línea de origen y empieza en 1. Una cita tiene forma `{page, excerpt}`. Los estados de consulta son `answered`, `not_found` y `summarized`. `answer` puede omitirse, por ejemplo en modo simulado, que devuelve fragmentos en `citations`. Cuando el proveedor es Console, la ruta de consulta requiere `X-Document-Remote: opencode-console`; este encabezado expresa el consentimiento de la interfaz, no autentica al usuario.

## Ejemplo en PowerShell

Con FastAPI iniciado y desde la raíz del repositorio:

```powershell
$base = 'http://127.0.0.1:8000'
$preview = Invoke-RestMethod "$base/api/documents/pdf/preview" -Method Post `
  -ContentType 'application/pdf' -InFile './ejemplos/biblioteca-horizonte.pdf'
$query = @{
  action = 'ask'
  question = 'Cual es el presupuesto total aprobado?'
  pages = $preview.pages
} | ConvertTo-Json -Depth 6
Invoke-RestMethod "$base/api/documents/query" -Method Post `
  -ContentType 'application/json' -Body $query
```

La respuesta esperada cita el importe **USD 8.000**, página 3.

## Límites y errores

- Carga: hasta 10 MiB, 100 segmentos y 500.000 caracteres de texto extraído. Word tiene además un límite de tamaño descomprimido; no se lee el texto de sus tablas.
- `403`: falta la confirmación para el proveedor remoto. `409`: la función requiere Ollama local. `413`: archivo, texto o contexto exceden el límite. `415`: formato HTTP no admitido.
- `422`: el esquema no coincide o el contenido no es válido. `502`, `503` o `504`: el proveedor devolvió una respuesta inválida, no está disponible o agotó el tiempo de espera, según el caso. `not_found` es un resultado de consulta normal, no un error HTTP.

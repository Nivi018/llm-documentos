# Reproducir la demo de portafolio

Las demos usan **Playwright** para interactuar con la aplicación real y **HyperFrames + GSAP** para componer el video. Usan exclusivamente el PDF ficticio `ejemplos/biblioteca-horizonte.pdf`.

1. Inicia el frontend y FastAPI siguiendo el [README principal](../README.md#iniciar-en-windows). Usa el proveedor `stub` (`$env:LLM_PROVIDER = "stub"` antes de iniciar FastAPI).
2. En otra terminal, instala las herramientas. La grabación continua necesita `ffprobe` y `ffmpeg` de [FFmpeg](https://ffmpeg.org/download.html) en `PATH`:

   ```powershell
   cd demo
   npm.cmd ci
   npx.cmd playwright install chromium
   ```

   Si el frontend usa otro puerto, define `DEMO_APP_URL`, por ejemplo `$env:DEMO_APP_URL = "http://127.0.0.1:5178"`. La captura solo acepta la aplicación en `127.0.0.1` y comprueba que se descargue el DOCX. Los archivos intermedios quedan en `demo/assets/` y no se versionan.
3. Graba el flujo, genera el MP4 y extrae una portada:

   ```powershell
   npm.cmd run capture:live
   npm.cmd run render:live
   ffmpeg -y -ss 16 -i ../docs/demo-flujo.mp4 -frames:v 1 -q:v 3 ../docs/demo-flujo-portada.jpg
   ```

   [`capture-live.mjs`](capture-live.mjs) graba un solo video del navegador con el cursor visible. Mide la duración real y genera la composición a partir de [`live.template.html`](live.template.html). La grabación incluye el área de contenido del navegador, no el escritorio ni el selector nativo de archivos.

## Versión por escenas

Si quieres regenerar el montaje anterior de 35 segundos:

   ```powershell
   npm.cmd run capture
   npm.cmd run lint
   npm.cmd run render
   ffmpeg -y -ss 17 -i ../docs/demo.mp4 -frames:v 1 -q:v 3 ../docs/demo-portada.jpg
   ```

La composición por escenas está en [`index.html`](index.html). Ninguno de estos flujos agrega dependencias al frontend ni al backend.

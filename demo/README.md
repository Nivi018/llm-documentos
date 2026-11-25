# Reproducir la demo de portafolio

La demo usa **Playwright** para interactuar con la aplicación real y **HyperFrames + GSAP** para montar las capturas con rótulos. Usa exclusivamente el PDF ficticio `ejemplos/biblioteca-horizonte.pdf`.

1. Inicia el frontend y FastAPI siguiendo el [README principal](../README.md#iniciar-en-windows). Usa el proveedor `stub` (`$env:LLM_PROVIDER = "stub"` antes de iniciar FastAPI).
2. En otra terminal, instala las herramientas y ejecuta la captura:

   ```powershell
   cd demo
   npm.cmd ci
   npx.cmd playwright install chromium
   npm.cmd run capture
   ```

   Si el frontend usa otro puerto, define `DEMO_APP_URL`, por ejemplo `$env:DEMO_APP_URL = "http://127.0.0.1:5178"`. La captura solo acepta la aplicación en `127.0.0.1` y comprueba que se descargue el DOCX. Los archivos intermedios quedan en `demo/assets/` y no se versionan.
3. Con [FFmpeg](https://ffmpeg.org/download.html) disponible en `PATH`, valida, genera el MP4 y extrae la portada:

   ```powershell
   npm.cmd run lint
   npm.cmd run render
   ffmpeg -y -ss 17 -i ../docs/demo.mp4 -frames:v 1 -q:v 3 ../docs/demo-portada.jpg
   ```

La composición está en [`index.html`](index.html). Este flujo es opcional y no agrega dependencias al frontend ni al backend.

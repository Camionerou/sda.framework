# MinerU: primera extraccion real

## Estado

Completado como corte LEAN manual, sin mocks ni datos demo.

## Que se hizo

- Se preparo un entorno aislado en `srv-ia-01`: `/home/sistemas/sda-mineru`.
- Se instalo MinerU `3.1.15` en virtualenv propio.
- Se descargo desde Supabase Storage un documento real del tenant:
  `SALDIVIA BUSES PORTFOLIO_compressed.pdf`.
- Se verifico el archivo en servidor:
  - `document_id`: `2e1c2b6b-e608-461a-aab7-1f4c4c34f408`
  - tamano: `1.189.107` bytes
  - paginas: `12`
  - sha256: `104f181bbf9f8d78d2412247669e580014cf535d1194d7cb583b8923e0f385c1`
- Se ejecuto MinerU real con backend `pipeline` y lenguaje `latin`.

## Rutas persistentes

- Input:
  `/home/sistemas/sda-mineru/input/2e1c2b6b-e608-461a-aab7-1f4c4c34f408/saldivia-buses-portfolio_compressed.pdf`
- Output:
  `/home/sistemas/sda-mineru/output/2e1c2b6b-e608-461a-aab7-1f4c4c34f408/mineru-pipeline`
- Log:
  `/home/sistemas/sda-mineru/logs/2e1c2b6b-e608-461a-aab7-1f4c4c34f408-mineru-pipeline.log`

## Artefactos generados

MinerU produjo salida real en:

- Markdown: `saldivia-buses-portfolio_compressed.md`
- Estructura: `saldivia-buses-portfolio_compressed_content_list.json`
- Estructura v2: `saldivia-buses-portfolio_compressed_content_list_v2.json`
- Intermedio: `saldivia-buses-portfolio_compressed_middle.json`
- Modelo: `saldivia-buses-portfolio_compressed_model.json`
- Debug visual: `layout.pdf` y `span.pdf`
- Imagenes extraidas en `images/`

Resumen de `content_list.json`:

- `84` items
- `40` imagenes
- `25` textos
- `19` headers
- paginas cubiertas: `0..11`

## Observaciones

- MinerU detecto la GPU disponible y reporto `GPU Memory: 95 GB`.
- Hay un proceso `vllm serve` preexistente en el servidor usando gran parte de la
  VRAM. No se modifico ni se detuvo porque no pertenece a este corte.
- El siguiente corte recomendado es integrar esta ejecucion real al
  `sda-compute-gateway`, manteniendo la separacion: upload primero, ingesta
  asincronica despues.

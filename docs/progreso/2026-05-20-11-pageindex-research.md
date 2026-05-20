# PageIndex: lectura de documentacion

Estado: investigado, pendiente de integracion.

## Hallazgos

- PageIndex genera un arbol jerarquico tipo tabla de contenidos, optimizado para
  navegacion por razonamiento.
- La documentacion oficial ofrece SDK cloud:
  - Python: `pip install -U pageindex`
  - JavaScript: `npm install @pageindex/sdk`
  - Requiere `PAGEINDEX_API_KEY`.
- El SDK cloud acepta PDFs y devuelve `doc_id`, estado de procesamiento y arbol.
- El repo open-source `VectifyAI/PageIndex` permite generar el arbol localmente
  desde PDF o Markdown.
- El repo open-source soporta LiteLLM para elegir modelo, por ejemplo OpenAI,
  DeepSeek u otros proveedores compatibles.
- El repo open-source no trae `pyproject.toml` ni `setup.py`; se integra mejor
  como worker Python aislado, submodulo/vendor, o copia controlada del paquete
  `pageindex/` mas sus dependencias.

## Decision tecnica

Para esta app conviene arrancar con el camino open-source/local, no con el SDK
cloud, porque `arquitectura.md` define PageIndex como libreria y no como
servicio externo.

## Implicancia para la app

El proximo paso natural es agregar un worker local de indexacion que:

1. Tome un `document_id`.
2. Descargue el PDF privado desde Supabase Storage usando service role.
3. Ejecute PageIndex sobre un archivo temporal.
4. Normalice el arbol generado.
5. Guarde el resultado en `doc_tree`.
6. Genere chunks iniciales para busqueda hibrida.
7. Actualice `documents.status` a `indexed`.

## Librerias verificadas

- `@pageindex/sdk`: version npm `0.8.0`, SDK cloud.
- `pageindex`: version PyPI `0.2.8`, SDK cloud. El wheel inspeccionado
  trae `PageIndexClient` y no trae el motor local `page_index_main`.
- `VectifyAI/PageIndex`: implementacion open-source para ejecucion local.
- Commit inspeccionado de `VectifyAI/PageIndex`: `7592163e2a376b3917181fff9ac1858dc5daa2c6`.
- Dependencias base del repo open-source: `litellm`, `pymupdf`, `PyPDF2`,
  `python-dotenv`, `pyyaml`.

## Fuentes

- https://docs.pageindex.ai/sdk
- https://docs.pageindex.ai/sdk/tree
- https://docs.pageindex.ai/js-sdk
- https://github.com/VectifyAI/PageIndex

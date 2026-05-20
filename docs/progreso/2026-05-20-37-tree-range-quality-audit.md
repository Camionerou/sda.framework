# Auditoria de calidad del arbol del PDF

Estado: verificado con PDF real extraido por MinerU y Tree Indexer Python en
`srv-ia-01`.

## Objetivo

Comparar el texto de paginas extraido por MinerU contra el arbol generado por el
LLM para detectar si la estructura, los titulos y los rangos de pagina son
correctos.

## PDF auditado

- Documento: `2e1c2b6b-e608-461a-aab7-1f4c4c34f408`.
- Extraccion MinerU: `63d9abe4-93d1-4471-bcfa-4466f0eba9ce`.
- Job post-fix: `7ec85fc7-f6a3-40e4-9e0e-328f8c887b00`.
- Paginas detectadas: 12.
- Chunks generados: 11.

## Hallazgos

La jerarquia generada por el LLM era buena: detecto portada, "QUIENES SOMOS",
familia de modelos, modelos Aries, diseno interior y diseno exterior.

El primer problema estaba en los rangos. Algunas secciones incluian la pagina
siguiente porque el prompt de verificacion exigia que el titulo estuviera al
principio absoluto del excerpt. En este PDF cada pagina repite logo, marca o
familia antes del titulo real, por eso el verificador podia responder
`appear_start=no` aunque la pagina si empezaba una nueva seccion.

## Fix aplicado

- Se relajo el prompt de verificacion para aceptar logos, marcas, headers o
  labels de familia antes del titulo.
- Se agrego una regla deterministica: si el titulo de la seccion aparece dentro
  de los primeros tokens de la pagina, esa pagina se trata como inicio de
  seccion aunque el LLM no lo haya marcado.
- Se ignoran paginas finales vacias al calcular el ultimo rango.

## Resultado post-fix

Arbol resultante:

- `Preface`: paginas 1-1.
- `QUIENES SOMOS`: paginas 2-2.
- `FAMILIA`: paginas 3-3.
- `FAMILIA > AriesTruck`: paginas 3-3.
- `FAMILIA > Aries30s`: paginas 4-4.
- `FAMILIA > Aries32s`: paginas 5-5.
- `FAMILIA > Aries330`: paginas 6-6.
- `FAMILIA > Aries345`: paginas 7-7.
- `FAMILIA > Aries365`: paginas 8-8.
- `DISEÑO INTERIOR`: paginas 9-9.
- `DISEÑO EXTERIOR`: paginas 10-11.

La pagina 12 esta vacia y no queda indexada como contenido.

## Nota de calidad

Hay 12 paginas pero 11 chunks porque los chunks son por nodo del arbol, no por
pagina fisica. Ademas, `FAMILIA` y `FAMILIA > AriesTruck` comparten la pagina 3:
eso es aceptable para retrieval jerarquico, pero mas adelante podemos hacer que
los nodos padre tengan solo summaries bottom-up para reducir duplicacion.

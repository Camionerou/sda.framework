import asyncio
import unittest

from app.tree_graph.nodes.detect_toc import detect_toc


def _run(coro):
    return asyncio.run(coro)


def _doc_with_toc() -> dict:
    pages = [
        {"page": 1, "text": "Portada"},
        {"page": 2, "text": "Indice\nIntroduccion ........ 3\nMetodo ........ 5\nResultados ........ 8\nConclusiones ........ 12"},
        {"page": 3, "text": "Introduccion\nEste documento describe..."},
        {"page": 4, "text": "Mas intro"},
        {"page": 5, "text": "Metodo\nLos pasos seguidos..."},
        {"page": 6, "text": "Mas metodo"},
        {"page": 7, "text": "Mas metodo"},
        {"page": 8, "text": "Resultados\nLos datos obtenidos..."},
        {"page": 9, "text": "Mas resultados"},
        {"page": 10, "text": "Mas resultados"},
        {"page": 11, "text": "Mas resultados"},
        {"page": 12, "text": "Conclusiones\nFinalmente..."},
    ]
    return {"raw_pages": pages, "prompt_pages": pages, "metrics": {}}


def _doc_no_toc() -> dict:
    pages = [
        {"page": 1, "text": "Solo texto sin estructura"},
        {"page": 2, "text": "Mas texto"},
    ]
    return {"raw_pages": pages, "prompt_pages": pages, "metrics": {}}


class DetectTocTests(unittest.TestCase):
    def test_detects_toc_and_resolves_to_physical_pages(self):
        result = _run(detect_toc(_doc_with_toc()))
        self.assertEqual(result["tree_mode"], "toc_heuristic")
        self.assertEqual(len(result["candidate_sections"]), 4)
        titles = [s["title"] for s in result["candidate_sections"]]
        self.assertIn("Introduccion", titles)
        intro = next(s for s in result["candidate_sections"] if s["title"] == "Introduccion")
        self.assertEqual(intro["physical_index"], 3)

    def test_no_toc_falls_back(self):
        result = _run(detect_toc(_doc_no_toc()))
        self.assertEqual(result["tree_mode"], "no_toc")
        self.assertFalse(result["metrics"]["toc_detected"])

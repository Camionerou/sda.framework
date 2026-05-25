"""Carga los templates .j2 del filesystem al boot. Después de Wave 0, los
templates viven también en app_settings con scope override; el FS sirve
como fuente fallback cuando la setting no existe en DB."""

from pathlib import Path
from jinja2 import Environment, FileSystemLoader, select_autoescape

PROMPTS_DIR = Path(__file__).parent

_env = Environment(
    loader=FileSystemLoader(str(PROMPTS_DIR)),
    autoescape=select_autoescape([]),
    trim_blocks=True,
    lstrip_blocks=True,
)


def load_prompt_files() -> dict[str, str]:
    """Devuelve {nombre: source} de cada .j2 (sin extension)."""
    out: dict[str, str] = {}
    for path in PROMPTS_DIR.glob("*.j2"):
        if path.name.startswith("_"):
            continue   # _base.j2 no es un prompt independiente
        # render with extends => obtenemos source ya resuelto
        template = _env.get_template(path.name)
        source = path.read_text(encoding="utf-8")
        out[path.stem] = source
    return out


def render(template_source: str, context: dict) -> str:
    """Renderiza un template source (string) con el contexto provisto.

    Acepta `{% extends "_base.j2" %}` — usa el environment con FileSystemLoader
    así extends se resuelve.
    """
    template = _env.from_string(template_source)
    return template.render(**context)

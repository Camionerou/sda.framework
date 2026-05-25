"""Tree builder — convierte una lista plana de headers en árbol jerárquico.

Stack-based, respeta saltos de nivel (h1 → h3 promueve h3 a hijo de h1
en vez de fallar). Cada nodo recibe structure_code ("1.2.3") y node_id_str
("n_1_2_3"). end_index se infiere del próximo sibling o EOF.
"""

from dataclasses import dataclass, field
from typing import Iterator


@dataclass(frozen=True)
class FlatHeader:
    level: int
    title: str
    start_line: int
    text: str


@dataclass
class TreeNode:
    node_id_str: str
    structure_code: str
    depth: int
    title: str
    start_index: int
    end_index: int = 0
    text: str = ""
    children: list["TreeNode"] = field(default_factory=list)
    parent: "TreeNode | None" = None


def build_tree(headers: list[FlatHeader], *, total_lines: int) -> list[TreeNode]:
    """Construye el árbol. Devuelve nodos raíz (sin padre)."""
    roots: list[TreeNode] = []
    stack: list[TreeNode] = []                      # ancestros vivos
    sibling_counter: dict[int, int] = {}            # depth → count for structure_code

    for h in headers:
        # pop ancestros con depth >= h.level
        while stack and stack[-1].depth >= h.level:
            popped = stack.pop()
            # reset counters de descendientes del popped
            for d in list(sibling_counter):
                if d > popped.depth:
                    del sibling_counter[d]

        parent = stack[-1] if stack else None
        depth = h.level
        sibling_counter[depth] = sibling_counter.get(depth, 0) + 1
        # structure_code: cadena de contadores desde root al actual
        codes = []
        cur = parent
        chain = []
        while cur:
            chain.append(cur)
            cur = cur.parent
        for ancestor in reversed(chain):
            codes.append(ancestor.structure_code.split(".")[-1])
        codes.append(str(sibling_counter[depth]))
        structure_code = ".".join(codes)
        node_id_str = "n_" + "_".join(codes)

        node = TreeNode(
            node_id_str=node_id_str,
            structure_code=structure_code,
            depth=depth,
            title=h.title,
            start_index=h.start_line,
            text=h.text,
            parent=parent,
        )
        if parent is None:
            roots.append(node)
        else:
            parent.children.append(node)
        stack.append(node)

    # segundo pase: set end_index = start del próximo header al mismo o menor depth, o EOF
    all_in_order = list(flatten(roots))
    for i, n in enumerate(all_in_order):
        # buscar el próximo nodo en orden con depth <= n.depth (mismo o ancestro level)
        next_start = total_lines + 1
        for j in range(i + 1, len(all_in_order)):
            if all_in_order[j].depth <= n.depth:
                next_start = all_in_order[j].start_index
                break
        n.end_index = next_start - 1 if next_start <= total_lines else total_lines
    return roots


def flatten(nodes: list[TreeNode]) -> Iterator[TreeNode]:
    """Recorre el árbol en pre-orden, yielding cada nodo."""
    for n in nodes:
        yield n
        yield from flatten(n.children)

from sda_indexer.prompts.loader import load_prompt_files, render


def test_load_files_returns_summarize():
    prompts = load_prompt_files()
    assert "summarize" in prompts
    assert "{{ node_text }}" in prompts["summarize"] or "node_text" in prompts["summarize"]


def test_render_includes_context():
    prompts = load_prompt_files()
    rendered = render(prompts["summarize"], {
        "task_name": "summarize_node",
        "doc": {"title": "Doc", "doc_type": "manual", "page_count": 10},
        "ancestor_path": "Doc > Cap 1",
        "max_chars": 280,
        "language": "es",
        "node_text": "hola mundo",
    })
    assert "Doc" in rendered
    assert "hola mundo" in rendered

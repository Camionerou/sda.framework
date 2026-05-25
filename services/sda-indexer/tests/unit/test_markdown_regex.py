from sda_indexer.pipeline.parser.markdown_regex import parse_markdown_to_headers


def test_parses_simple_headers():
    md = """# Título

texto bajo título.

## Subsección

más texto.
"""
    headers = parse_markdown_to_headers(md)
    assert len(headers) == 2
    assert headers[0].level == 1
    assert headers[0].title == "Título"
    assert "texto bajo título" in headers[0].text
    assert headers[1].level == 2
    assert headers[1].title == "Subsección"


def test_skips_code_blocks():
    md = """# Real

```python
# fake header inside code block
def foo(): pass
```

más texto.

## Subsección real
"""
    headers = parse_markdown_to_headers(md)
    titles = [h.title for h in headers]
    assert "Real" in titles
    assert "Subsección real" in titles
    assert all("fake header" not in t for t in titles)


def test_records_start_line():
    md = "line0\n# h1\nbody\n## h2\n"
    headers = parse_markdown_to_headers(md)
    assert headers[0].start_line == 2
    assert headers[1].start_line == 4


def test_empty_markdown_yields_nothing():
    assert parse_markdown_to_headers("") == []
    assert parse_markdown_to_headers("just paragraph") == []

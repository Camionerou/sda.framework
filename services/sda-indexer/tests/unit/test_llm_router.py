"""Unit tests para llm/router.py — pure function, sin IO ni mocks."""

import pytest

from sda_indexer.llm.router import LLMConfig, Phase, route


def test_route_toc_returns_pro_model():
    cfg = route(
        Phase.TOC,
        settings_resolver=lambda key, **kw: {
            "llm.router.toc.model": "deepseek-chat",
            "llm.router.toc.temperature": 0.0,
        }[key],
    )
    assert isinstance(cfg, LLMConfig)
    assert cfg.model == "deepseek-chat"
    assert cfg.temperature == 0.0
    assert cfg.phase == Phase.TOC


def test_route_summarize_returns_flash_temperature():
    cfg = route(
        Phase.SUMMARIZE,
        settings_resolver=lambda key, **kw: {
            "llm.router.summarize.model": "deepseek-chat",
            "llm.router.summarize.temperature": 0.1,
        }[key],
    )
    assert cfg.temperature == 0.1


def test_route_validator_falls_back_to_structure_group():
    # validator y repair NO tienen settings propias — caen a structure
    cfg = route(
        Phase.VALIDATOR,
        settings_resolver=lambda key, **kw: {
            "llm.router.structure.model": "deepseek-chat",
            "llm.router.structure.temperature": 0.0,
        }[key],
    )
    assert cfg.model == "deepseek-chat"
    assert cfg.temperature == 0.0
    assert cfg.phase == Phase.VALIDATOR  # phase original preservada


def test_route_repair_falls_back_to_structure_group():
    cfg = route(
        Phase.REPAIR,
        settings_resolver=lambda key, **kw: {
            "llm.router.structure.model": "deepseek-chat",
            "llm.router.structure.temperature": 0.0,
        }[key],
    )
    assert cfg.model == "deepseek-chat"

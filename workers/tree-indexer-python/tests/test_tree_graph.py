import unittest
from unittest.mock import patch

from app.tree_graph import route_after_refine_collect, route_after_verify


def _state(
    *,
    accuracy: float,
    invalid_count: int,
    repair_attempts: int = 0,
    tree_mode: str = "toc",
) -> dict:
    return {
        "invalid_sections": [{} for _ in range(invalid_count)],
        "metrics": {"verification_accuracy": accuracy},
        "repair_attempts": repair_attempts,
        "tree_mode": tree_mode,
    }


class TreeGraphRoutingTests(unittest.TestCase):
    def test_route_after_verify_accepts_clean_tree(self) -> None:
        self.assertEqual(
            route_after_verify(_state(accuracy=1.0, invalid_count=0)),
            "post_process_tree",
        )

    def test_route_after_verify_repairs_partial_accuracy_once(self) -> None:
        with patch.dict("os.environ", {"SDA_TREE_DEGRADE_ATTEMPTS": "1", "SDA_TREE_REPAIR_ATTEMPTS": "1"}):
            self.assertEqual(
                route_after_verify(_state(accuracy=0.7, invalid_count=2)),
                "repair_sections",
            )
            self.assertEqual(
                route_after_verify(_state(accuracy=0.7, invalid_count=2, repair_attempts=1)),
                "degrade_mode",
            )

    def test_route_after_verify_degrades_low_accuracy_then_fails_if_still_low(self) -> None:
        with patch.dict("os.environ", {"SDA_TREE_DEGRADE_ATTEMPTS": "1", "SDA_TREE_REPAIR_ATTEMPTS": "1"}):
            self.assertEqual(
                route_after_verify(_state(accuracy=0.4, invalid_count=5)),
                "degrade_mode",
            )
            self.assertEqual(
                route_after_verify(_state(accuracy=0.4, invalid_count=5, tree_mode="no_toc")),
                "fail_verification",
            )

def _refine_state(*, last_refined: int, iteration: int) -> dict:
    return {
        "metrics": {"last_refined_node_count": last_refined},
        "refinement_iteration": iteration,
    }


class RefineRoutingTests(unittest.TestCase):
    def test_repeats_when_refined_and_under_limit(self) -> None:
        with patch.dict("os.environ", {"SDA_TREE_REFINE_MAX_ITERATIONS": "3"}):
            self.assertEqual(
                route_after_refine_collect(_refine_state(last_refined=2, iteration=1)),
                "select_refine_targets",
            )

    def test_proceeds_to_summaries_when_no_refines(self) -> None:
        self.assertEqual(
            route_after_refine_collect(_refine_state(last_refined=0, iteration=0)),
            "prepare_summaries",
        )

    def test_proceeds_to_summaries_at_iteration_limit(self) -> None:
        with patch.dict("os.environ", {"SDA_TREE_REFINE_MAX_ITERATIONS": "3"}):
            self.assertEqual(
                route_after_refine_collect(_refine_state(last_refined=2, iteration=3)),
                "prepare_summaries",
            )


if __name__ == "__main__":
    unittest.main()

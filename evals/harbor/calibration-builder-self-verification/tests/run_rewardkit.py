import json
import os
import shutil
import tempfile
from pathlib import Path

import rewardkit  # type: ignore[import-not-found]


DEFAULT_JUDGE = "anthropic/claude-sonnet-4-6"


def prepare_tests(source: Path, destination: Path, judge: str | None = None) -> None:
    shutil.copytree(source, destination, dirs_exist_ok=True)
    config_path = destination / "reward.toml"
    contents = config_path.read_text()
    selected = (judge or DEFAULT_JUDGE).strip() or DEFAULT_JUDGE
    expected = f"judge = {json.dumps(DEFAULT_JUDGE)}"
    replacement = f"judge = {json.dumps(selected)}"
    if contents.count(expected) != 1:
        raise ValueError("RewardKit judge configuration is not in the expected generated form")
    config_path.write_text(contents.replace(expected, replacement, 1))


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="advisor-rewardkit-") as temporary:
        tests_dir = Path(temporary) / "tests"
        prepare_tests(Path("/tests"), tests_dir, os.environ.get("REWARDKIT_JUDGE"))
        rewardkit.run(tests_dir, workspace="/app", output="/logs/verifier/reward.json")


if __name__ == "__main__":
    main()

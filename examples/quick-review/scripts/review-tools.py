#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "typer>=0.12",
#     "rich>=13",
# ]
# ///
"""
review-tools.py — git helpers for review skill.

Subcommands:
  extract-issue-ref   Extract issue number from the current branch name
  find-conventions    Locate and print project convention/guideline files
  get-branch          Diff between the current branch and the base branch
  get-staged          Diff of staged (index) changes
  get-working         Diff of working tree changes
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Annotated

import typer
from rich import print as rprint

app = typer.Typer(
    name="review-tools",
    help=(
        "Git-aware helpers for code review workflows.\n\n"
        "Run [bold]review-tools COMMAND --help[/] for details on each subcommand."
    ),
    no_args_is_help=True,
    rich_markup_mode="rich",
)


def _git(*args: str) -> tuple[str, int]:
    cmd = ["rtk", "git", *args] if shutil.which("rtk") else ["git", *args]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.stdout.strip(), result.returncode


@app.command()
def extract_issue_ref() -> None:
    """Extract the issue number from the current branch name.

    Looks for a numeric ref after '/' or '#' (e.g. feat/123-thing → 123)
    and prints it to stdout.
    """
    branch, rc = _git("rev-parse", "--abbrev-ref", "HEAD")
    if rc != 0 or not branch:
        rprint("[bold red]Error:[/] Not in a git repo.", file=sys.stderr)
        raise typer.Exit(code=1)

    match = re.search(r"[/#](\d+)", branch)
    if not match:
        rprint(
            f"[bold red]Error:[/] No issue ref found in branch: {branch}",
            file=sys.stderr,
        )
        raise typer.Exit(code=1)

    print(match.group(1))


@app.command()
def find_conventions() -> None:
    """Locate project convention/guideline files and report their sizes.

    Searches for CONTRIBUTING.md, *guidelines*, *standards*, and *conventions*
    files under the current directory, excluding .git and node_modules.
    Prints each file path and its word count.
    """
    _EXCLUDE = {".git", "node_modules"}
    _PATTERNS = ["CONTRIBUTING.md", "*guidelines*", "*standards*", "*conventions*"]

    seen: set[Path] = set()
    files: list[Path] = []
    for pattern in _PATTERNS:
        for f in sorted(Path(".").rglob(pattern)):
            if any(part in _EXCLUDE for part in f.parts) or not f.is_file():
                continue
            if f not in seen:
                seen.add(f)
                files.append(f)
    files.sort()

    if not files:
        rprint("[yellow]No convention files found.[/]", file=sys.stderr)
        raise typer.Exit(code=0)

    for f in files:
        words = len(f.read_text(errors="replace").split())
        print(f"{f}\t{words} words")


@app.command()
def get_branch(
    base: Annotated[
        str,
        typer.Option(
            "--base",
            "-b",
            help="Base branch to diff against. Auto-detected from origin/HEAD if omitted.",
        ),
    ] = "",
) -> None:
    """Print the diff between the current branch and the base branch.

    Auto-detects the default branch (main / master / develop) when --base is not
    provided by inspecting origin/HEAD and then trying common branch names.
    """
    if not base:
        ref, _ = _git("symbolic-ref", "refs/remotes/origin/HEAD")
        if ref:
            base = ref.replace("refs/remotes/origin/", "")

    if not base:
        for candidate in ("main", "master", "develop"):
            _, rc = _git("rev-parse", "--verify", f"origin/{candidate}")
            if rc == 0:
                base = candidate
                break

    if not base:
        rprint(
            "[bold red]Error:[/] Could not detect default branch. "
            "Set 'origin/HEAD' or pass --base explicitly.",
            file=sys.stderr,
        )
        raise typer.Exit(code=1)

    diff, _ = _git("diff", f"origin/{base}...HEAD", "-U5")
    if not diff:
        rprint(
            f"[bold red]Error:[/] No changes between current branch and origin/{base}.",
            file=sys.stderr,
        )
        raise typer.Exit(code=1)

    print(diff)


@app.command()
def get_staged() -> None:
    """Print the diff of staged (index) changes."""
    diff, _ = _git("diff", "--staged", "-U5")
    if not diff:
        rprint(
            "[bold red]Error:[/] No staged changes. Run 'git add' first.",
            file=sys.stderr,
        )
        raise typer.Exit(code=1)

    print(diff)


@app.command()
def get_working() -> None:
    """Print the diff of working tree changes (unstaged)."""
    diff, _ = _git("diff", "HEAD", "-U5")
    if not diff:
        rprint(
            "[bold red]Error:[/] No working tree changes (nothing differs from HEAD).",
            file=sys.stderr,
        )
        raise typer.Exit(code=1)

    print(diff)


if __name__ == "__main__":
    app()

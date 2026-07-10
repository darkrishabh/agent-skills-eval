#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# ///
"""setup_fixture.py — builds a throwaway git repo for quick-review's opencode evals.

`--run-mode opencode` gives the model real Bash/file access but every eval in
one CLI invocation shares a single `--opencode-dir`, so we can't hand each
eval its own repo. Instead this builds ONE repo with three independent diffs
baked in at once, so a single shared working directory can satisfy all three
`evals.json` cases:

  1. a commit on `feature/456-add-transfer`, one commit ahead of a fake
     `origin/main` -> exercises `get-branch`
  2. staged (index) changes on top of that commit         -> exercises `get-staged`
  3. unstaged working-tree changes on top of that          -> exercises `get-working`

Each stage plants specific, findable issues (SQL injection, a missing
authorization check, a plaintext-password cookie, an unauthenticated
destructive endpoint, logged credentials, deeply nested duplicate
conditionals) so the resulting review can be graded against concrete
assertions. A CONTRIBUTING.md is committed alongside so the skill's
convention-discovery step has something real to find and cite.

Safe to re-run: the target directory is deleted and rebuilt from scratch
every time, so a run that got mutated by an agent (e.g. a without_skill
baseline that tried to "fix" things instead of just reviewing) can always be
reset to a clean state before the next `agent-skills-eval` invocation.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path

HEADER = '''"""Tiny account service — fixture repo for the quick-review skill's evals."""
import sqlite3

DB_PATH = "accounts.db"
'''

GET_CONNECTION = '''

def get_connection():
    return sqlite3.connect(DB_PATH)
'''

HASH_PASSWORD = '''

def hash_password(password: str) -> str:
    import hashlib

    return hashlib.sha256(password.encode()).hexdigest()
'''

GET_USER_BY_ID = '''

def get_user_by_id(user_id: int):
    conn = get_connection()
    cursor = conn.execute(
        "SELECT id, username, balance FROM users WHERE id = ?", (user_id,)
    )
    return cursor.fetchone()
'''

LOGIN_V1 = '''

def login(username: str, password: str) -> bool:
    conn = get_connection()
    cursor = conn.execute(
        "SELECT id FROM users WHERE username = ? AND password_hash = ?",
        (username, hash_password(password)),
    )
    return cursor.fetchone() is not None
'''

# --- branch commit addition: SQL injection, no authz check, no rollback ---
TRANSFER = '''

def transfer(from_id: int, to_id: int, amount: float, current_user_id: int):
    """Move `amount` from one account to another."""
    conn = get_connection()
    conn.execute(
        f"UPDATE users SET balance = balance - {amount} WHERE id = {from_id}"
    )
    conn.execute(
        f"UPDATE users SET balance = balance + {amount} WHERE id = {to_id}"
    )
    conn.commit()
    return {"status": "ok"}
'''

# --- staged addition: plaintext password cookie + unauthenticated reset ---
LOGIN_V2 = '''

def login(username: str, password: str, remember_me: bool = False) -> dict:
    conn = get_connection()
    cursor = conn.execute(
        "SELECT id FROM users WHERE username = ? AND password_hash = ?",
        (username, hash_password(password)),
    )
    row = cursor.fetchone()
    if row is None:
        return {"ok": False}

    result = {"ok": True, "user_id": row[0]}
    if remember_me:
        # Persist credentials so the user does not have to log in again.
        result["remember_me_cookie"] = f"{username}:{password}"
    return result
'''

RESET_ALL_BALANCES = '''

def reset_all_balances(new_balance: float = 0.0):
    """Reset every account to `new_balance`. Used by the ops dashboard."""
    conn = get_connection()
    conn.execute("UPDATE users SET balance = ?", (new_balance,))
    conn.commit()
'''

# --- unstaged addition: logs the raw password, deeply nested duplicate branches ---
AUDIT_LOGGING = '''

import logging

logger = logging.getLogger(__name__)


def audit_login(username: str, password: str, success: bool):
    if success:
        if username:
            if password:
                logger.info("login success user=%s password=%s", username, password)
            else:
                logger.info("login success user=%s", username)
        else:
            logger.info("login success (no username)")
    else:
        if username:
            logger.warning("login failed user=%s password=%s", username, password)
        else:
            logger.warning("login failed (no username)")
'''

CONTRIBUTING = """# Contributing

## Coding Guidelines

- Every endpoint or function that touches account balances or credentials
  must include an explicit authorization check tying the request to the
  authenticated user.
- Never log secrets, passwords, or full account numbers — mask or omit them.
- Wrap multi-step balance updates in a transaction; a partial failure must
  never leave balances inconsistent.
"""


def run(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "target",
        nargs="?",
        default=str(Path(__file__).parent / "fixture-repo"),
        help="Directory to (re)create the fixture repo in. Default: evals/fixture-repo",
    )
    args = parser.parse_args()
    target = Path(args.target).resolve()

    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)

    run(target, "init", "-q", "-b", "main")
    run(target, "config", "user.email", "fixture@example.com")
    run(target, "config", "user.name", "Fixture Bot")

    main_content = HEADER + GET_CONNECTION + HASH_PASSWORD + GET_USER_BY_ID + LOGIN_V1
    (target / "app.py").write_text(main_content)
    (target / "CONTRIBUTING.md").write_text(CONTRIBUTING)
    run(target, "add", "-A")
    run(target, "commit", "-q", "-m", "Initial account service")

    # Fake origin/main so review-tools.py's get-branch auto-detection works
    # without a real network remote.
    run(target, "update-ref", "refs/remotes/origin/main", "HEAD")
    run(target, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")

    run(target, "checkout", "-q", "-b", "feature/456-add-transfer")
    branch_content = main_content + TRANSFER
    (target / "app.py").write_text(branch_content)
    run(target, "add", "-A")
    run(target, "commit", "-q", "-m", "Add balance transfer endpoint")

    # Staged: swap login() for the remember-me version, add reset_all_balances().
    staged_content = (
        HEADER + GET_CONNECTION + HASH_PASSWORD + GET_USER_BY_ID + LOGIN_V2 + TRANSFER + RESET_ALL_BALANCES
    )
    (target / "app.py").write_text(staged_content)
    run(target, "add", "-A")

    # Unstaged: append audit logging on top, left out of the index.
    working_content = staged_content + AUDIT_LOGGING
    (target / "app.py").write_text(working_content)

    print(f"Fixture repo ready at {target}")
    print("  branch:  feature/456-add-transfer, 1 commit ahead of origin/main (transfer())")
    print("  staged:  remember-me cookie + reset_all_balances()")
    print("  working: + audit_login() logging the raw password")


if __name__ == "__main__":
    main()

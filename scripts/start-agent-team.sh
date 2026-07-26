#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/start-agent-team.sh <task-slug> [--dry-run]

Example:
  ./scripts/start-agent-team.sh xss-fix --dry-run
  ./scripts/start-agent-team.sh xss-fix

The launcher:
  1. Requires a clean main branch.
  2. Creates separate Claude and Codex branches/worktrees.
  3. Opens both agents side by side in a tmux session.
EOF
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

TASK_SLUG="$1"
DRY_RUN=false

if [[ $# -eq 2 ]]; then
  if [[ "$2" != "--dry-run" ]]; then
    usage
    exit 2
  fi
  DRY_RUN=true
fi

if [[ ! "$TASK_SLUG" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Error: task-slug must use lowercase letters, numbers, and hyphens only." >&2
  exit 2
fi

for command_name in git tmux claude codex; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Error: required command not found: $command_name" >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
REPO_PARENT="$(dirname -- "$REPO_ROOT")"
REPO_NAME="$(basename -- "$REPO_ROOT")"

CLAUDE_BRANCH="agent/claude-$TASK_SLUG"
CODEX_BRANCH="agent/codex-$TASK_SLUG"
CLAUDE_WORKTREE="$REPO_PARENT/$REPO_NAME - Claude - $TASK_SLUG"
CODEX_WORKTREE="$REPO_PARENT/$REPO_NAME - Codex - $TASK_SLUG"
SESSION_NAME="emergency-$TASK_SLUG"

CURRENT_BRANCH="$(git -C "$REPO_ROOT" branch --show-current)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Error: run the launcher from a repository whose primary worktree is on main." >&2
  echo "Current branch: $CURRENT_BRANCH" >&2
  exit 1
fi

if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
  echo "Error: main working tree is not clean. Commit or stash changes first." >&2
  exit 1
fi

print_plan() {
  cat <<EOF
Agent team plan
  task:          $TASK_SLUG
  session:       $SESSION_NAME
  Claude branch: $CLAUDE_BRANCH
  Claude path:   $CLAUDE_WORKTREE
  Codex branch:  $CODEX_BRANCH
  Codex path:    $CODEX_WORKTREE
EOF
}

print_plan

if "$DRY_RUN"; then
  echo
  echo "Dry run complete. No branches, worktrees, or tmux sessions were created."
  exit 0
fi

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo
  echo "Session already exists; attaching: $SESSION_NAME"
  exec tmux attach-session -t "$SESSION_NAME"
fi

ensure_worktree() {
  local branch_name="$1"
  local worktree_path="$2"

  if git -C "$REPO_ROOT" worktree list --porcelain |
    awk '$1 == "worktree" { sub(/^worktree /, ""); print }' |
    grep -Fxq "$worktree_path"; then
    return
  fi

  if [[ -e "$worktree_path" ]]; then
    echo "Error: path exists but is not a registered worktree: $worktree_path" >&2
    exit 1
  fi

  if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$branch_name"; then
    git -C "$REPO_ROOT" worktree add "$worktree_path" "$branch_name"
  else
    git -C "$REPO_ROOT" worktree add "$worktree_path" -b "$branch_name" main
  fi
}

ensure_worktree "$CLAUDE_BRANCH" "$CLAUDE_WORKTREE"
ensure_worktree "$CODEX_BRANCH" "$CODEX_WORKTREE"

tmux new-session -d -s "$SESSION_NAME" -c "$CLAUDE_WORKTREE"
tmux split-window -h -t "$SESSION_NAME:0" -c "$CODEX_WORKTREE"
tmux send-keys -t "$SESSION_NAME:0.0" -l "claude"
tmux send-keys -t "$SESSION_NAME:0.0" Enter
tmux send-keys -t "$SESSION_NAME:0.1" -l "codex"
tmux send-keys -t "$SESSION_NAME:0.1" Enter
tmux select-layout -t "$SESSION_NAME:0" even-horizontal

echo
echo "Team started. Detach without stopping agents with Ctrl-b, then d."
exec tmux attach-session -t "$SESSION_NAME"

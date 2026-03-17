#!/usr/bin/env bash
#
# Verify agent backup integrity.
# Checks that all backed-up data is valid and restorable.
#
# Usage: ./scripts/verify-backup.sh
#

set -euo pipefail

# Resolve agent root directory (parent of scripts/)
AGENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$AGENT_DIR/data"
AGENT_NAME=$(grep 'agent_name:' "$AGENT_DIR/identity.yaml" 2>/dev/null | sed 's/agent_name: *"\?\([^"]*\)"\?/\1/' || echo "Agent")

passed=0
failed=0
warnings=0

pass() { echo "  + $1"; passed=$((passed + 1)); }
fail() { echo "  x $1"; failed=$((failed + 1)); }
warn() { echo "  ! $1"; warnings=$((warnings + 1)); }

echo "=== $AGENT_NAME Backup Verification ==="
echo ""

# --- SQLite Database Integrity ---

echo "1. SQLite databases"

for db in entity-graph timeline sleep messages; do
  db_path="$DATA_DIR/${db}.db"
  if [ ! -f "$db_path" ]; then
    warn "$db.db -- not created yet"
    continue
  fi

  # integrity check
  if command -v sqlite3 > /dev/null 2>&1; then
    result=$(sqlite3 "$db_path" "PRAGMA integrity_check;" 2>&1)
    if [ "$result" = "ok" ]; then
      pass "$db.db -- integrity OK"
    else
      fail "$db.db -- integrity FAILED: $result"
      continue
    fi

    # check it has tables
    table_count=$(sqlite3 "$db_path" "SELECT count(*) FROM sqlite_master WHERE type='table';" 2>&1)
    if [ "$table_count" -gt 0 ] 2>/dev/null; then
      pass "$db.db -- $table_count tables"
    else
      warn "$db.db -- no tables found"
    fi
  else
    warn "$db.db -- sqlite3 not installed, cannot verify"
  fi

  # check WAL is not stale
  wal_path="${db_path}-wal"
  if [ -f "$wal_path" ]; then
    wal_size=$(stat -f%z "$wal_path" 2>/dev/null || stat --printf="%s" "$wal_path" 2>/dev/null)
    if [ "$wal_size" -gt 1048576 ]; then
      warn "$db.db -- WAL is ${wal_size} bytes (>1MB). Run checkpoint before backup."
    else
      pass "$db.db -- WAL size OK (${wal_size} bytes)"
    fi
  fi
done

echo ""

# --- ChromaDB Data ---

echo "2. ChromaDB vector store"

chroma_dir="$DATA_DIR/chromadb"
if [ -d "$chroma_dir" ]; then
  file_count=$(find "$chroma_dir" -type f | wc -l | tr -d ' ')
  dir_size=$(du -sh "$chroma_dir" 2>/dev/null | cut -f1)
  if [ "$file_count" -gt 0 ]; then
    pass "ChromaDB -- $file_count files, $dir_size"
  else
    warn "ChromaDB -- directory exists but is empty"
  fi
else
  warn "ChromaDB -- data/chromadb/ not found (created on first run)"
fi

echo ""

# --- Claude Code Memory ---

echo "3. Claude Code memory"

memory_dir="$DATA_DIR/claude-memory"
if [ -d "$memory_dir" ]; then
  md_count=$(find "$memory_dir" -name "*.md" -type f | wc -l | tr -d ' ')
  if [ "$md_count" -gt 0 ]; then
    pass "Claude memory -- $md_count files synced"
  else
    warn "Claude memory -- directory exists but no .md files"
  fi

  if [ -f "$memory_dir/MEMORY.md" ]; then
    pass "MEMORY.md index present"
  else
    warn "MEMORY.md index missing"
  fi
else
  warn "Claude memory -- data/claude-memory/ not synced yet"
fi

echo ""

# --- Identity & Config Files ---

echo "4. Identity & configuration"

for f in SOUL.md USER.md HEARTBEAT.md identity.yaml; do
  if [ -f "$AGENT_DIR/$f" ]; then
    pass "$f present"
  else
    fail "$f missing"
  fi
done

echo ""

# --- Skills ---

echo "5. Skills"

skills_dir="$AGENT_DIR/skills"
if [ -d "$skills_dir" ]; then
  skill_count=$(find "$skills_dir" -name "SKILL.md" -type f | wc -l | tr -d ' ')
  pass "$skill_count skills installed"
else
  fail "skills/ directory missing"
fi

echo ""

# --- Brain Notes ---

echo "6. Brain notes"

brain_dir="$AGENT_DIR/brain"
if [ -d "$brain_dir" ]; then
  note_count=$(find "$brain_dir" -name "*.md" -type f | wc -l | tr -d ' ')
  pass "$note_count brain notes"
else
  warn "brain/ directory missing"
fi

echo ""

# --- Git State ---

echo "7. Git state"

cd "$AGENT_DIR"

if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  pass "Git repository valid"

  last_commit=$(git log --oneline -1 2>/dev/null)
  if [ -n "$last_commit" ]; then
    pass "Last commit: $last_commit"
  else
    warn "No commits yet"
  fi

  remote_url=$(git remote get-url origin 2>/dev/null || echo "none")
  if [ "$remote_url" != "none" ]; then
    pass "Remote: $remote_url"
  else
    fail "No remote configured"
  fi

  # Check if local is ahead of remote
  git fetch origin --quiet 2>/dev/null || true
  ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo "?")
  if [ "$ahead" != "?" ] && [ "$ahead" -gt 0 ]; then
    warn "Local is $ahead commit(s) ahead of remote -- push needed"
  elif [ "$ahead" != "?" ]; then
    pass "In sync with remote"
  fi
else
  fail "Not a git repository"
fi

echo ""

# --- Summary ---

echo "=== Results ==="
echo "  Passed:   $passed"
echo "  Failed:   $failed"
echo "  Warnings: $warnings"
echo ""

if [ "$failed" -gt 0 ]; then
  echo "VERIFICATION FAILED -- $failed issue(s) need attention"
  exit 1
elif [ "$warnings" -gt 0 ]; then
  echo "BACKUP OK with $warnings warning(s)"
  exit 0
else
  echo "BACKUP VERIFIED -- all checks passed"
  exit 0
fi

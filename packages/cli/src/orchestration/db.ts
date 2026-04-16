/**
 * KyberBot — Orchestration Database
 *
 * SQLite persistence for the orchestration layer. Fleet-level database
 * at ~/.kyberbot/orchestration.db — shared across all agents.
 * Pattern matches runtime/bus-db.ts.
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { openWithRecovery } from '../brain/db-recovery.js';
import { createLogger } from '../logger.js';

const logger = createLogger('orch-db');
let db: Database.Database | null = null;

// ═══════════════════════════════════════════════════════════════════════════════
// CONNECTION
// ═══════════════════════════════════════════════════════════════════════════════

export function getOrchDb(): Database.Database {
  if (db) return db;

  const dir = join(homedir(), '.kyberbot');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const dbPath = join(dir, 'orchestration.db');
  db = openWithRecovery(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(SCHEMA);

  // Migrations for existing databases — check column existence before altering
  const columns = db.prepare("PRAGMA table_info(heartbeat_runs)").all() as Array<{name: string}>;
  const columnNames = new Set(columns.map(c => c.name));
  if (!columnNames.has('log_output')) {
    db.exec('ALTER TABLE heartbeat_runs ADD COLUMN log_output TEXT');
  }
  if (!columnNames.has('log_ref')) {
    db.exec('ALTER TABLE heartbeat_runs ADD COLUMN log_ref TEXT');
  }

  logger.info('Orchestration database initialized', { path: dbPath });
  return db;
}

export function resetOrchDb(): void {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
  }
  db = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMA
// ═══════════════════════════════════════════════════════════════════════════════

const SCHEMA = `
  -- Company settings (singleton row)
  CREATE TABLE IF NOT EXISTS company (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    name TEXT NOT NULL DEFAULT 'My Company',
    description TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO company (id, name) VALUES (1, 'My Company');

  -- Org chart
  CREATE TABLE IF NOT EXISTS org_nodes (
    agent_name TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    title TEXT,
    reports_to TEXT,
    is_ceo INTEGER NOT NULL DEFAULT 0,
    department TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (reports_to) REFERENCES org_nodes(agent_name)
  );
  CREATE INDEX IF NOT EXISTS idx_org_reports_to ON org_nodes(reports_to);

  -- Projects
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

  -- Goals
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    level TEXT NOT NULL CHECK(level IN ('company', 'team', 'agent')),
    owner_agent TEXT,
    parent_goal_id INTEGER,
    project_id INTEGER,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'cancelled')),
    due_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (owner_agent) REFERENCES org_nodes(agent_name),
    FOREIGN KEY (parent_goal_id) REFERENCES goals(id),
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );
  CREATE INDEX IF NOT EXISTS idx_goals_owner ON goals(owner_agent);
  CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_goal_id);
  CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);

  -- Goal KPIs
  CREATE TABLE IF NOT EXISTS goal_kpis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    target_value REAL,
    current_value REAL DEFAULT 0,
    unit TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
    UNIQUE(goal_id, name)
  );

  -- Issues / tasks
  CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    goal_id INTEGER,
    parent_id INTEGER,
    project_id INTEGER,
    assigned_to TEXT,
    created_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'backlog'
      CHECK(status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled')),
    priority TEXT NOT NULL DEFAULT 'medium'
      CHECK(priority IN ('critical', 'high', 'medium', 'low')),
    labels TEXT,
    checkout_by TEXT,
    checkout_at TEXT,
    due_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (goal_id) REFERENCES goals(id),
    FOREIGN KEY (parent_id) REFERENCES issues(id),
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );
  CREATE INDEX IF NOT EXISTS idx_issues_assigned ON issues(assigned_to);
  CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
  CREATE INDEX IF NOT EXISTS idx_issues_goal ON issues(goal_id);
  CREATE INDEX IF NOT EXISTS idx_issues_priority ON issues(priority);
  CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id);
  CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);

  -- Issue comments
  CREATE TABLE IF NOT EXISTS issue_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL,
    author_agent TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_comments_issue ON issue_comments(issue_id);

  -- Human inbox
  CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_agent TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    urgency TEXT NOT NULL DEFAULT 'normal' CHECK(urgency IN ('high', 'normal', 'low')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'acknowledged', 'resolved')),
    related_issue_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    resolved_by TEXT,
    FOREIGN KEY (related_issue_id) REFERENCES issues(id)
  );
  CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox(status);

  -- Activity log (append-only audit trail)
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity_log(actor);
  CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_activity_time ON activity_log(created_at DESC);

  -- Heartbeat run history
  CREATE TABLE IF NOT EXISTS heartbeat_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('orchestration', 'worker')),
    status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    prompt_summary TEXT,
    result_summary TEXT,
    tool_calls_json TEXT,
    error TEXT,
    log_output TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runs_agent ON heartbeat_runs(agent_name);
  CREATE INDEX IF NOT EXISTS idx_runs_time ON heartbeat_runs(started_at DESC);

  -- Orchestration settings (singleton row, stored alongside company)
  CREATE TABLE IF NOT EXISTS orchestration_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    orchestration_enabled INTEGER NOT NULL DEFAULT 1,
    heartbeat_interval TEXT NOT NULL DEFAULT '30m',
    active_hours_start TEXT,
    active_hours_end TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO orchestration_settings (id) VALUES (1);
`;

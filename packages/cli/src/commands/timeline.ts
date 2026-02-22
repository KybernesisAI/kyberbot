/**
 * Timeline Command
 *
 * Query temporal events - "What happened today?", "What did I discuss last week?"
 *
 * Usage:
 *   kyberbot timeline                    # Recent activity
 *   kyberbot timeline --today            # Today's events
 *   kyberbot timeline --yesterday        # Yesterday's events
 *   kyberbot timeline --week             # This week
 *   kyberbot timeline --search "query"   # Full-text search
 *   kyberbot timeline --seed             # Add test data
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  queryTimeline,
  getRecentActivity,
  getActivityOnDate,
  getTimelineStats,
  addToTimeline,
  searchTimeline,
  type TimelineEvent,
  type EventType,
} from '../brain/timeline.js';
import { getRoot } from '../config.js';

// ═══════════════════════════════════════════════════════════════════════════════
// DATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function getToday(): string {
  return new Date().toISOString().split('T')[0];
}

function getYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function getWeekStart(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
}

function formatDateShort(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// OUTPUT FORMATTERS
// ═══════════════════════════════════════════════════════════════════════════════

function getTypeColor(type: string): (text: string) => string {
  switch (type) {
    case 'conversation': return chalk.cyan;
    case 'idea': return chalk.yellow;
    case 'note': return chalk.green;
    case 'transcript': return chalk.magenta;
    case 'file': return chalk.white;
    case 'intake': return chalk.blue;
    default: return chalk.white;
  }
}

function formatEvents(events: TimelineEvent[], title: string): void {
  console.log(chalk.bold(`\n${title}`));
  console.log('');

  if (events.length === 0) {
    console.log(chalk.dim('  No events found.'));
    console.log('');
    return;
  }

  // Group by date
  const byDate: Map<string, TimelineEvent[]> = new Map();
  for (const event of events) {
    const dateKey = formatDateShort(event.timestamp);
    if (!byDate.has(dateKey)) {
      byDate.set(dateKey, []);
    }
    byDate.get(dateKey)!.push(event);
  }

  for (const [date, dateEvents] of byDate) {
    console.log(chalk.blue.bold(`  ${date}`));
    console.log('');

    for (const event of dateEvents) {
      const time = new Date(event.timestamp).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      });
      const typeColor = getTypeColor(event.type);

      console.log(`    ${chalk.dim(time)} ${typeColor(`[${event.type}]`)} ${chalk.white.bold(event.title)}`);

      if (event.summary) {
        const summary = event.summary.length > 150
          ? event.summary.slice(0, 150) + '...'
          : event.summary;
        console.log(chalk.dim(`           ${summary}`));
      }

      if (event.entities.length > 0) {
        console.log(chalk.dim(`           People/Orgs: ${event.entities.slice(0, 5).join(', ')}`));
      }

      if (event.topics.length > 0) {
        console.log(chalk.dim(`           Topics: ${event.topics.slice(0, 5).join(', ')}`));
      }

      console.log('');
    }
  }
}

function formatStats(stats: Awaited<ReturnType<typeof getTimelineStats>>): void {
  console.log(chalk.bold('\nTimeline Summary'));
  console.log('');
  console.log(`  Total events: ${stats.total_events}`);

  if (stats.date_range.earliest && stats.date_range.latest) {
    console.log(`  Date range: ${formatDateShort(stats.date_range.earliest)} - ${formatDateShort(stats.date_range.latest)}`);
  }

  console.log('');
  console.log(chalk.bold('  By Type'));

  const typeLabels: Record<EventType, string> = {
    conversation: 'Conversations',
    idea: 'Ideas',
    file: 'Files',
    transcript: 'Transcripts',
    note: 'Notes',
    intake: 'Intakes',
  };

  for (const [type, count] of Object.entries(stats.by_type)) {
    if (count > 0) {
      console.log(`    ${typeLabels[type as EventType]}: ${count}`);
    }
  }

  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST DATA
// ═══════════════════════════════════════════════════════════════════════════════

async function seedTestData() {
  const root = getRoot();
  console.log('Seeding timeline with test data...\n');

  const now = new Date();
  const today = now.toISOString();
  const yesterday = new Date(now.getTime() - 86400000).toISOString();
  const twoDaysAgo = new Date(now.getTime() - 172800000).toISOString();
  const threeDaysAgo = new Date(now.getTime() - 259200000).toISOString();

  await addToTimeline(root, {
    type: 'conversation',
    timestamp: today,
    title: 'Morning standup with team',
    summary: 'Discussed project progress, blockers on the API integration, and next sprint priorities.',
    source_path: '_processed/conversations/standup.md',
    entities: ['Alice', 'Bob'],
    topics: ['API', 'Sprint Planning'],
  });

  await addToTimeline(root, {
    type: 'idea',
    timestamp: new Date(now.getTime() - 3600000).toISOString(),
    title: 'Voice-first project intake',
    summary: 'What if the agent could listen to me describe a project and automatically classify it?',
    source_path: '_processed/ideas/voice-intake.md',
    entities: [],
    topics: ['Voice AI', 'Automation'],
  });

  await addToTimeline(root, {
    type: 'conversation',
    timestamp: yesterday,
    title: 'Product strategy session',
    summary: 'Reviewed roadmap with advisors. Need to emphasize the developer experience angle more.',
    source_path: '_processed/conversations/strategy-session.md',
    entities: ['Charlie', 'Diana'],
    topics: ['Strategy', 'Roadmap'],
  });

  await addToTimeline(root, {
    type: 'transcript',
    timestamp: new Date(new Date(yesterday).getTime() + 7200000).toISOString(),
    title: 'Architecture discussion',
    summary: 'Thinking through the agent memory architecture and how it connects to the brain layer.',
    source_path: '_processed/transcripts/architecture.md',
    entities: [],
    topics: ['Agent Memory', 'Architecture'],
  });

  await addToTimeline(root, {
    type: 'conversation',
    timestamp: twoDaysAgo,
    title: 'Performance deep-dive',
    summary: 'Identified three major bottlenecks in the app. Need to implement caching and connection pooling.',
    source_path: '_processed/conversations/performance.md',
    entities: [],
    topics: ['Performance', 'Optimization'],
  });

  await addToTimeline(root, {
    type: 'note',
    timestamp: threeDaysAgo,
    title: 'Tech ecosystem notes',
    summary: 'Mapped out key players, potential partners, and gaps in the ecosystem.',
    source_path: '_processed/notes/ecosystem-notes.md',
    entities: ['Acme Corp', 'TechHub'],
    topics: ['Ecosystem', 'Strategy'],
  });

  console.log('Added 6 test events to timeline.\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

interface TimelineOptions {
  today: boolean;
  yesterday: boolean;
  week: boolean;
  search?: string;
  type?: string;
  limit: string;
  seed: boolean;
  stats: boolean;
}

async function handleTimeline(options: TimelineOptions) {
  try {
    const root = getRoot();
    const limit = parseInt(options.limit) || 20;

    // Seed test data if requested
    if (options.seed) {
      await seedTestData();
    }

    // Show stats
    if (options.stats) {
      formatStats(await getTimelineStats(root));
      return;
    }

    let events: TimelineEvent[];
    let title: string;

    if (options.today) {
      events = await getActivityOnDate(root, getToday());
      title = "Today's Activity";
    } else if (options.yesterday) {
      events = await getActivityOnDate(root, getYesterday());
      title = "Yesterday's Activity";
    } else if (options.week) {
      events = await queryTimeline(root, {
        start: getWeekStart(),
        limit: 50,
      });
      title = 'This Week';
    } else if (options.search) {
      events = await searchTimeline(root, options.search, {
        limit,
        type: options.type as EventType | undefined,
      });
      title = `Search: "${options.search}"`;
    } else {
      // Default: recent activity
      events = await getRecentActivity(root, limit);
      title = 'Recent Activity';
    }

    formatEvents(events, title);

  } catch (error) {
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

export function createTimelineCommand(): Command {
  return new Command('timeline')
    .description('Query timeline of events and conversations')
    .option('--today', 'Show today\'s events', false)
    .option('--yesterday', 'Show yesterday\'s events', false)
    .option('--week', 'Show this week\'s events', false)
    .option('-s, --search <query>', 'Full-text search')
    .option('-t, --type <type>', 'Filter by type (conversation|idea|file|transcript|note|intake)')
    .option('-l, --limit <n>', 'Maximum number of results', '20')
    .option('--stats', 'Show timeline statistics', false)
    .option('--seed', 'Add test data', false)
    .action(handleTimeline);
}

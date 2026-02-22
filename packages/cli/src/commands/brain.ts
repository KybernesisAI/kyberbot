/**
 * Brain Command
 *
 * Local brain operations for querying, indexing, and managing
 * the knowledge base (ChromaDB + SQLite).
 *
 * Usage:
 *   kyberbot brain query <prompt>   # Ask the brain a question
 *   kyberbot brain add <file>       # Index a file into the brain
 *   kyberbot brain search <query>   # Semantic search
 *   kyberbot brain status           # Show brain health and stats
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync, existsSync } from 'fs';
import { basename, resolve } from 'path';
import { getRoot } from '../config.js';
import { createLogger } from '../logger.js';
import {
  initializeEmbeddings,
  isChromaAvailable,
  semanticSearch,
  indexDocument,
  getIndexStats,
} from '../brain/embeddings.js';
import { hybridSearch } from '../brain/hybrid-search.js';
import { getTimelineStats } from '../brain/timeline.js';
import { getEntityGraphStats } from '../brain/entity-graph.js';
import { getClaudeClient } from '../claude.js';

const logger = createLogger('brain-cmd');

export function createBrainCommand(): Command {
  const cmd = new Command('brain')
    .description('Local brain operations: query, add, search, status');

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot brain query <prompt>
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('query')
    .description('Ask the brain a question (uses search + AI synthesis)')
    .argument('<prompt>', 'Natural language question')
    .option('-l, --limit <n>', 'Number of context documents to retrieve', '5')
    .action(async (prompt: string, options: { limit: string }) => {
      try {
        const root = getRoot();
        const limit = parseInt(options.limit) || 5;

        console.log(chalk.dim(`Querying brain: "${prompt}"\n`));

        // Retrieve relevant context via hybrid search
        await initializeEmbeddings();
        const results = await hybridSearch(prompt, root, { limit });

        if (results.length === 0) {
          console.log(chalk.yellow('No relevant context found in the brain.'));
          console.log(chalk.dim('Try indexing some documents with `kyberbot brain add <file>`.'));
          return;
        }

        // Build context for Claude
        const contextBlocks = results.map((r, i) => {
          return `[${i + 1}] ${r.title} (${r.type}, ${new Date(r.timestamp).toLocaleDateString()})\n${r.content}`;
        }).join('\n\n---\n\n');

        const systemPrompt = [
          'You are a knowledge assistant. Answer the user\'s question using ONLY the provided context.',
          'If the context does not contain enough information, say so.',
          'Cite which sources you used by number (e.g., [1], [2]).',
        ].join(' ');

        const fullPrompt = `Context:\n\n${contextBlocks}\n\n---\n\nQuestion: ${prompt}`;

        const client = getClaudeClient();
        const answer = await client.complete(fullPrompt, {
          system: systemPrompt,
          model: 'haiku',
        });

        console.log(chalk.cyan.bold('Answer:'));
        console.log('');
        console.log(answer);
        console.log('');

        console.log(chalk.dim(`Sources (${results.length} documents retrieved):`));
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const score = (r.hybridScore * 100).toFixed(0);
          console.log(chalk.dim(`  [${i + 1}] ${r.title} (${score}% relevance)`));
        }
        console.log('');
      } catch (error) {
        logger.error('Brain query failed', { error: String(error) });
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot brain add <file>
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('add')
    .description('Index a file into the brain')
    .argument('<file>', 'Path to file to index')
    .option('-t, --type <type>', 'Document type (conversation, idea, file, transcript, note)', 'file')
    .option('--title <title>', 'Custom title (defaults to filename)')
    .action(async (file: string, options: { type: string; title?: string }) => {
      try {
        const filePath = resolve(file);

        if (!existsSync(filePath)) {
          console.error(chalk.red(`File not found: ${filePath}`));
          process.exit(1);
        }

        const content = readFileSync(filePath, 'utf-8');
        if (content.trim().length < 10) {
          console.error(chalk.red('File is too small to index (minimum 10 characters).'));
          process.exit(1);
        }

        await initializeEmbeddings();

        if (!isChromaAvailable()) {
          console.error(chalk.red('ChromaDB not available. Start with: docker-compose up -d'));
          process.exit(1);
        }

        const title = options.title || basename(filePath);
        const type = options.type as 'conversation' | 'idea' | 'file' | 'transcript' | 'note';
        const id = `manual-${Date.now()}-${basename(filePath).replace(/[^a-zA-Z0-9]/g, '-')}`;

        console.log(chalk.dim(`Indexing: ${title} (${type})`));

        const chunks = await indexDocument(id, content, {
          type,
          source_path: filePath,
          title,
          timestamp: new Date().toISOString(),
        });

        console.log(chalk.green(`Indexed "${title}" - ${chunks} chunk(s) created.`));
        console.log('');
      } catch (error) {
        logger.error('Brain add failed', { error: String(error) });
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot brain search <query>
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('search')
    .description('Semantic search across the brain')
    .argument('<query>', 'Search query')
    .option('-l, --limit <n>', 'Maximum results', '10')
    .option('--json', 'Output as JSON', false)
    .action(async (query: string, options: { limit: string; json: boolean }) => {
      try {
        const root = getRoot();
        const limit = parseInt(options.limit) || 10;

        await initializeEmbeddings();

        console.log(chalk.dim(`Searching: "${query}"\n`));

        const results = await hybridSearch(query, root, { limit });

        if (results.length === 0) {
          console.log(chalk.yellow('No results found.'));
          return;
        }

        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }

        console.log(chalk.cyan.bold(`Found ${results.length} results`));
        console.log(chalk.dim('-'.repeat(60)));

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const score = (r.hybridScore * 100).toFixed(1);
          const date = new Date(r.timestamp).toLocaleDateString();
          const matchLabel = r.matchType === 'both' ? chalk.green('S+K')
            : r.matchType === 'semantic' ? chalk.blue('SEM')
            : chalk.yellow('KEY');

          console.log('');
          console.log(chalk.cyan(`${i + 1}. ${r.title}`));
          console.log(chalk.dim(`   ${r.type} | ${date} | ${score}% | ${matchLabel}`));

          const snippet = r.content.slice(0, 200).replace(/\n/g, ' ');
          if (snippet) {
            console.log(chalk.white(`   "${snippet}${r.content.length > 200 ? '...' : ''}"`));
          }
        }

        console.log('');
      } catch (error) {
        logger.error('Brain search failed', { error: String(error) });
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot brain status
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('status')
    .description('Show brain health and statistics')
    .option('--json', 'Output as JSON', false)
    .action(async (options: { json: boolean }) => {
      try {
        const root = getRoot();

        // ChromaDB status
        await initializeEmbeddings();
        const indexStats = await getIndexStats();

        // Timeline stats
        let timelineStats;
        try {
          timelineStats = await getTimelineStats(root);
        } catch {
          timelineStats = null;
        }

        // Entity graph stats
        let entityStats;
        try {
          entityStats = await getEntityGraphStats(root);
        } catch {
          entityStats = null;
        }

        const status = {
          chromadb: {
            available: indexStats.available,
            totalChunks: indexStats.totalChunks,
          },
          timeline: timelineStats ? {
            totalEvents: timelineStats.total_events,
            dateRange: timelineStats.date_range,
            byType: timelineStats.by_type,
          } : null,
          entityGraph: entityStats ? {
            totalEntities: entityStats.total_entities,
            totalMentions: entityStats.total_mentions,
            totalRelations: entityStats.total_relations,
            byType: entityStats.by_type,
          } : null,
        };

        if (options.json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }

        console.log(chalk.bold('\nBrain Status\n'));

        // ChromaDB
        const chromaIcon = indexStats.available ? chalk.green('[connected]') : chalk.red('[offline]');
        console.log(`  ChromaDB:      ${chromaIcon}`);
        if (indexStats.available) {
          console.log(chalk.dim(`                 ${indexStats.totalChunks} chunks indexed`));
        } else {
          console.log(chalk.dim('                 Run: docker-compose up -d'));
        }

        // Timeline
        if (timelineStats) {
          console.log(`  Timeline:      ${chalk.green('[ready]')}`);
          console.log(chalk.dim(`                 ${timelineStats.total_events} events`));
        } else {
          console.log(`  Timeline:      ${chalk.yellow('[empty]')}`);
        }

        // Entity Graph
        if (entityStats && entityStats.total_entities > 0) {
          console.log(`  Entity Graph:  ${chalk.green('[ready]')}`);
          console.log(chalk.dim(`                 ${entityStats.total_entities} entities, ${entityStats.total_relations} relations`));
        } else {
          console.log(`  Entity Graph:  ${chalk.yellow('[empty]')}`);
        }

        console.log('');
      } catch (error) {
        logger.error('Brain status failed', { error: String(error) });
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });

  return cmd;
}

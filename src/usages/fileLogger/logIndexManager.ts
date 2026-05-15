/*---------------------------------------------------------------------------------------------
 *  Log Index Manager
 *  Responsible for reading, writing, updating and rebuilding index.json
 *  Index file path: <baseDir>/usages/index.json
 *  Used for quickly browsing date list without loading complete statistics for each date
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { StatusLogger } from '../../utils/statusLogger';
import { AtomicJsonFile } from '../atomicJsonFile';
import type { DateIndex, DateIndexEntry, TokenUsageStatsFromFile, TokenStats } from './types';

/**
 * Log Index Manager
 * Manages read/write operations for index.json file
 */
export class LogIndexManager {
    private readonly baseDir: string;

    constructor(baseDir: string) {
        this.baseDir = path.join(baseDir, 'usages');
    }

    /**
     * Get Index File Path
     * Path: <baseDir>/usages/index.json
     */
    getIndexPath(): string {
        return path.join(this.baseDir, 'index.json');
    }

    /**
     * Get Cache Timestamp Information
     * @returns Version timestamp and cache creation timestamp
     */
    async getCacheTimestamps(): Promise<{ versionTimestamp: number | null; cacheTimestamp: number | null }> {
        const index = await this.readIndex();
        if (!index) {
            return { versionTimestamp: null, cacheTimestamp: null };
        }
        return {
            versionTimestamp: index.versionTimestamp ?? null,
            cacheTimestamp: index.cacheTimestamp ?? null
        };
    }

    /**
     * Set Cache Timestamp
     * Sets both version timestamp and cache creation timestamp
     * @param versionTimestamp Code version timestamp
     * @param cacheTimestamp Cache creation timestamp (usually Date.now())
     */
    async setCacheTimestamps(versionTimestamp: number, cacheTimestamp: number): Promise<void> {
        const indexPath = this.getIndexPath();

        try {
            await AtomicJsonFile.runExclusive(indexPath, async () => {
                const index = (await this.readIndexFile(indexPath)) ?? { dates: {} };

                index.versionTimestamp = versionTimestamp;
                index.cacheTimestamp = cacheTimestamp;

                await this.saveIndexUnlocked(indexPath, index);
            });

            StatusLogger.debug(
                `[LogIndexManager] Updated cache timestamp: version=${new Date(versionTimestamp).toISOString()}, cache=${new Date(cacheTimestamp).toISOString()}`
            );
        } catch (err) {
            StatusLogger.warn('[LogIndexManager] Failed to set cache timestamp', err);
            throw err;
        }
    }

    /**
     * Read Date Index
     * Used to quickly get summary information for all dates
     */
    private async readIndex(): Promise<DateIndex | null> {
        const indexPath = this.getIndexPath();
        return this.readIndexFile(indexPath);
    }

    private async readIndexFile(indexPath: string): Promise<DateIndex | null> {
        if (!fsSync.existsSync(indexPath)) {
            return null;
        }

        try {
            const content = await fs.readFile(indexPath, 'utf-8');
            const index: DateIndex = JSON.parse(content);
            StatusLogger.debug(`[LogIndexManager] Read date index, total ${Object.keys(index.dates).length} dates`);
            return index;
        } catch (err) {
            StatusLogger.warn('[LogIndexManager] Failed to read date index', err);
            return null;
        }
    }

    private async saveIndexUnlocked(indexPath: string, index: DateIndex): Promise<void> {
        try {
            // Ensure base directory exists
            await this.ensureDirectoryExists(this.baseDir);

            // Write index file
            await AtomicJsonFile.writeJsonAtomically(indexPath, index);
            StatusLogger.debug(`[LogIndexManager] Saved date index, total ${Object.keys(index.dates).length} dates`);
        } catch (err) {
            StatusLogger.warn('[LogIndexManager] Failed to save date index', err);
            throw err;
        }
    }

    private buildDateIndexEntry(total: TokenStats): DateIndexEntry {
        return {
            total_input: total.actualInput,
            total_cache: total.cacheTokens,
            total_output: total.outputTokens,
            total_requests: total.requests
        };
    }

    private isSameDateIndexEntry(left: DateIndexEntry | undefined, right: DateIndexEntry): boolean {
        return (
            !!left &&
            left.total_input === right.total_input &&
            left.total_cache === right.total_cache &&
            left.total_output === right.total_output &&
            left.total_requests === right.total_requests
        );
    }

    /**
     * Update Date Index
     * Called after saving statistics data, updates index file
     */
    async updateIndex(dateStr: string, total: TokenStats): Promise<void> {
        const indexPath = this.getIndexPath();

        try {
            await AtomicJsonFile.runExclusive(indexPath, async () => {
                const index = (await this.readIndexFile(indexPath)) ?? { dates: {} };

                index.dates[dateStr] = this.buildDateIndexEntry(total);

                await this.saveIndexUnlocked(indexPath, index);
            });
        } catch (err) {
            StatusLogger.warn(`[LogIndexManager] Failed to update date index: ${dateStr}`, err);
            // Do not throw error, index update failure does not affect main flow
        }
    }

    /**
     * Delete Specified Date from Index
     * Called after deleting statistics data
     */
    async removeDate(dateStr: string): Promise<void> {
        const indexPath = this.getIndexPath();
        if (!fsSync.existsSync(indexPath)) {
            return;
        }

        try {
            await AtomicJsonFile.runExclusive(indexPath, async () => {
                const index = await this.readIndexFile(indexPath);
                if (!index?.dates[dateStr]) {
                    return;
                }

                delete index.dates[dateStr];
                await this.saveIndexUnlocked(indexPath, index);
                StatusLogger.debug(`[LogIndexManager] Deleted date from index: ${dateStr}`);
            });
        } catch (err) {
            StatusLogger.warn(`[LogIndexManager] Failed to delete date from index: ${dateStr}`, err);
            // Do not throw error, index update failure does not affect main flow
        }
    }

    /**
     * Get Summary Information for All Dates
     * Automatically synchronizes index with actual date folders, adds missing dates, removes non-existent dates
     */
    async getIndex(): Promise<Record<string, DateIndexEntry>> {
        const indexPath = this.getIndexPath();

        return AtomicJsonFile.runExclusive(indexPath, async () => {
            // Get all actual date folders
            const actualDates = await this.getAllStatsDates();
            const actualDateSet = new Set(actualDates);

            // Read existing index
            const index = await this.readIndexFile(indexPath);
            const summaries: Record<string, DateIndexEntry> = {};
            let hasChanges = false;

            // Reconcile all index entries based on actual stats.json, fix dirty summaries left by previous update failures
            for (const dateStr of actualDates) {
                actualDateSet.delete(dateStr);

                try {
                    const stats = await this.loadStats(dateStr);
                    if (!stats) {
                        continue;
                    }

                    const actualEntry = this.buildDateIndexEntry(stats.total);
                    const indexedEntry = index?.dates[dateStr];
                    summaries[dateStr] = actualEntry;

                    if (!this.isSameDateIndexEntry(indexedEntry, actualEntry)) {
                        hasChanges = true;
                        StatusLogger.debug(`[LogIndexManager] Date summary reconciled and fixed: ${dateStr}`);
                    }
                } catch (err) {
                    StatusLogger.warn(`[LogIndexManager] Failed to get date summary: ${dateStr}`, err);
                }
            }

            if (index) {
                // Validate date entries in index: remove dirty entries where directory doesn't exist or stats.json is missing
                for (const dateStr of Object.keys(index.dates)) {
                    // Entries already reconciled do not need further checking
                    if (dateStr in summaries) {
                        continue;
                    }

                    const dateFolder = path.join(this.baseDir, dateStr);
                    if (!fsSync.existsSync(dateFolder)) {
                        hasChanges = true;
                        StatusLogger.debug(`[LogIndexManager] Date folder doesn't exist in index, removed: ${dateStr}`);
                        continue;
                    }

                    // Directory exists but stats.json is missing or unreadable, also considered dirty entry
                    const statsFile = path.join(dateFolder, 'stats.json');
                    if (!fsSync.existsSync(statsFile)) {
                        hasChanges = true;
                        StatusLogger.debug(`[LogIndexManager] stats.json missing for date in index, removed: ${dateStr}`);
                    }
                }
            }

            // If there are changes (additions or deletions), update index file
            if (hasChanges) {
                const nextIndex: DateIndex = { dates: summaries };
                if (index?.versionTimestamp !== undefined) {
                    nextIndex.versionTimestamp = index.versionTimestamp;
                }
                if (index?.cacheTimestamp !== undefined) {
                    nextIndex.cacheTimestamp = index.cacheTimestamp;
                }
                await this.saveIndexUnlocked(indexPath, nextIndex);
            }

            return summaries;
        });
    }

    /**
     * Get All Saved Date List
     */
    private async getAllStatsDates(): Promise<string[]> {
        if (!fsSync.existsSync(this.baseDir)) {
            return [];
        }

        try {
            // Read all date directories
            const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
            const dates: string[] = [];

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const dateStr = entry.name;
                    // Check if it's a valid date format
                    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                        // Check if there's a statistics file in that date directory
                        const statsFile = path.join(this.baseDir, dateStr, 'stats.json');
                        if (fsSync.existsSync(statsFile)) {
                            dates.push(dateStr);
                        }
                    }
                }
            }

            return dates.sort().reverse(); // Descending order (newest first)
        } catch (err) {
            StatusLogger.error('[LogIndexManager] Failed to get statistics date list', err);
            return [];
        }
    }

    /**
     * Load Date Statistics
     */
    private async loadStats(dateStr: string): Promise<TokenUsageStatsFromFile | null> {
        const statsPath = path.join(this.baseDir, dateStr, 'stats.json');
        if (!fsSync.existsSync(statsPath)) {
            return null;
        }

        try {
            const content = await fs.readFile(statsPath, 'utf-8');
            return JSON.parse(content) as TokenUsageStatsFromFile;
        } catch (err) {
            StatusLogger.warn(`[LogIndexManager] Failed to read date statistics: ${dateStr}`, err);
            return null;
        }
    }

    /**
     * Ensure Directory Exists (recursive creation)
     */
    private async ensureDirectoryExists(dirPath: string): Promise<void> {
        try {
            // Synchronous check to avoid race conditions
            if (!fsSync.existsSync(dirPath)) {
                await fs.mkdir(dirPath, { recursive: true });
                StatusLogger.debug(`[LogIndexManager] Created directory: ${dirPath}`);
            }
        } catch (err) {
            // Ignore already exists error
            const error = err as NodeJS.ErrnoException;
            if (error.code !== 'EEXIST') {
                throw err;
            }
        }
    }
}

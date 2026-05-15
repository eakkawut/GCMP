/*---------------------------------------------------------------------------------------------
 *  Token File Logging System - Main Manager
 *  Integrates path management, write management, read management, and statistics management
 *--------------------------------------------------------------------------------------------*/

/**
 * Usage Cache Version Timestamp
 * Manual Update: When code changes cause cache format incompatibility, manually update this timestamp
 * Cache Judgment Logic: When stats.json modification time >= cache time, recalculation is required
 * After update, first run will automatically create new cache with current time, subsequent runs use stored cache time
 */
const USAGES_CACHE_VERSION_TIMESTAMP = new Date('2026-03-05T21:35:00+08:00').getTime();

import * as vscode from 'vscode';
import { StatusLogger } from '../../utils/statusLogger';
import { LogPathManager } from './logPathManager';
import { LogWriteManager } from './logWriteManager';
import { LogReadManager } from './logReadManager';
import { LogCleanupManager } from './logCleanupManager';
import { LogIndexManager } from './logIndexManager';
import { LogStatsManager } from './logStatsManager';
import { DateUtils } from './dateUtils';
import { EventEmitter } from 'events';
import type { DateIndexEntry, TokenRequestLog, TokenUsageStatsFromFile } from './types';

/**
 * Token File Log Manager
 * Main entry point, providing complete log recording and statistics functionality
 */
export class TokenFileLogger {
    private readonly pathManager: LogPathManager;
    private readonly writeManager: LogWriteManager;
    private readonly readManager: LogReadManager;
    private readonly cleanupManager: LogCleanupManager;
    private readonly indexManager: LogIndexManager;
    private readonly logStatsManager: LogStatsManager;
    private readonly eventEmitter: EventEmitter;

    // Pending logs in memory (requestId -> log)
    private pendingLogs = new Map<string, TokenRequestLog>();

    // pendingLogs cleanup task
    private pendingLogsCleanupTimer: ReturnType<typeof setInterval> | null = null;
    private readonly pendingLogsTTL: number = 5 * 60 * 1000; // 5 minutes TTL
    private readonly pendingLogsCleanupInterval: number = 60 * 1000; // Check every 1 minute

    // Cache version timestamp: caches earlier than this time will be recalculated
    // Manually controlled by constant USAGES_CACHE_VERSION_TIMESTAMP, read from or updated in index.json during initialize()
    cacheVersionTimestamp: number = 0;

    constructor(private context: vscode.ExtensionContext) {
        const storageDir = context.globalStorageUri.fsPath;

        this.pathManager = new LogPathManager(storageDir);
        this.writeManager = new LogWriteManager(this.pathManager);
        this.readManager = new LogReadManager(this.pathManager);
        this.indexManager = new LogIndexManager(storageDir);
        this.cleanupManager = new LogCleanupManager(this.pathManager, this.indexManager);
        this.logStatsManager = new LogStatsManager(this.readManager, storageDir, this.indexManager);
        this.eventEmitter = new EventEmitter();
    }

    /**
     * Initialize Logging System
     */
    async initialize(): Promise<void> {
        const startTime = Date.now();
        StatusLogger.info('[TokenFileLogger] File logging system initialization');

        const baseDir = this.pathManager.getBaseDir();
        StatusLogger.info(`[TokenFileLogger] Base directory: ${baseDir}`);

        // Initialize cache version timestamp
        await this.initCacheVersionTimestamp();

        // Start pendingLogs cleanup task
        this.startPendingLogsCleanup();

        const elapsed = Date.now() - startTime;
        StatusLogger.info(`[TokenFileLogger] File logging system initialization completed (elapsed: ${elapsed}ms)`);
    }

    /**
     * Initialize Cache Version Timestamp
     * Read cache creation time from index.json, create current time if not exists
     * Judgment Logic:
     * - If no version timestamp (old cache), recalculation is required
     * - If version timestamp < code version time, recalculation is required
     * - Otherwise use cache timestamp for judgment
     */
    private async initCacheVersionTimestamp(): Promise<void> {
        // Read timestamp stored in index.json
        const { versionTimestamp, cacheTimestamp } = await this.indexManager.getCacheTimestamps();

        // Determine if cache recreation is needed
        // Condition: no version timestamp (old cache) or version timestamp less than code version time
        const needsRecreate = !versionTimestamp || versionTimestamp < USAGES_CACHE_VERSION_TIMESTAMP;

        if (needsRecreate) {
            // Create current time as cache time
            const now = Date.now();
            await this.indexManager.setCacheTimestamps(USAGES_CACHE_VERSION_TIMESTAMP, now);
            this.cacheVersionTimestamp = now;
            StatusLogger.debug(
                `[TokenFileLogger] Created new cache: version=${new Date(USAGES_CACHE_VERSION_TIMESTAMP).toISOString()}, cache=${new Date(this.cacheVersionTimestamp).toISOString()}`
            );
        } else {
            // Use stored cache time
            this.cacheVersionTimestamp = cacheTimestamp || 0;
            StatusLogger.debug(
                `[TokenFileLogger] Using existing cache: version=${new Date(versionTimestamp).toISOString()}, cache=${new Date(this.cacheVersionTimestamp).toISOString()}`
            );
        }

        // Synchronize update timestamp in LogStatsManager
        // Pass both code version timestamp and cache creation timestamp
        this.logStatsManager.updateCacheVersionTimestamp(this.cacheVersionTimestamp, USAGES_CACHE_VERSION_TIMESTAMP);
    }

    /**
     * Start pendingLogs Cleanup Task
     * Periodically clear pending logs exceeding TTL to prevent memory leaks
     */
    private startPendingLogsCleanup(): void {
        // Regularly check and clean up expired pendingLogs
        this.pendingLogsCleanupTimer = setInterval(() => {
            this.cleanupExpiredPendingLogs();
        }, this.pendingLogsCleanupInterval);

        StatusLogger.debug(
            `[TokenFileLogger] pendingLogs cleanup task started (TTL: ${this.pendingLogsTTL}ms, check interval: ${this.pendingLogsCleanupInterval}ms)`
        );
    }

    /**
     * Clean Up Expired pendingLogs
     */
    private cleanupExpiredPendingLogs(): void {
        const now = Date.now();
        const expiredKeys: string[] = [];
        for (const [requestId, log] of this.pendingLogs.entries()) {
            const age = now - log.timestamp;
            if (age > this.pendingLogsTTL) {
                expiredKeys.push(requestId);
            }
        }

        if (expiredKeys.length > 0) {
            for (const requestId of expiredKeys) {
                this.pendingLogs.delete(requestId);
                StatusLogger.warn(
                    `[TokenFileLogger] Cleaned up expired pendingLog: ${requestId} (not updated for ${this.pendingLogsTTL}ms)`
                );
            }
            StatusLogger.info(`[TokenFileLogger] Cleaned up ${expiredKeys.length} expired pendingLogs`);
        }
    }

    /**
     * Get Storage Directory Path
     */
    getStorageDir(): string {
        return this.pathManager.getBaseDir();
    }

    // ==================== Write Operations ====================

    /**
     * Get Provider Display Name (handle special cases)
     * Example: when providerKey is "kimi", display name should be "Kimi"
     */
    private getProviderDisplayName(providerKey: string, providerName: string): string {
        // Special handling: kimi displays as Kimi
        if (providerKey === 'kimi') {
            return 'Kimi';
        }
        return providerName;
    }

    /**
     * Record Estimated Token (call before request)
     */
    async recordEstimatedTokens(params: {
        requestId: string;
        providerKey: string;
        providerName: string;
        modelId: string;
        modelName: string;
        estimatedInput: number;
        maxInputTokens?: number;
        requestType?: 'chat' | 'completion' | 'fim' | 'nes';
        timestamp?: number; // Optional: custom timestamp (for test data generation)
    }): Promise<void> {
        const now = params.timestamp ?? Date.now();

        // Get display name (handle special cases)
        const displayName = this.getProviderDisplayName(params.providerKey, params.providerName);

        const log: TokenRequestLog = {
            requestId: params.requestId,
            timestamp: now,
            isoTime: new Date(now).toISOString(),
            providerKey: params.providerKey,
            providerName: displayName,
            modelId: params.modelId,
            modelName: params.modelName,
            estimatedInput: params.estimatedInput,
            rawUsage: null,
            status: 'estimated',
            maxInputTokens: params.maxInputTokens,
            requestType: params.requestType
        };

        // Temporarily store in memory
        this.pendingLogs.set(params.requestId, log);

        // Write to file
        await this.writeManager.appendLog(log);

        // Notify status bar of new estimated request
        this.notifyUpdate();

        StatusLogger.info(
            `[TokenFileLogger] Recorded estimated token: ${params.requestId}, model=${params.modelName}, tokens=${params.estimatedInput}`
        );
    }

    /**
     * Update Actual Token (call after request completes)
     * Only the current instance calculates and saves statistics when request completes
     */
    async updateActualTokens(params: {
        requestId: string;
        rawUsage?: TokenRequestLog['rawUsage'];
        status: 'completed' | 'failed';
        /** Stream start time (millisecond timestamp) */
        streamStartTime?: number;
        /** Stream end time (millisecond timestamp) */
        streamEndTime?: number;
    }): Promise<void> {
        const pendingLog = this.pendingLogs.get(params.requestId);

        if (!pendingLog) {
            StatusLogger.warn(`[TokenFileLogger] Pending log not found for update: ${params.requestId}`);
            return;
        }

        // Timestamp update logic:
        // - If current time matches original record time (millisecond level), add +1ms to original timestamp
        // - Otherwise use current timestamp
        // This ensures multiple updates within the same millisecond maintain order, while updates at different times use accurate current time
        const now = Date.now();
        const originalTimestamp = pendingLog.timestamp;
        const isSameTime = now === originalTimestamp;
        if (isSameTime) {
            // Within same millisecond, +1ms to maintain order
            pendingLog.timestamp = originalTimestamp + 1;
        } else {
            // At different time, use current time
            pendingLog.timestamp = now;
        }

        pendingLog.isoTime = new Date(pendingLog.timestamp).toISOString();

        // Update log object
        pendingLog.rawUsage = params.rawUsage ?? null;
        pendingLog.status = params.status;

        // Update stream time info (if provided)
        if (params.streamStartTime !== undefined) {
            pendingLog.streamStartTime = params.streamStartTime;
        }
        if (params.streamEndTime !== undefined) {
            pendingLog.streamEndTime = params.streamEndTime;
        }

        // Write to file (append new line, form sequential record)
        await this.writeManager.appendLog(pendingLog);

        // Remove from memory
        this.pendingLogs.delete(params.requestId);

        // Only the current instance immediately calculates statistics when request completes
        // This avoids issues with multiple instances calculating simultaneously
        await this.refreshCurrentStats();

        // Notify listeners of this instance
        this.notifyUpdate();

        StatusLogger.info(
            `[TokenFileLogger] Updated actual token: ${params.requestId}, status=${params.status}, rawUsage=${params.rawUsage ? 'recorded' : 'not recorded'}`
        );
    }

    // ==================== Read and Statistics Operations ====================

    /**
     * Get Today's Statistics
     */
    async getTodayStats(): Promise<TokenUsageStatsFromFile> {
        const dateStr = DateUtils.getTodayDateString();
        return this.logStatsManager.getDateStats(dateStr);
    }

    /**
     * Get Statistics for Specified Date
     * Prioritize reading from cache
     */
    async getDateStats(dateStr: string): Promise<TokenUsageStatsFromFile> {
        return this.logStatsManager.getDateStats(dateStr);
    }

    /**
     * Get Statistics for Specified Date (direct calculation, ignore cache)
     * Suitable for detail views, ensuring display of latest accurate data
     */
    async getDateStatsFromFile(dateStr: string): Promise<TokenUsageStatsFromFile> {
        return this.logStatsManager.getDateStats(dateStr, true);
    }

    /**
     * Get All Hour Statistics for Specified Date
     */
    async getAllHourStats(dateStr: string): Promise<TokenUsageStatsFromFile | null> {
        // Attempt to read complete date statistics from persistent stats file (includes all hours)
        const saved = await this.logStatsManager.getDateStats(dateStr);
        if (saved && saved.hourly && Object.keys(saved.hourly).length > 0) {
            StatusLogger.debug(
                `[TokenFileLogger] Read all hour statistics from cache: ${dateStr}, hour count=${Object.keys(saved.hourly).length}`
            );
            return saved;
        }
        // If no persistent stats file exists, return null, letting caller decide if calculation is needed
        return null;
    }

    /**
     * Check and Regenerate Expired Statistics
     * Called when opening statistics page, ensuring all dates' stats.json are up to date
     * @returns Successfully regenerated date statistics
     */
    async regenerateOutdatedStats(): Promise<Record<string, TokenUsageStatsFromFile>> {
        return this.logStatsManager.regenerateOutdatedStats();
    }

    /**
     * Read Original Logs for Specified Date
     */
    async readDateLogs(dateStr: string): Promise<TokenRequestLog[]> {
        return this.readManager.readDateLogs(dateStr);
    }

    /**
     * Get Request Details List (final status for each requestId)
     * Used for detail page display
     */
    async getRequestDetails(dateStr: string): Promise<TokenRequestLog[]> {
        return this.readManager.getRequestDetails(dateStr);
    }

    /**
     * Get Recent Request Details (performance optimized version)
     * Only reads the most recent N requests, avoiding loading entire date data when there arelogs logs
     * Used for status bar and other scenarios requiring fast response
     */
    async getRecentRequestDetails(dateStr: string, limit: number = 100): Promise<TokenRequestLog[]> {
        return this.readManager.getRecentRequestDetails(dateStr, limit);
    }

    /**
     * Get Pending Logs Still in Progress (requests in memory)
     * These requests have recorded estimates but are not yet completed
     */
    getPendingLogs(): TokenRequestLog[] {
        return Array.from(this.pendingLogs.values());
    }

    /**
     * Get Summary Information for All Dates
     * Used for date list display, avoiding loading complete stats.json
     */
    async getIndex(): Promise<Record<string, DateIndexEntry>> {
        return this.indexManager.getIndex();
    }

    // ==================== Cleanup Operations ====================

    /**
     * Clean Up Expired Logs and Statistics (retain most recent N days)
     */
    async cleanupExpiredLogs(retentionDays: number): Promise<number> {
        return this.cleanupManager.cleanupExpiredLogs(retentionDays);
    }

    // ==================== Management Operations ====================

    /**
     * Flush Write Queue
     */
    async flush(): Promise<void> {
        await this.writeManager.flush();
    }

    /**
     * Destroy Logging System
     */
    async dispose(): Promise<void> {
        try {
            // Stop pendingLogs cleanup task
            if (this.pendingLogsCleanupTimer) {
                clearInterval(this.pendingLogsCleanupTimer);
                this.pendingLogsCleanupTimer = null;
                StatusLogger.debug('[TokenFileLogger] pendingLogs cleanup task stopped');
            }

            // Check if there are pending logs
            const pendingLogCount = this.pendingLogs.size;
            if (pendingLogCount > 0) {
                StatusLogger.warn(
                    `[TokenFileLogger] Found ${pendingLogCount} pending log records during destruction, these records may contain incomplete requests`
                );
                // Clean up pending logs
                this.pendingLogs.clear();
            }

            // Clean up event listeners
            this.eventEmitter.removeAllListeners();
            StatusLogger.debug('[TokenFileLogger] Event listeners cleaned up');

            // Wait for write queue to complete and destroy
            await this.writeManager.dispose();
            StatusLogger.debug('[TokenFileLogger] Write manager destroyed');

            StatusLogger.info('[TokenFileLogger] File logging system destroyed');
        } catch (error) {
            StatusLogger.error('[TokenFileLogger] Error occurred while destroying logging system:', error);
            throw error;
        }
    }

    /**
     * Listen for Statistics Update Events
     */
    onStatsUpdate(listener: () => void): vscode.Disposable {
        this.eventEmitter.on('update', listener);
        return {
            dispose: () => {
                this.eventEmitter.off('update', listener);
            }
        };
    }

    /**
     * Notify Statistics Update
     */
    private notifyUpdate(): void {
        this.eventEmitter.emit('update');
    }

    // ==================== Private Helper Methods ====================

    /**
     * Refresh Current Date Statistics (call immediately after request ends)
     * Ensures statistics are up to date, cache maintained by upper-level caller (usagesStatusBar)
     */
    private async refreshCurrentStats(): Promise<void> {
        const dateStr = DateUtils.getTodayDateString();

        try {
            // Wait for write queue to complete
            await this.writeManager.flush();

            // Calculate and save statistics (getDateStats automatically handles incremental updates and saving)
            await this.logStatsManager.getDateStats(dateStr, true);

            // Notify listeners of this instance
            this.notifyUpdate();

            StatusLogger.debug(`[TokenFileLogger] Hourly statistics refreshed: ${dateStr}`);
        } catch (err) {
            StatusLogger.warn('[TokenFileLogger] Failed to refresh statistics:', err);
        }
    }
}

// Export types
export type { TokenRequestLog, TokenUsageStatsFromFile } from './types';

// Export StatsCalculator
export { StatsCalculator } from './statsCalculator';

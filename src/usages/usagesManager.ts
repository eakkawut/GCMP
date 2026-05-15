/*---------------------------------------------------------------------------------------------
 *  Token Usages Manager
 *  Token Usage Manager - Based on fileLogger, no storage limit
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StatusLogger } from '../utils/statusLogger';
import { TokenFileLogger, TokenUsageStatsFromFile } from './fileLogger';
import { UsageParser, ExtendedTokenRequestLog } from './fileLogger/usageParser';
import { DateUtils } from './fileLogger/dateUtils';
import { EventEmitter } from 'events';
import type { DateSummary } from './types';
import type { GenericUsageData, RawUsageData, DateIndexEntry } from './fileLogger/types';

/**
 * Token Usage Manager
 * Global static object managing Token consumption statistics
 */
export class TokenUsagesManager {
    private fileLogger!: TokenFileLogger;
    private eventEmitter: EventEmitter;
    private initialized: boolean = false;

    private constructor() {
        this.eventEmitter = new EventEmitter();
    }

    /**
     * Global Instance
     */
    static readonly instance = new TokenUsagesManager();

    /**
     * Asynchronous Initialization (should be called during extension activation)
     */
    async initialize(context: vscode.ExtensionContext): Promise<void> {
        if (this.initialized) {
            StatusLogger.trace('[UsagesManager] Token Usage Manager already initialized, skipping duplicate initialization');
            return;
        }

        const startTime = Date.now();

        // Initialize file logging system
        this.fileLogger = new TokenFileLogger(context);
        await this.fileLogger.initialize();

        this.initialized = true;

        const elapsed = Date.now() - startTime;
        StatusLogger.debug(`[UsagesManager] Token Usage Manager initialization completed (elapsed: ${elapsed}ms)`);

        // Asynchronously clean up expired data in background (does not block initialization)
        this.scheduleBackgroundCleanup();
    }

    /**
     * Schedule Background Cleanup Task
     */
    private scheduleBackgroundCleanup(): void {
        // Use setImmediate to ensure execution in the next event loop without blocking the current flow
        setImmediate(async () => {
            try {
                const config = vscode.workspace.getConfiguration('ccmp.usages');
                const retentionDays = config.get<number>('retentionDays', 100);
                if (retentionDays > 0) {
                    StatusLogger.trace(`[UsagesManager] Starting background cleanup of expired data (retaining ${retentionDays} days)`);
                    const deletedCount = await this.fileLogger.cleanupExpiredLogs(retentionDays);
                    if (deletedCount > 0) {
                        StatusLogger.debug(`[UsagesManager] Background cleanup completed: deleted ${deletedCount} expired date entries`);
                    } else {
                        StatusLogger.trace('[UsagesManager] Background cleanup completed: no data to clean up');
                    }
                } else {
                    StatusLogger.trace('[UsagesManager] Data retention set to permanent, skipping cleanup');
                }
            } catch (error) {
                StatusLogger.warn(`[UsagesManager] Background cleanup of expired data failed: ${error}`);
            }
        });
    }

    /**
     * Get Storage Directory Path
     */
    getStorageDir(): string {
        if (!this.initialized) {
            throw new Error('TokenUsagesManager not yet initialized, please call initialize() method first');
        }
        return this.fileLogger.getStorageDir();
    }

    /**
     * Record Estimated Input Tokens (call before request)
     */
    async recordEstimatedTokens(params: {
        providerKey: string;
        displayName: string;
        modelId: string;
        modelName: string;
        estimatedInputTokens: number;
        maxInputTokens?: number;
        requestType?: 'chat' | 'completion' | 'fim' | 'nes';
        timestamp?: number; // Optional: custom timestamp (for test data generation)
    }): Promise<string> {
        if (!this.initialized) {
            throw new Error('TokenUsagesManager not yet initialized, please call initialize() method first');
        }

        const requestId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

        try {
            // Record to file logging system (do not wait for result)
            this.fileLogger
                .recordEstimatedTokens({
                    requestId,
                    providerKey: params.providerKey,
                    providerName: params.displayName,
                    modelId: params.modelId,
                    modelName: params.modelName,
                    estimatedInput: params.estimatedInputTokens,
                    maxInputTokens: params.maxInputTokens,
                    requestType: params.requestType,
                    timestamp: params.timestamp
                })
                .finally(() => {
                    // Notify update
                    this.notifyUpdate();
                });

            StatusLogger.debug(
                `[Usages] Recorded estimated token: ${params.providerKey}/${params.modelName}, ${params.estimatedInputTokens} tokens, requestId=${requestId}`
            );

            return requestId;
        } catch (err) {
            StatusLogger.warn('[Usages] Failed to record estimated token:', err);
            throw err;
        }
    }

    /**
     * Update Actual Token Usage (call after request completes)
     */
    async updateActualTokens(params: {
        requestId: string;
        rawUsage?: RawUsageData;
        status: 'completed' | 'failed';
        /** Stream start time (millisecond timestamp) */
        streamStartTime?: number;
        /** Stream end time (millisecond timestamp) */
        streamEndTime?: number;
    }): Promise<void> {
        if (!this.initialized) {
            StatusLogger.warn('TokenUsagesManager not yet initialized, skipping token statistics update');
            return;
        }

        try {
            // Convert null values in rawUsage to undefined (to match fileLogger's expected type)
            let normalizedUsage: GenericUsageData | undefined;
            if (params.rawUsage) {
                normalizedUsage = this.normalizeUsageData(params.rawUsage);
            }

            // Update file logging system (do not wait for result)
            this.fileLogger
                .updateActualTokens({
                    requestId: params.requestId,
                    rawUsage: normalizedUsage,
                    status: params.status,
                    streamStartTime: params.streamStartTime,
                    streamEndTime: params.streamEndTime
                })
                .finally(() => {
                    // Notify update
                    this.notifyUpdate();
                });

            // Calculate stream duration info (if available)
            let durationInfo = '';
            if (params.streamStartTime && params.streamEndTime) {
                const duration = params.streamEndTime - params.streamStartTime;
                durationInfo = `, duration=${duration}ms`;
            }

            StatusLogger.debug(
                `[Usages] Updated actual token: requestId=${params.requestId}, ` +
                `rawUsage=${params.rawUsage ? 'recorded' : 'not recorded'}, ` +
                `status=${params.status}${durationInfo}`
            );
        } catch (err) {
            StatusLogger.warn('[Usages] Failed to update actual token:', err);
            // Even if update fails, still notify to let status bar reflect error state
            this.notifyUpdate();
        }
    }

    /**
     * Normalize Usage Data - Convert null to undefined
     */
    private normalizeUsageData(usage: RawUsageData): GenericUsageData {
        const normalized: GenericUsageData = {};

        for (const [key, value] of Object.entries(usage)) {
            // Skip null values, keep undefined and other values
            if (value !== null) {
                normalized[key as keyof GenericUsageData] = value as number | undefined | object;
            }
        }

        return normalized;
    }

    /**
     * Get Statistics for Specified Date (with cache)
     * Suitable for status bar and other scenarios requiring fast response
     */
    async getDateStats(date: string): Promise<TokenUsageStatsFromFile & { date: string; lastUpdated: number }> {
        const stats = await this.fileLogger.getDateStats(date);
        return {
            ...stats,
            date,
            lastUpdated: Date.now()
        };
    }

    /**
     * Get Statistics for Specified Date (read directly from file, no cache)
     * Suitable for detail views, ensuring display of latest accurate data
     */
    async getDateStatsFromFile(date: string): Promise<TokenUsageStatsFromFile & { date: string; lastUpdated: number }> {
        const stats = await this.fileLogger.getDateStatsFromFile(date);
        return {
            ...stats,
            date,
            lastUpdated: Date.now()
        };
    }

    /**
     * Get Statistical Summary for All Dates
     */
    async getAllDateSummaries(): Promise<DateSummary[]> {
        // Use index file to quickly get summary of all dates
        const summariesMap = await this.fileLogger.getIndex();
        const summaries: DateSummary[] = [];

        for (const [date, entry] of Object.entries(summariesMap) as [string, DateIndexEntry][]) {
            summaries.push({
                date,
                total_input: entry.total_input,
                total_cache: entry.total_cache,
                total_output: entry.total_output,
                total_requests: entry.total_requests
            });
        }

        // Sort by date in descending order
        summaries.sort((a, b) => b.date.localeCompare(a.date));
        return summaries;
    }

    /**
     * Get Recent Request Records
     * Includes completed records and pending records still in progress
     * Performance optimization: only read the most recent limit*2 completed requests to reduce memory usage in scenarios withlogs logs
     */
    async getRecentRecords(limit: number = 100): Promise<ExtendedTokenRequestLog[]> {
        const today = DateUtils.getTodayDateString();
        // Use performance optimized version, only read the most recent limit*2 (in case filtering reduces count)
        const details = await this.fileLogger.getRecentRequestDetails(today, limit * 2);
        // Get pending logs in memory (requests not yet completed)
        const pendingLogs = this.fileLogger.getPendingLogs();
        // Create a set of pending requestIds for fast lookup
        const pendingRequestIds = new Set(pendingLogs.map(log => log.requestId));
        // Filter logs in file: only keep those not in pending (completed ones)
        const completedRequests = details.filter(log => !pendingRequestIds.has(log.requestId));
        // Merge completed requests and pending requests still in progress
        const allLogs = [...completedRequests, ...pendingLogs];
        // Sort by timestamp in descending order (newest first)
        allLogs.sort((a, b) => b.timestamp - a.timestamp);

        // Extend records, add convenient access methods
        const extended = UsageParser.extendLogs(allLogs);
        // Return the most recent N records
        return extended.slice(0, limit);
    }

    /**
     * Get Request Records for Specified Date
     */
    async getDateRecords(date: string): Promise<ExtendedTokenRequestLog[]> {
        const details = await this.fileLogger.getRequestDetails(date);
        return UsageParser.extendLogs(details);
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
    private notifyUpdate() {
        this.eventEmitter.emit('update');
    }

    /**
     * Get File Logging System Instance
     */
    getFileLogger(): TokenFileLogger {
        return this.fileLogger;
    }

    /**
     * Release Resources
     */
    async dispose() {
        if (!this.initialized) {
            return;
        }
        await this.fileLogger.dispose();
        this.initialized = false;
    }
}

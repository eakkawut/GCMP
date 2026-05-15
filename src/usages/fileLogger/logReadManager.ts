/*---------------------------------------------------------------------------------------------
 *  Log Read Manager
 *  Reads JSONL format log files, responsible for all file I/O operations
 *  Statistics calculation logic has been migrated to StatsCalculator
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { StatusLogger } from '../../utils/statusLogger';
import { LogPathManager } from './logPathManager';
import { DateUtils } from './dateUtils';
import { StatsCalculator } from './statsCalculator';
import type { TokenRequestLog } from './types';

/**
 * Log Read Manager
 * Only responsible for file I/O, statistics calculation delegated to StatsCalculator
 */
export class LogReadManager {
    private readonly pathManager: LogPathManager;

    constructor(pathManager: LogPathManager) {
        this.pathManager = pathManager;
    }

    /**
     * Read All Logs for Specified Hour
     */
    async readHourLogs(dateStr: string, hour: number): Promise<TokenRequestLog[]> {
        const filePath = this.pathManager.getHourFilePath(dateStr, hour);
        if (!fsSync.existsSync(filePath)) {
            return [];
        }

        try {
            const content = await fs.readFile(filePath, 'utf-8');
            return this.parseJsonlContent(content);
        } catch (err) {
            StatusLogger.error(`[LogReadManager] Failed to read hourly logs: ${filePath}`, err);
            return [];
        }
    }

    /**
     * Read All Logs for Specified Date
     * Optimization: Use Promise.all to read all hour files in parallel
     */
    async readDateLogs(dateStr: string): Promise<TokenRequestLog[]> {
        const dateFolder = this.pathManager.getDateFolderPath(dateStr);
        if (!fsSync.existsSync(dateFolder)) {
            return [];
        }

        try {
            const files = await fs.readdir(dateFolder);
            const hourFiles = files.filter(f => f.endsWith('.jsonl')).sort();
            // Read all files in parallel
            const readPromises = hourFiles.map(file => {
                const filePath = path.join(dateFolder, file);
                return fs
                    .readFile(filePath, 'utf-8')
                    .then(content => this.parseJsonlContent(content))
                    .catch(err => {
                        StatusLogger.warn(`[LogReadManager] Failed to read hourly logs: ${filePath}`, err);
                        return [];
                    });
            });

            const allLogsArrays = await Promise.all(readPromises);
            const allLogs: TokenRequestLog[] = [];
            for (const logs of allLogsArrays) {
                allLogs.push(...logs);
            }
            return allLogs;
        } catch (err) {
            StatusLogger.error(`[LogReadManager] Failed to read date logs: ${dateFolder}`, err);
            return [];
        }
    }

    /**
     * Get Request Details List (merged final status)
     * Used for detail page display
     */
    async getRequestDetails(dateStr: string): Promise<TokenRequestLog[]> {
        const logs = await this.readDateLogs(dateStr);
        const mergedMap = StatsCalculator.mergeLogsByRequestId(logs);
        // Convert to array and sort by timestamp in descending order (newest first)
        const details = Array.from(mergedMap.values());
        details.sort((a, b) => b.timestamp - a.timestamp);
        return details;
    }

    /**
     * Get Recent Request Details (performance optimized version)
     * Only reads the most recent N requests, avoiding loading entire date data when there arelogs logs
     * Used for status bar and other scenarios requiring fast response
     * Optimization strategy: read backwards from the latest hour, stop when enough records are found
     */
    async getRecentRequestDetails(dateStr: string, limit: number = 100): Promise<TokenRequestLog[]> {
        const now = new Date();
        const currentHour = now.getHours();
        const today = DateUtils.getTodayDateString();
        const isToday = dateStr === today;

        // Get hour range to check
        // If today, start from current hour; otherwise start from hour 23
        const startHour = isToday ? currentHour : 23;
        const logs: TokenRequestLog[] = [];
        const dateFolder = this.pathManager.getDateFolderPath(dateStr);
        if (!fsSync.existsSync(dateFolder)) {
            return [];
        }

        try {
            // Read backwards from the latest hour
            for (let hour = startHour; hour >= 0 && logs.length < limit; hour--) {
                const hourLogs = await this.readHourLogs(dateStr, hour);
                if (hourLogs.length === 0) {
                    continue;
                }

                // Merge logs
                const mergedMap = StatsCalculator.mergeLogsByRequestId(hourLogs);
                const hourDetails = Array.from(mergedMap.values());
                // Merge into results
                logs.push(...hourDetails);
                // If enough records have been collected, end early
                if (logs.length >= limit) {
                    break;
                }
            }

            // Sort by timestamp in descending order (newest first)
            logs.sort((a, b) => b.timestamp - a.timestamp);
            // Return only the most recent limit entries
            return logs.slice(0, limit);
        } catch (err) {
            StatusLogger.error(`[LogReadManager] Failed to get recent request details: ${dateStr}`, err);
            return [];
        }
    }

    /**
     * Get Hourly Log File Modification Timestamp (milliseconds)
     * Returns 0 if file does not exist
     */
    async getHourFileModifiedTime(dateStr: string, hour: number): Promise<number> {
        const filePath = this.pathManager.getHourFilePath(dateStr, hour);
        if (!fsSync.existsSync(filePath)) {
            return 0;
        }

        try {
            const stats = await fs.stat(filePath);
            return stats.mtime.getTime();
        } catch (err) {
            StatusLogger.warn(`[LogReadManager] Failed to get file modification time: ${filePath}`, err);
            return 0;
        }
    }

    /**
     * Parse JSONL Content
     * Multiple records may exist for the same requestId, return all sequential records
     */
    private parseJsonlContent(content: string): TokenRequestLog[] {
        const lines = content.split('\n').filter(line => line.trim());
        const logs: TokenRequestLog[] = [];
        for (const line of lines) {
            try {
                const log = JSON.parse(line) as TokenRequestLog;
                logs.push(log);
            } catch {
                // StatusLogger.warn('[LogReadManager] Failed to parse log line, skipping', err);
            }
        }
        return logs;
    }
}

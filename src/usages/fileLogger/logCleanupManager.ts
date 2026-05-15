/*---------------------------------------------------------------------------------------------
 *  Log Cleanup Manager
 *  Responsible for deletion and cleanup operations of log files
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { StatusLogger } from '../../utils/statusLogger';
import { LogPathManager } from './logPathManager';
import { LogIndexManager } from './logIndexManager';
import { DateUtils } from './dateUtils';

/**
 * Log Cleanup Manager
 * Responsible for log file deletion and expired cleanup
 */
export class LogCleanupManager {
    private readonly pathManager: LogPathManager;
    private readonly indexManager: LogIndexManager;
    constructor(pathManager: LogPathManager, indexManager: LogIndexManager) {
        this.pathManager = pathManager;
        this.indexManager = indexManager;
    }

    /**
     * Get All Date List
     */
    async getAllDates(): Promise<string[]> {
        const baseDir = this.pathManager.getBaseDir();
        if (!fsSync.existsSync(baseDir)) {
            return [];
        }

        try {
            const entries = await fs.readdir(baseDir, { withFileTypes: true });
            const dates = entries
                .filter(entry => entry.isDirectory())
                .map(entry => entry.name)
                .filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name))
                .sort()
                .reverse(); // Descending order (newest first)
            return dates;
        } catch (err) {
            StatusLogger.error('[LogCleanupManager] Failed to get date list', err);
            return [];
        }
    }

    /**
     * Delete All Log Files for Specified Date
     */
    async deleteDateLogs(dateStr: string): Promise<number> {
        const dateFolder = this.pathManager.getDateFolderPath(dateStr);
        if (!fsSync.existsSync(dateFolder)) {
            return 0;
        }

        try {
            const files = await fs.readdir(dateFolder);
            const count = files.length;
            // Delete entire folder
            await fs.rm(dateFolder, { recursive: true, force: true });

            // Remove this date from index
            await this.indexManager.removeDate(dateStr);

            StatusLogger.info(`[LogCleanupManager] Deleted expired records: ${dateStr} (${count} files)`);
            return count;
        } catch (err) {
            StatusLogger.error(`[LogCleanupManager] Failed to delete expired records: ${dateStr}`, err);
            throw err;
        }
    }

    /**
     * Clean Up Expired Logs (retain most recent N days)
     */
    async cleanupExpiredLogs(retentionDays: number): Promise<number> {
        if (retentionDays === 0) {
            return 0; // Permanent retention
        }

        const allDates = await this.getAllDates();
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
        const cutoffDateStr = DateUtils.formatDate(cutoffDate);

        let deletedCount = 0;
        for (const dateStr of allDates) {
            if (dateStr < cutoffDateStr) {
                const count = await this.deleteDateLogs(dateStr);
                deletedCount += count;
            }
        }
        return deletedCount;
    }
}

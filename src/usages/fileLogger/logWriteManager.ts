/*---------------------------------------------------------------------------------------------
 *  Log Write Manager
 *  With write lock mechanism to ensure integrity of each log line
 *  Uses queue + async lock to achieve mutual exclusion writes
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import { StatusLogger } from '../../utils/statusLogger';
import { LogPathManager } from './logPathManager';
import type { TokenRequestLog } from './types';

/**
 * Write Task
 */
interface WriteTask {
    log: TokenRequestLog;
    resolve: () => void;
    reject: (err: Error) => void;
}

/**
 * Log Write Manager
 * Uses queue to ensure write order, uses lock to ensure write mutual exclusion
 */
export class LogWriteManager {
    private readonly pathManager: LogPathManager;
    private writeQueue: WriteTask[] = [];
    private isProcessing = false;
    private isDisposed = false;

    constructor(pathManager: LogPathManager) {
        this.pathManager = pathManager;
    }

    /**
     * Append Log Entry (asynchronous, using queue)
     */
    async appendLog(log: TokenRequestLog): Promise<void> {
        if (this.isDisposed) {
            throw new Error('[LogWriteManager] Write manager destroyed');
        }

        return new Promise((resolve, reject) => {
            // Add to queue
            this.writeQueue.push({ log, resolve, reject });

            // Trigger processing
            this.processQueue();
        });
    }

    /**
     * Batch Append Log Entries
     */
    async appendLogs(logs: TokenRequestLog[]): Promise<void> {
        if (this.isDisposed) {
            throw new Error('[LogWriteManager] Write manager destroyed');
        }

        // Batch add to queue
        const promises = logs.map(
            log =>
                new Promise<void>((resolve, reject) => {
                    this.writeQueue.push({ log, resolve, reject });
                })
        );

        // Trigger processing
        this.processQueue();

        // Wait for all tasks to complete
        await Promise.all(promises);
    }

    /**
     * Process Write Queue
     */
    private async processQueue(): Promise<void> {
        // If already processing, return directly
        if (this.isProcessing) {
            return;
        }

        this.isProcessing = true;

        try {
            while (this.writeQueue.length > 0) {
                const task = this.writeQueue.shift();
                if (!task) {
                    break;
                }

                try {
                    await this.writeLogInternal(task.log);
                    task.resolve();
                } catch (err) {
                    task.reject(err as Error);
                }
            }
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Internal Write Method (actual write execution)
     * Appends new line for each request, forming sequential records
     */
    private async writeLogInternal(log: TokenRequestLog): Promise<void> {
        const logPath = this.pathManager.getLogPathFromDate(new Date(log.timestamp));

        try {
            // Ensure date folder exists (use unified method from PathManager)
            await this.pathManager.ensureDirectoryExists(logPath.dateFolder);

            // Convert log object to JSONL format (one JSON per line)
            // Each call appends a new line, same requestId may have multiple records (estimated→completed/failed)
            const line = JSON.stringify(log) + '\n';

            // Append to file (use appendFile to automatically handle concurrency)
            await fs.appendFile(logPath.fullPath, line, 'utf-8');

            StatusLogger.debug(
                `[LogWriteManager] Wrote sequential log: ${logPath.fullPath} (${log.requestId}, status=${log.status})`
            );
        } catch (err) {
            StatusLogger.error(`[LogWriteManager] Failed to write log: ${logPath.fullPath}`, err);
            throw err;
        }
    }

    /**
     * Flush Queue (wait for all pending tasks to complete)
     */
    async flush(): Promise<void> {
        // Wait for queue to empty
        while (this.writeQueue.length > 0 || this.isProcessing) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    /**
     * Get Queue Status
     */
    getQueueStatus(): { queueLength: number; isProcessing: boolean } {
        return {
            queueLength: this.writeQueue.length,
            isProcessing: this.isProcessing
        };
    }

    /**
     * Destroy Write Manager
     */
    async dispose(): Promise<void> {
        try {
            StatusLogger.debug('[LogWriteManager] Starting to destroy write manager...');

            // Mark as destroyed, prevent new write requests
            this.isDisposed = true;

            // Wait for queue to empty
            const queueStatus = this.getQueueStatus();
            if (queueStatus.queueLength > 0) {
                StatusLogger.warn(
                    `[LogWriteManager] Found ${queueStatus.queueLength} pending write tasks during destruction, waiting for completion...`
                );
            }

            // Flush all tasks in queue
            await this.flush();

            StatusLogger.debug('[LogWriteManager] Write manager destroyed');
        } catch (error) {
            StatusLogger.error('[LogWriteManager] Error occurred while destroying write manager:', error);
            throw error;
        }
    }
}

/*---------------------------------------------------------------------------------------------
 *  File Path Manager
 *  Responsible for managing log file directory structure: logs/usages/YYYY-MM-DD/HH.jsonl
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import { StatusLogger } from '../../utils/statusLogger';
import { DateUtils } from './dateUtils';
import type { LogFilePath } from './types';

/**
 * File Path Manager
 * Manages log file directory structure
 */
export class LogPathManager {
    private readonly baseDir: string;

    /**
     * @param baseDir Log root directory (use extensionContext.globalStorageUri.fsPath to ensure not cleaned up)
     */
    constructor(baseDir: string) {
        this.baseDir = path.join(baseDir, 'usages');
    }

    /**
     * Get Log File Path for Specified Timestamp
     */
    getLogPath(timestamp: number): LogFilePath {
        const date = new Date(timestamp);
        return this.getLogPathFromDate(date);
    }

    /**
     * Get Log File Path for Specified Date Object
     */
    getLogPathFromDate(date: Date): LogFilePath {
        const dateStr = DateUtils.formatDate(date);
        const hour = date.getHours();

        const dateFolder = path.join(this.baseDir, dateStr);
        const hourFileName = `${String(hour).padStart(2, '0')}.jsonl`;
        const fullPath = path.join(dateFolder, hourFileName);

        return {
            date: dateStr,
            hour,
            dateFolder,
            hourFileName,
            fullPath
        };
    }

    /**
     * Get Folder Path for Specified Date String
     */
    getDateFolderPath(dateStr: string): string {
        return path.join(this.baseDir, dateStr);
    }

    /**
     * Get File Path for Specified Date and Hour
     */
    getHourFilePath(dateStr: string, hour: number): string {
        const dateFolder = this.getDateFolderPath(dateStr);
        const hourFileName = `${String(hour).padStart(2, '0')}.jsonl`;
        return path.join(dateFolder, hourFileName);
    }

    /**
     * Get Log File Path for Current Moment
     */
    getCurrentLogPath(): LogFilePath {
        return this.getLogPath(Date.now());
    }

    /**
     * Get Base Directory Path
     */
    getBaseDir(): string {
        return this.baseDir;
    }

    /**
     * Ensure Directory Exists (recursive creation)
     */
    async ensureDirectoryExists(dir: string): Promise<void> {
        try {
            // Synchronous check to avoid race conditions
            if (!fsSync.existsSync(dir)) {
                await fs.mkdir(dir, { recursive: true });
                StatusLogger.debug(`[LogPathManager] Created directory: ${dir}`);
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

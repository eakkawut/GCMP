/*---------------------------------------------------------------------------------------------
 *  Kimi For Coding Status Bar Item
 *  Extends ProviderStatusBarItem, displays Kimi For Coding usage information
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderStatusBarItem, StatusBarItemConfig } from './providerStatusBarItem';
import { StatusLogger } from '../utils/statusLogger';
import { Logger } from '../utils/logger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { VersionManager } from '../utils/versionManager';

/**
 * Kimi usage window data
 */
export interface KimiUsageWindow {
    /** Duration */
    duration: number;
    /** Time unit */
    timeUnit: string;
    /** Detailed information */
    detail: {
        /** Limit value (could be percentage 100 or Token amount) */
        limit: number;
        /** Used value (defaults to 0 if API does not return) */
        used: number;
        /** Remaining value */
        remaining: number;
        /** Reset time */
        resetTime?: string;
    };
}

/**
 * Kimi usage summary data
 */
export interface KimiUsageSummary {
    /** Total limit value (could be percentage 100 or Token amount) */
    limit: number;
    /** Used value */
    used: number;
    /** Remaining value */
    remaining: number;
    /** Reset time */
    resetTime: string;
}

/**
 * Kimi concurrency limit data
 */
export interface KimiParallelInfo {
    /** Concurrency limit */
    limit: number;
}

/**
 * Kimi status data
 */
export interface KimiStatusData {
    /** Overall usage information */
    summary: KimiUsageSummary;
    /** Detailed usage limits */
    windows: KimiUsageWindow[];
    /** Concurrency limit (optional) */
    parallel?: KimiParallelInfo;
}

/**
 * Kimi For Coding Status Bar Item
 * Displays Kimi For Coding usage information, including:
 * - Remaining/total amount
 * - Usage percentage
 * - Support for multiple time window display
 */
export class KimiStatusBar extends ProviderStatusBarItem<KimiStatusData> {
    constructor() {
        const config: StatusBarItemConfig = {
            id: 'ccmp.statusBar.kimi',
            name: 'CCMP: Kimi For Coding',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 90,
            refreshCommand: 'ccmp.kimi.refreshUsage',
            apiKeyProvider: 'kimi',
            cacheKeyPrefix: 'kimi',
            logPrefix: 'Kimi StatusBar',
            icon: '$(ccmp-kimi)'
        };
        super(config);
    }

    /**
     * Get display text
     */
    protected getDisplayText(data: KimiStatusData): string {
        const { summary, windows } = data;
        let displayText = `${this.config.icon} ${summary.remaining}%`;
        // If there is window data, add remaining for each window (exclude windows with 100% remaining)
        if (windows.length > 0) {
            const windowTexts = windows
                .filter(window => window.detail.remaining < 100)
                .map(window => `${window.detail.remaining}%`);
            if (windowTexts.length > 0) {
                displayText += ` (${windowTexts.join(',')})`;
            }
        }
        return displayText;
    }

    /**
     * Format token count display
     */
    private formatTokenCount(tokens: number): string {
        if (tokens >= 1000000) {
            return `${(tokens / 1000000).toFixed(1)}M`;
        } else if (tokens >= 1000) {
            return `${(tokens / 1000).toFixed(1)}K`;
        }
        return tokens.toString();
    }

    /**
     * Generate tooltip content
     */
    protected generateTooltip(data: KimiStatusData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;

        const { summary, windows } = data;
        md.appendMarkdown('#### Kimi For Coding Usage\n\n');

        // Percentage mode: display rate limit type, remaining amount, reset time
        md.appendMarkdown('| Rate Limit Type | Remaining | Reset Time |\n');
        md.appendMarkdown('| :----: | ----: | :----: |\n');

        // Add weekly quota
        const resetTime = new Date(summary.resetTime);
        const resetTimeStr = this.formatDateTime(resetTime);
        md.appendMarkdown(`| **Weekly Quota** | ${summary.remaining}% | ${resetTimeStr} |\n`);

        // Add window limits
        if (windows.length > 0) {
            for (const window of windows) {
                const timeUnit = this.translateTimeUnit(window.timeUnit);
                const { detail, duration } = window;
                const windowResetTime = detail.resetTime ? new Date(detail.resetTime) : undefined;
                const windowResetTimeStr = windowResetTime ? this.formatDateTime(windowResetTime) : 'N/A';
                md.appendMarkdown(`| **${duration} ${timeUnit}** | ${detail.remaining}% | ${windowResetTimeStr} |\n`);
            }
        }

        // Add concurrency limit row
        if (data.parallel) {
            md.appendMarkdown('\n');
            md.appendMarkdown(`**Maximum Concurrency Limit**: ${data.parallel.limit}\n`);
        }

        md.appendMarkdown('\n');
        md.appendMarkdown('---\n');
        md.appendMarkdown('Click status bar to manually refresh\n');
        return md;
    }

    /**
     * Execute API query
     * Directly implements Kimi For Coding remaining balance query logic
     */
    protected async performApiQuery(): Promise<{ success: boolean; data?: KimiStatusData; error?: string }> {
        const REMAIN_QUERY_URL = 'https://api.kimi.com/coding/v1/usages';
        const KIMI_KEY = 'kimi';

        try {
            // Check if Kimi For Coding key exists
            const hasCodingKey = await ApiKeyManager.hasValidApiKey(KIMI_KEY);
            if (!hasCodingKey) {
                return {
                    success: false,
                    error: 'Kimi For Coding dedicated key not configured, please set Kimi For Coding API key first'
                };
            }

            // Get Kimi For Coding key
            const apiKey = await ApiKeyManager.getApiKey(KIMI_KEY);
            if (!apiKey) {
                return {
                    success: false,
                    error: 'Unable to get Kimi For Coding dedicated key'
                };
            }

            Logger.debug('Triggered Kimi For Coding balance query');
            StatusLogger.debug(`[${this.config.logPrefix}] Starting Kimi For Coding balance query...`);

            // Build request
            const requestOptions: RequestInit = {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('Kimi'),
                    Authorization: `Bearer ${apiKey}`
                }
            };

            // Send request
            const response = await fetch(REMAIN_QUERY_URL, requestOptions);
            const responseText = await response.text();

            StatusLogger.debug(
                `[${this.config.logPrefix}] Remaining balance query response status: ${response.status} ${response.statusText}`
            );

            // Parse response
            interface KimiBillingResponse {
                user?: {
                    userId: string;
                    region: string;
                    membership: {
                        level: string;
                    };
                    businessId?: string;
                };
                usage?: {
                    limit: string | number;
                    used?: string | number;
                    remaining?: string | number;
                    resetTime: string;
                };
                limits?: {
                    window: {
                        duration: number;
                        timeUnit: string;
                    };
                    detail: {
                        limit: string | number;
                        used?: string | number;
                        remaining?: string | number;
                        resetTime?: string;
                    };
                }[];
                parallel?: {
                    limit: string | number;
                };
                code?: string;
                details?: {
                    type: string;
                    value: string;
                    debug?: {
                        reason: string;
                        localizedMessage?: {
                            locale: string;
                            message: string;
                        };
                    };
                }[];
            }

            let parsedResponse: KimiBillingResponse;
            try {
                parsedResponse = JSON.parse(responseText);
            } catch (parseError) {
                Logger.error(`Failed to parse response JSON: ${parseError}`);
                return {
                    success: false,
                    error: `Response format error: ${responseText.substring(0, 200)}`
                };
            }

            // Check response status
            if (!response.ok) {
                const errorMessage = `HTTP ${response.status}`;
                Logger.error(`Remaining balance query failed: ${errorMessage}`);
                return {
                    success: false,
                    error: `Query failed: ${errorMessage}`
                };
            }

            // Check specific authentication error
            if (parsedResponse.code === 'unauthenticated') {
                const errorMessage = 'API key is invalid or expired, please check your Kimi API key';
                Logger.error(`Authentication failed: ${errorMessage}`);
                return {
                    success: false,
                    error: `Authentication failed: ${errorMessage}`
                };
            }

            // Check other API errors
            if (parsedResponse.code !== undefined && parsedResponse.code !== 'unauthenticated') {
                const errorMessage = `API Error: ${parsedResponse.code}`;
                Logger.error(`Remaining balance query API failed: ${errorMessage}`);
                return {
                    success: false,
                    error: `API query failed: ${errorMessage}`
                };
            }

            // Parse successful response
            StatusLogger.debug(`[${this.config.logPrefix}] Balance query successful`);

            // Calculate formatted information
            if (!parsedResponse.usage) {
                return {
                    success: false,
                    error: 'No usage data retrieved'
                };
            }

            const usage = parsedResponse.usage;

            // Parse numeric values
            const used = typeof usage.used === 'string' ? parseInt(usage.used, 10) : (usage.used ?? 0);
            const limit = typeof usage.limit === 'string' ? parseInt(usage.limit, 10) : usage.limit;
            const remaining =
                typeof usage.remaining === 'string' ? parseInt(usage.remaining, 10) : (usage.remaining ?? 0);

            // Overall usage information
            const summary: KimiUsageSummary = {
                limit,
                used,
                remaining,
                resetTime: usage.resetTime
            };

            // Detailed usage limits
            const windows: KimiUsageWindow[] = [];
            if (parsedResponse.limits && parsedResponse.limits.length > 0) {
                for (const limitItem of parsedResponse.limits) {
                    const detail = limitItem.detail;
                    const detailUsed = typeof detail.used === 'string' ? parseInt(detail.used, 10) : (detail.used ?? 0);
                    const detailLimit = typeof detail.limit === 'string' ? parseInt(detail.limit, 10) : detail.limit;
                    const detailRemaining =
                        typeof detail.remaining === 'string' ? parseInt(detail.remaining, 10) : (detail.remaining ?? 0);

                    windows.push({
                        duration: limitItem.window.duration,
                        timeUnit: limitItem.window.timeUnit,
                        detail: {
                            limit: detailLimit,
                            used: detailUsed,
                            remaining: detailRemaining,
                            resetTime: detail.resetTime
                        }
                    });
                }
            }

            // Concurrency limit
            let parallel: KimiParallelInfo | undefined;
            if (parsedResponse.parallel) {
                const parallelLimit =
                    typeof parsedResponse.parallel.limit === 'string'
                        ? parseInt(parsedResponse.parallel.limit, 10)
                        : parsedResponse.parallel.limit;
                parallel = { limit: parallelLimit };
            }

            return {
                success: true,
                data: {
                    summary,
                    windows,
                    parallel
                }
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            Logger.error(`Remaining balance query exception: ${errorMessage}`);
            return {
                success: false,
                error: `Query exception: ${errorMessage}`
            };
        }
    }

    /**
     * Check if highlight warning is needed (remaining percentage below threshold or any window remaining percentage below threshold)
     */
    protected shouldHighlightWarning(data: KimiStatusData): boolean {
        const { summary, windows } = data;

        // Check if overall remaining is below threshold
        const usedPercentage = summary.used;

        if (usedPercentage >= this.HIGH_USAGE_THRESHOLD) {
            return true;
        }

        // Check if any window remaining is below threshold
        if (windows.length > 0) {
            for (const window of windows) {
                if (window.detail.used >= this.HIGH_USAGE_THRESHOLD) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Check if cache refresh is needed
     * Refresh when cache exceeds 5-minute fixed expiry time
     */
    protected shouldRefresh(): boolean {
        if (!this.lastStatusData) {
            return false;
        }

        const dataAge = Date.now() - this.lastStatusData.timestamp;
        const CACHE_EXPIRY_THRESHOLD = (5 * 60 - 10) * 1000; // Cache expiry threshold 5 minutes

        // Check if cache exceeds 5-minute fixed expiry time
        if (dataAge > CACHE_EXPIRY_THRESHOLD) {
            StatusLogger.debug(
                `[${this.config.logPrefix}] Cache time (${(dataAge / 1000).toFixed(1)}s) exceeds 5-minute fixed expiry time, triggering API refresh`
            );
            return true;
        }

        return false;
    }

    /**
     * Translate time unit to display string
     */
    private translateTimeUnit(timeUnit: string): string {
        const unitMap: Record<string, string> = {
            TIME_UNIT_SECOND: 'Second',
            TIME_UNIT_MINUTE: 'Minute',
            TIME_UNIT_HOUR: 'Hour',
            TIME_UNIT_DAY: 'Day',
            TIME_UNIT_MONTH: 'Month',
            TIME_UNIT_YEAR: 'Year'
        };
        return unitMap[timeUnit] || timeUnit;
    }

    /**
     * Format date time to MM/DD HH:mm format
     */
    private formatDateTime(date: Date): string {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${month}/${day} ${hours}:${minutes}`;
    }

    /**
     * Getter: Get the last status data (for testing and debugging)
     */
    getLastStatusData(): { data: KimiStatusData; timestamp: number } | null {
        return this.lastStatusData;
    }
}

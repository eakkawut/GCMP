/*---------------------------------------------------------------------------------------------
 *  ZhipuAI Usage Status Bar Item
 *  Extends ProviderStatusBarItem, displays ZhipuAI Coding Plan usage information
 *  - Displays weekly limit (unit=6): 7-day token usage limit
 *  - Displays 5-hour limit (unit=3): 5-hour token usage limit (auto-resets at nextResetTime)
 *  - Displays MCP monthly limit (TIME_LIMIT): MCP search usage count
 *  Reference implementation verification: unit=3 corresponds to 5 hours, unit=6 corresponds to 7 days (weekly limit)
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderStatusBarItem, StatusBarItemConfig } from './providerStatusBarItem';
import { StatusLogger } from '../utils/statusLogger';
import { Logger } from '../utils/logger';
import { ConfigManager, ApiKeyManager, VersionManager } from '../utils';

/**
 * Usage limit item data structure
 * Verified according to Zhipu API documentation and open source implementation:
 * - unit=3: 5-hour limit
 * - unit=6: 7-day limit (weekly limit)
 */
export interface UsageLimitItem {
    /** Limit type:
     *  - TOKENS_LIMIT: Token usage (time window determined by unit)
     *  - TIME_LIMIT: MCP search usage count
     */
    type: 'TIME_LIMIT' | 'TOKENS_LIMIT';
    /** Time unit type: 3=5-hour limit, 6=7-day weekly limit */
    unit: number;
    /** Time period count */
    number: number;
    /** Total quota/limit (required for TIME_LIMIT, optional for TOKENS_LIMIT) */
    usage?: number;
    /** Currently used (required for TIME_LIMIT, optional for TOKENS_LIMIT) */
    currentValue?: number;
    /** Remaining quota (required for TIME_LIMIT, optional for TOKENS_LIMIT) */
    remaining?: number;
    /** Usage percentage */
    percentage: number;
    /** Next reset timestamp (ms, only valid for TOKENS_LIMIT) */
    nextResetTime?: number;
    /** Usage details (grouped by model or feature) */
    usageDetails?: Array<{
        modelCode: string;
        usage: number;
    }>;
}

/**
 * Zhipu status data
 */
interface ZhipuStatusData {
    /** Usage limits list */
    limits: UsageLimitItem[];
    /** Most recent next reset timestamp (ms) */
    nextResetTime?: number;
}

/**
 * ZhipuAI Coding Plan Status Bar Item
 * - Display format: remaining available percentage
 * - Weekly limit (unit=6): Displayed as "Weekly remaining% (5h%)" or "Weekly remaining%"
 * - 5-hour limit (unit=3): Displayed in parentheses
 * - Priority: weekly limit first, then 5-hour limit
 */
export class ZhipuStatusBar extends ProviderStatusBarItem<ZhipuStatusData> {
    constructor() {
        const config: StatusBarItemConfig = {
            id: 'ccmp.statusBar.zhipu',
            name: 'CCMP: GLM Coding Plan',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 99,
            refreshCommand: 'ccmp.refreshZhipuUsage',
            apiKeyProvider: 'zhipu',
            cacheKeyPrefix: 'zhipu',
            logPrefix: 'ZhipuAI StatusBar',
            icon: '$(ccmp-zhipu)'
        };
        super(config);
    }

    /**
     * Get display text
     */
    protected getDisplayText(data: ZhipuStatusData): string {
        const tokensLimits = data.limits.filter(l => l.type === 'TOKENS_LIMIT');
        const weeklyLimit = tokensLimits.find(l => l.unit === 6);
        const hourlyLimit = tokensLimits.find(l => l.unit === 3);
        const formatPercentage = (limit: UsageLimitItem) => `${100 - (limit.percentage ?? 0)}%`;
        if (weeklyLimit && hourlyLimit) {
            return `${this.config.icon} ${formatPercentage(weeklyLimit)} (${formatPercentage(hourlyLimit)})`;
        } else if (weeklyLimit) {
            return `${this.config.icon} ${formatPercentage(weeklyLimit)}`;
        } else if (hourlyLimit) {
            return `${this.config.icon} ${formatPercentage(hourlyLimit)}`;
        } else if (tokensLimits.length > 0) {
            return `${this.config.icon} ${formatPercentage(tokensLimits[0])}`;
        }
        return `${this.config.icon}`;
    }

    /**
     * Generate tooltip content
     * Reference Kimi's organization: rate limit type, limit value, remaining amount, reset time
     */
    protected generateTooltip(data: ZhipuStatusData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        md.appendMarkdown('#### GLM Coding Plan Usage\n\n');
        md.appendMarkdown('| Rate Limit Type | Limit Value | Remaining | Reset Time |\n');
        md.appendMarkdown('| :---: | ---: | ---: | :---: |\n');

        // Iterate through all limits, display in order
        for (const limit of data.limits) {
            let typeLabel: string;
            let usage: string;
            let remaining: string;

            if (limit.type === 'TIME_LIMIT') {
                // MCP quota: display value directly
                typeLabel = 'MCP Monthly';
                usage = limit.usage !== undefined ? String(limit.usage) : '-';
                remaining = limit.remaining !== undefined ? String(limit.remaining) : '-';
            } else {
                typeLabel = this.getWindowLabel(limit, 'Limit');
                // TOKENS_LIMIT: Official API no longer outputs specific usage and remaining, only displays percentage
                usage = '-';
                remaining = `${100 - (limit.percentage ?? 0)}%`;
            }

            const resetTime = limit.nextResetTime ? new Date(limit.nextResetTime) : undefined;
            const resetTimeStr = resetTime ? this.formatDateTime(resetTime) : '-';
            md.appendMarkdown(`| **${typeLabel}** | ${usage} | ${remaining} | ${resetTimeStr} |\n`);
        }

        md.appendMarkdown('\n');
        md.appendMarkdown('---\n');
        md.appendMarkdown('Click status bar to manually refresh\n');
        return md;
    }

    /**
     * Execute API query
     * Directly implements ZhipuAI usage query logic
     */
    protected async performApiQuery(): Promise<{ success: boolean; data?: ZhipuStatusData; error?: string }> {
        const QUOTA_QUERY_URL = 'https://bigmodel.cn/api/monitor/usage/quota/limit';
        const PROVIDER_KEY = 'zhipu';

        try {
            // Check if API Key exists
            const hasApiKey = await ApiKeyManager.hasValidApiKey(PROVIDER_KEY);
            if (!hasApiKey) {
                return {
                    success: false,
                    error: 'ZhipuAI API key not configured, please set API key first'
                };
            }

            // Get API key
            const apiKey = await ApiKeyManager.getApiKey(PROVIDER_KEY);
            if (!apiKey) {
                return {
                    success: false,
                    error: 'Unable to get ZhipuAI API key'
                };
            }

            Logger.debug('Triggered ZhipuAI usage query');
            StatusLogger.debug(`[${this.config.logPrefix}] Starting ZhipuAI usage query...`);

            // Get current endpoint
            const endpoint = ConfigManager.getZhipuEndpoint();
            let requestUrl = QUOTA_QUERY_URL;

            // Adjust URL if using international site
            if (endpoint === 'api.z.ai') {
                requestUrl = 'https://api.z.ai/api/monitor/usage/quota/limit';
            }

            // Build request
            const requestOptions: RequestInit = {
                method: 'GET',
                headers: {
                    Authorization: apiKey,
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('Zhipu')
                }
            };

            // Send request
            const response = await fetch(requestUrl, requestOptions);
            const responseText = await response.text();

            StatusLogger.debug(
                `[${this.config.logPrefix}] Usage query response status: ${response.status} ${response.statusText}`
            );

            // Parse response
            interface QuotaLimitResponse {
                code: number;
                msg: string;
                data: {
                    limits: Array<{
                        type: 'TIME_LIMIT' | 'TOKENS_LIMIT';
                        unit: number;
                        number: number;
                        usage?: number;
                        currentValue?: number;
                        remaining?: number;
                        percentage: number;
                        nextResetTime?: number;
                        usageDetails?: Array<{
                            modelCode: string;
                            usage: number;
                        }>;
                    }>;
                };
                success: boolean;
            }

            let parsedResponse: QuotaLimitResponse;
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
            if (!response.ok || !parsedResponse.success || parsedResponse.code !== 200) {
                let errorMessage = `HTTP ${response.status}`;
                if (parsedResponse.msg) {
                    errorMessage = parsedResponse.msg;
                }
                Logger.error(`Usage query failed: ${errorMessage}`);
                return {
                    success: false,
                    error: `Query failed: ${errorMessage}`
                };
            }

            // Parse successful response
            StatusLogger.debug(`[${this.config.logPrefix}] Usage query successful`);

            const limits = parsedResponse.data.limits;
            if (!limits || limits.length === 0) {
                return {
                    success: false,
                    error: 'Failed to retrieve usage limit data'
                };
            }

            // Calculate most recent reset time
            const resetTimes = limits.filter(l => l.nextResetTime !== undefined).map(l => l.nextResetTime as number);
            const nextResetTime = resetTimes.length > 0 ? Math.min(...resetTimes) : undefined;

            return {
                success: true,
                data: {
                    limits,
                    nextResetTime
                }
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            Logger.error(`Usage query exception: ${errorMessage}`);
            return {
                success: false,
                error: `Query exception: ${errorMessage}`
            };
        }
    }

    /**
     * Check if highlight warning is needed
     * Highlight when any limit's usage rate exceeds threshold
     */
    protected shouldHighlightWarning(data: ZhipuStatusData): boolean {
        // Check maximum usage rate among all limits
        const maxPercentage = Math.max(...data.limits.map(l => l.percentage));
        return maxPercentage >= this.HIGH_USAGE_THRESHOLD;
    }

    /**
     * Check if cache refresh is needed
     * TOKENS_LIMIT: Determine based on nextResetTime (next reset time)
     * TIME_LIMIT: Use fixed 5-minute cache expiry time
     */
    protected shouldRefresh(): boolean {
        if (!this.lastStatusData) {
            return false;
        }

        const dataAge = Date.now() - this.lastStatusData.timestamp;
        const CACHE_EXPIRY_THRESHOLD = (5 * 60 - 10) * 1000; // Cache expiry threshold 5 minutes

        // 1. Check if nextResetTime needs to trigger refresh
        const { nextResetTime } = this.lastStatusData.data;
        if (nextResetTime) {
            const timeUntilReset = nextResetTime - Date.now();
            if (timeUntilReset > 0 && dataAge > timeUntilReset) {
                StatusLogger.debug(
                    `[${this.config.logPrefix}] Cache time (${(dataAge / 1000).toFixed(1)}s) exceeds reset time difference (${(timeUntilReset / 1000).toFixed(1)}s), triggering API refresh`
                );
                return true;
            }
        }

        // 2. Check if cache exceeds 5-minute fixed expiry time
        if (dataAge > CACHE_EXPIRY_THRESHOLD) {
            StatusLogger.debug(
                `[${this.config.logPrefix}] Cache time (${(dataAge / 1000).toFixed(1)}s) exceeds 5-minute fixed expiry time, triggering API refresh`
            );
            return true;
        }

        return false;
    }

    /**
     * Getter: Get the last status data (for testing and debugging)
     */
    getLastStatusData(): { data: ZhipuStatusData; timestamp: number } | null {
        return this.lastStatusData;
    }

    /**
     * Format date time
     */
    private formatDateTime(date: Date): string {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${month}-${day} ${hours}:${minutes}`;
    }

    /**
     * Get time window label
     * Generate time window description based on unit value
     * - unit=3: 5-hour limit
     * - unit=6: 7-day limit (weekly limit)
     */
    private getWindowLabel(limit: UsageLimitItem, defaultLabel: string): string {
        if (limit.unit === 3) {
            return 'Per 5 Hours';
        } else if (limit.unit === 6) {
            return 'Weekly Limit';
        }
        return defaultLabel;
    }
}

/*---------------------------------------------------------------------------------------------
 *  MiniMax Coding Plan Status Bar Item
 *  Extends ProviderStatusBarItem, displays MiniMax Coding Plan usage information
 *  - Displays per 5-hour limit (interval)
 *  - Displays weekly limit (weekly, only has value for newly activated users)
 *  Reference Zhipu's flat rate limit list mode
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderStatusBarItem, StatusBarItemConfig } from './providerStatusBarItem';
import { StatusLogger } from '../utils/statusLogger';
import { Logger } from '../utils/logger';
import { ConfigManager, ApiKeyManager, VersionManager } from '../utils';

/**
 * Single rate limit item (flat list, referencing Zhipu mode)
 */
export interface MiniMaxLimitItem {
    /** Rate limit type label, e.g., "Per 5 Hours", "Weekly Limit" */
    label: string;
    /** Rate limit type: 5h=per 5 hours, weekly=per week */
    limitType: '5h' | 'weekly';
    /** Total quota */
    total: number;
    /** Remaining count */
    remaining: number;
    /** Used (percentage) */
    percentage: number;
    /** Remaining reset time (ms) */
    remainMs: number;
    /** Reset time (absolute timestamp ms) */
    resetTime: number;
}

/**
 * MiniMax status data (flat rate limit list)
 */
interface MiniMaxStatusData {
    /** Rate limit items list */
    limits: MiniMaxLimitItem[];
}

/**
 * MiniMax Coding Plan Status Bar Item
 * Displays MiniMax Coding Plan usage information
 * - With weekly limit: status bar shows "Weekly remaining% (5h remaining%)"
 * - Without weekly limit: status bar only shows "5h remaining%"
 */
export class MiniMaxStatusBar extends ProviderStatusBarItem<MiniMaxStatusData> {
    constructor() {
        const config: StatusBarItemConfig = {
            id: 'ccmp.statusBar.minimax',
            name: 'CCMP: MiniMax Coding Plan',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 98,
            refreshCommand: 'ccmp.refreshMiniMaxUsage',
            apiKeyProvider: 'minimax-coding',
            cacheKeyPrefix: 'minimax',
            logPrefix: 'MiniMax StatusBar',
            icon: '$(ccmp-minimax)'
        };
        super(config);
    }

    /**
     * Get display text
     * With weekly limit: icon Weekly remaining% (5h remaining%)
     * Without weekly limit: icon 5h remaining%
     */
    protected getDisplayText(data: MiniMaxStatusData): string {
        const items5h = data.limits.filter(l => l.limitType === '5h');
        const itemsWeekly = data.limits.filter(l => l.limitType === 'weekly');
        const remain5h = 100 - this.maxPercentage(items5h);
        if (itemsWeekly.length > 0) {
            const remainWeekly = 100 - this.maxPercentage(itemsWeekly);
            return `${this.config.icon} ${remainWeekly}% (${remain5h}%)`;
        }
        return `${this.config.icon} ${remain5h}%`;
    }

    /**
     * Generate tooltip content
     * Reference Zhipu mode: Rate limit type | Limit value | Remaining amount | Usage rate
     */
    protected generateTooltip(data: MiniMaxStatusData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        md.appendMarkdown('#### MiniMax Coding Plan Usage\n\n');
        md.appendMarkdown('| Rate Limit Type | Limit Value | Remaining | Reset Time |\n');
        md.appendMarkdown('| :--- | ----: | ----: | :---: |\n');

        for (const item of data.limits) {
            const resetTimeStr = item.resetTime ? this.formatDateTime(new Date(item.resetTime)) : '-';
            md.appendMarkdown(`| **${item.label}** | ${item.total} | ${item.remaining} | ${resetTimeStr} |\n`);
        }

        md.appendMarkdown('\n---\n');
        md.appendMarkdown('Click status bar to manually refresh\n');
        return md;
    }

    /**
     * Execute API query
     * Split API response into flat rate limit list
     */
    protected async performApiQuery(): Promise<{ success: boolean; data?: MiniMaxStatusData; error?: string }> {
        const REMAIN_QUERY_URL = 'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains';
        const CODING_PLAN_KEY = 'minimax-coding';

        try {
            const hasCodingKey = await ApiKeyManager.hasValidApiKey(CODING_PLAN_KEY);
            if (!hasCodingKey) {
                return { success: false, error: 'Coding Plan dedicated key not configured, please set Coding Plan API key first' };
            }

            const apiKey = await ApiKeyManager.getApiKey(CODING_PLAN_KEY);
            if (!apiKey) {
                return { success: false, error: 'Unable to get Coding Plan dedicated key' };
            }

            Logger.debug('Triggered MiniMax Coding Plan balance query');
            StatusLogger.debug(`[${this.config.logPrefix}] Starting MiniMax Coding Plan balance query...`);

            const requestOptions: RequestInit = {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('MiniMax')
                }
            };

            let requestUrl = REMAIN_QUERY_URL;
            if (ConfigManager.getMinimaxEndpoint() === 'minimax.io') {
                requestUrl = requestUrl.replace('.minimaxi.com', '.minimax.io');
            }

            const response = await fetch(requestUrl, requestOptions);
            const responseText = await response.text();

            StatusLogger.debug(
                `[${this.config.logPrefix}] Balance query response status: ${response.status} ${response.statusText}`
            );

            // Parse response
            interface ModelRemainInfo {
                start_time: number;
                end_time: number;
                remains_time: number;
                current_interval_total_count: number;
                current_interval_usage_count: number;
                model_name: string;
                current_weekly_total_count: number;
                current_weekly_usage_count: number;
                weekly_start_time: number;
                weekly_end_time: number;
                weekly_remains_time: number;
            }

            interface CodingPlanRemainResponse {
                model_remains: ModelRemainInfo[];
                base_resp: { status_code: number; status_msg: string };
            }

            let parsedResponse: CodingPlanRemainResponse;
            try {
                parsedResponse = JSON.parse(responseText);
            } catch (parseError) {
                Logger.error(`Failed to parse response JSON: ${parseError}`);
                return { success: false, error: `Response format error: ${responseText.substring(0, 200)}` };
            }

            if (!response.ok) {
                const errorMessage = parsedResponse.base_resp?.status_msg || `HTTP ${response.status}`;
                Logger.error(`Balance query failed: ${errorMessage}`);
                return { success: false, error: `Query failed: ${errorMessage}` };
            }

            if (parsedResponse.base_resp && parsedResponse.base_resp.status_code !== 0) {
                const errorMessage = parsedResponse.base_resp.status_msg || 'Unknown business error';
                Logger.error(`Balance query business failed: ${errorMessage}`);
                return { success: false, error: `Business query failed: ${errorMessage}` };
            }

            StatusLogger.debug(`[${this.config.logPrefix}] Balance query successful`);

            const modelRemains = parsedResponse.model_remains;
            if (!modelRemains || modelRemains.length === 0) {
                return { success: false, error: 'Failed to retrieve model balance data' };
            }

            // Split into flat rate limit list
            const limits: MiniMaxLimitItem[] = [];
            const mSeriesModels = modelRemains.filter(m => m.model_name?.startsWith('MiniMax-M'));

            for (const m of mSeriesModels) {
                // Per 5-hour limit
                limits.push(
                    this.buildLimitItem(
                        'Per 5 Hours',
                        '5h',
                        m.current_interval_total_count,
                        m.current_interval_usage_count,
                        m.remains_time,
                        m.end_time
                    )
                );
                // Weekly limit (only add when total > 0, old users show 0 and are not displayed)
                if ((m.current_weekly_total_count ?? 0) > 0) {
                    limits.push(
                        this.buildLimitItem(
                            'Weekly Limit',
                            'weekly',
                            m.current_weekly_total_count,
                            m.current_weekly_usage_count,
                            m.weekly_remains_time,
                            m.weekly_end_time
                        )
                    );
                }
            }

            return { success: true, data: { limits } };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            Logger.error(`Balance query exception: ${errorMessage}`);
            return { success: false, error: `Query exception: ${errorMessage}` };
        }
    }

    /**
     * Build single rate limit item
     */
    private buildLimitItem(
        label: string,
        limitType: '5h' | 'weekly',
        totalCount: number,
        usageCount: number,
        remainsTime: number,
        endTime: number
    ): MiniMaxLimitItem {
        const total = totalCount || 0;
        const remaining = usageCount ?? 0;
        const used = total - remaining;
        const percentage = total > 0 ? parseFloat(((used / total) * 100).toFixed(1)) : 0;

        return {
            label,
            limitType,
            total,
            remaining,
            percentage,
            remainMs: remainsTime,
            resetTime: endTime
        };
    }

    /**
     * Get maximum usage rate from list
     */
    private maxPercentage(items: MiniMaxLimitItem[]): number {
        if (items.length === 0) {
            return 0;
        }
        return Math.max(...items.map(i => i.percentage));
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
     * Check if highlight warning is needed
     */
    protected shouldHighlightWarning(data: MiniMaxStatusData): boolean {
        return this.maxPercentage(data.limits) >= this.HIGH_USAGE_THRESHOLD;
    }

    /**
     * Check if cache refresh is needed
     */
    protected shouldRefresh(): boolean {
        if (!this.lastStatusData) {
            return false;
        }

        const dataAge = Date.now() - this.lastStatusData.timestamp;
        const CACHE_EXPIRY_THRESHOLD = (5 * 60 - 10) * 1000;

        // Determine if refresh is needed based on remainMs
        const remainTimes = this.lastStatusData.data.limits.map(l => l.remainMs).filter(v => v > 0);
        const minRemainMs = remainTimes.length > 0 ? Math.min(...remainTimes) : 0;

        if (minRemainMs > 0 && dataAge > minRemainMs) {
            StatusLogger.debug(
                `[${this.config.logPrefix}] Cache time (${(dataAge / 1000).toFixed(1)}s) exceeds shortest reset time (${(minRemainMs / 1000).toFixed(1)}s), triggering API refresh`
            );
            return true;
        }

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
    getLastStatusData(): { data: MiniMaxStatusData; timestamp: number } | null {
        return this.lastStatusData;
    }
}

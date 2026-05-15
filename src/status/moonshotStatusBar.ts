/*---------------------------------------------------------------------------------------------
 *  Moonshot Balance Query Status Bar Item
 *  Inherits ProviderStatusBarItem, displays Moonshot balance information
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderStatusBarItem, StatusBarItemConfig } from './providerStatusBarItem';
import { StatusLogger } from '../utils/statusLogger';
import { Logger } from '../utils/logger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { VersionManager } from '../utils/versionManager';

/**
 * Moonshot balance information data structure
 */
export interface MoonshotBalanceInfo {
    /** Available balance, including cash balance and voucher balance */
    available_balance: number;
    /** Voucher balance, will not be negative */
    voucher_balance: number;
    /** Cash balance, may be negative, represents user owes fees */
    cash_balance: number;
}

/**
 * Moonshot balance data structure (API response format)
 */
export interface MoonshotBalanceResponse {
    /** Response code */
    code: number;
    /** Balance information */
    data: MoonshotBalanceInfo;
    /** Status code */
    scode: string;
    /** Whether status is successful */
    status: boolean;
}

/**
 * Moonshot status data
 */
export interface MoonshotStatusData {
    /** Balance information */
    balanceInfo: MoonshotBalanceInfo;
    /** Last update time */
    lastUpdated: string;
}

/**
 * Moonshot balance query status bar item
 * Displays Moonshot balance information, including:
 * - Available balance (displayed in status bar)
 * - Cash balance (displayed in tooltip)
 * - Voucher balance (displayed in tooltip)
 * - Auto-refreshes every 5 minutes
 */
export class MoonshotStatusBar extends ProviderStatusBarItem<MoonshotStatusData> {
    constructor() {
        const config: StatusBarItemConfig = {
            id: 'ccmp.statusBar.moonshot',
            name: 'CCMP: Moonshot Balance',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 89, // Priority slightly lower than Kimi
            refreshCommand: 'ccmp.moonshot.refreshBalance',
            apiKeyProvider: 'moonshot',
            cacheKeyPrefix: 'moonshot',
            logPrefix: 'Moonshot StatusBar',
            icon: '$(ccmp-moonshot)'
        };
        super(config);
    }

    /**
     * Get display text (displays available balance)
     */
    protected getDisplayText(data: MoonshotStatusData): string {
        const balance = data.balanceInfo.available_balance;
        const balanceText = balance.toFixed(2);
        return `${this.config.icon} ¥${balanceText}`;
    }

    /**
     * Generate Tooltip content (displays all balance information)
     */
    protected generateTooltip(data: MoonshotStatusData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;

        md.appendMarkdown('#### Moonshot User Account Balance\n\n');

        md.appendMarkdown('| Currency | Cash Balance | Voucher | Available Balance |\n');
        md.appendMarkdown('| :---: | ---: | ---: | ---: |\n');
        md.appendMarkdown(
            `| **CNY** | ${data.balanceInfo.cash_balance.toFixed(2)} | ${data.balanceInfo.voucher_balance.toFixed(2)} | **${data.balanceInfo.available_balance.toFixed(2)}** |\n`
        );

        md.appendMarkdown('\n---\n');
        md.appendMarkdown(`**Last Updated** ${data.lastUpdated}\n`);
        md.appendMarkdown('\n');
        md.appendMarkdown('---\n');
        md.appendMarkdown('Click status bar to manually refresh\n');
        return md;
    }

    /**
     * Perform API query
     * Implement Moonshot balance query logic
     */
    protected async performApiQuery(): Promise<{ success: boolean; data?: MoonshotStatusData; error?: string }> {
        const BALANCE_QUERY_URL = 'https://api.moonshot.cn/v1/users/me/balance';
        const MOONSHOT_KEY = 'moonshot';

        try {
            // Check if Moonshot key exists
            const hasApiKey = await ApiKeyManager.hasValidApiKey(MOONSHOT_KEY);
            if (!hasApiKey) {
                return {
                    success: false,
                    error: 'Moonshot API key not configured, please set Moonshot API key first'
                };
            }

            // Get Moonshot key
            const apiKey = await ApiKeyManager.getApiKey(MOONSHOT_KEY);
            if (!apiKey) {
                return {
                    success: false,
                    error: 'Unable to get Moonshot API key'
                };
            }

            Logger.debug('Triggered Moonshot balance query');
            StatusLogger.debug(`[${this.config.logPrefix}] Starting Moonshot balance query...`);

            // Build request
            const requestOptions: RequestInit = {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('Moonshot')
                }
            };

            // Send request
            const response = await fetch(BALANCE_QUERY_URL, requestOptions);
            const responseText = await response.text();

            StatusLogger.debug(
                `[${this.config.logPrefix}] Balance query response status: ${response.status} ${response.statusText}`
            );

            // Parse response
            let parsedResponse: MoonshotBalanceResponse;
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
                let errorMessage = `HTTP ${response.status}`;
                if (responseText) {
                    try {
                        const errorData = JSON.parse(responseText);
                        if (errorData.error) {
                            errorMessage = errorData.error.message || errorData.error;
                        }
                    } catch {
                        // If parsing error response fails, use default error message
                    }
                }
                Logger.error(`Balance query failed: ${errorMessage}`);
                return {
                    success: false,
                    error: `Query failed: ${errorMessage}`
                };
            }

            // Check API response status
            if (!parsedResponse.status || parsedResponse.code !== 0) {
                const errorMessage = parsedResponse.scode || 'Unknown error';
                Logger.error(`API returned error: ${errorMessage}`);
                return {
                    success: false,
                    error: `API error: ${errorMessage}`
                };
            }

            // Check if contains valid balance data
            if (!parsedResponse.data) {
                Logger.error('Balance data not obtained');
                return {
                    success: false,
                    error: 'Balance data not obtained'
                };
            }

            // Format last update time
            const lastUpdated = new Date().toLocaleString('zh-CN');

            // Parse successful response
            StatusLogger.debug(`[${this.config.logPrefix}] Balance query successful`);

            return {
                success: true,
                data: {
                    balanceInfo: parsedResponse.data,
                    lastUpdated
                }
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            Logger.error(`Balance query exception: ${errorMessage}`);
            return {
                success: false,
                error: `Query exception: ${errorMessage}`
            };
        }
    }

    /**
     * Check if highlight warning is needed
     * Highlight when available balance is below threshold
     */
    protected shouldHighlightWarning(_data: MoonshotStatusData): boolean {
        return false; // Moonshot does not set balance warning
    }

    /**
     * Check if cache refresh is needed
     * Fixed refresh every 5 minutes
     */
    protected shouldRefresh(): boolean {
        if (!this.lastStatusData) {
            return false;
        }

        const dataAge = Date.now() - this.lastStatusData.timestamp;
        const REFRESH_INTERVAL = (5 * 60 - 10) * 1000; // Cache expiry threshold 5 minutes

        // Check if exceeds 5 minute refresh interval
        if (dataAge > REFRESH_INTERVAL) {
            StatusLogger.debug(
                `[${this.config.logPrefix}] Cache time (${(dataAge / 1000).toFixed(1)} seconds) exceeds 5 minute refresh interval, triggering API refresh`
            );
            return true;
        }

        return false;
    }

    /**
     * Accessor: get last status data (for testing and debugging)
     */
    getLastStatusData(): { data: MoonshotStatusData; timestamp: number } | null {
        return this.lastStatusData;
    }
}

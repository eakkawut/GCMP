/*---------------------------------------------------------------------------------------------
 *  ChatGPT Usage Query Status Bar Item
 *  Displays ChatGPT (Codex) account usage and limit information
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BaseStatusBarItem, StatusBarItemConfig } from './baseStatusBarItem';
import { configProviders } from '../providers/config';
import { StatusLogger } from '../utils/statusLogger';
import { Logger } from '../utils/logger';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';
import { CodexCliAuth } from '../cli/auth/codexCliAuth';

/**
 * Rate limit window structure
 */
interface RateLimitWindow {
    /** Used percentage */
    used_percent: number;
    /** Limit window seconds */
    limit_window_seconds: number;
    /** Remaining reset seconds */
    reset_after_seconds: number;
    /** Reset timestamp */
    reset_at: number;
}

/**
 * Rate limit information structure
 */
interface RateLimitInfo {
    /** Whether allowed */
    allowed: boolean;
    /** Whether limit reached */
    limit_reached: boolean;
    /** Primary time window */
    primary_window: RateLimitWindow;
    /** Secondary time window */
    secondary_window?: RateLimitWindow;
}

/**
 * ChatGPT usage information data structure (API response format)
 */
export interface ChatGPTUsageResponse {
    /** User ID */
    user_id: string;
    /** Account ID */
    account_id: string;
    /** Email */
    email: string;
    /** Plan type: free, plus, pro, etc. */
    plan_type: string;
    /** Rate limit information */
    rate_limit: RateLimitInfo;
    /** Code review rate limit */
    code_review_rate_limit?: RateLimitInfo;
    /** Additional rate limits */
    additional_rate_limits: unknown | null;
    /** Credits/balance information */
    credits: unknown | null;
    /** Promotional information */
    promo: unknown | null;
}

/**
 * ChatGPT status data
 */
export interface ChatGPTStatusData {
    /** User ID */
    userId: string;
    /** Account ID */
    accountId: string;
    /** Email */
    email: string;
    /** Plan type */
    planType: string;
    /** Rate limit information */
    rateLimit: RateLimitInfo;
    /** Code review used percentage */
    codeReviewUsedPercent: number;
    /** Last update time */
    lastUpdated: string;
}

/**
 * Determine window type based on limit_window_seconds
 * Only handle 300 minutes (5 hours) and 1 week cases
 */
function getWindowType(limitWindowSeconds: number): { type: string; label: string } {
    // 300 minutes = 5 hours = 18000 seconds
    const FIVE_HOURS = 5 * 60 * 60;
    // 1 week = 7 * 24 * 60 * 60 = 604800 seconds
    const WEEK = 7 * 24 * 60 * 60;

    if (limitWindowSeconds === FIVE_HOURS) {
        return { type: 'hourly', label: '300 minutes' };
    } else if (limitWindowSeconds === WEEK) {
        return { type: 'weekly', label: 'Weekly allowance' };
    } else {
        // Default to weekly processing
        return { type: 'weekly', label: 'Weekly allowance' };
    }
}

/**
 * ChatGPT usage query status bar item
 * Displays ChatGPT account usage information, including:
 * - Used percentage (displayed in status bar)
 * - Plan type (displayed in tooltip)
 * - Remaining time (displayed in tooltip)
 * - Auto-refreshes every 5 minutes
 */
export class ChatGPTStatusBar extends BaseStatusBarItem<ChatGPTStatusData> {
    constructor() {
        const config: StatusBarItemConfig = {
            id: 'ccmp.statusBar.chatgpt',
            name: 'CCMP: ChatGPT Usage',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 15,
            refreshCommand: 'ccmp.chatgpt.refreshUsage',
            apiKeyProvider: 'codex',
            cacheKeyPrefix: 'chatgpt',
            logPrefix: 'ChatGPT StatusBar',
            icon: '$(ccmp-openai)'
        };
        super(config);
    }

    /**
     * Get display text
     * Format: "$(icon) 85% (92%)" - parentheses contain 5-hour allowance, outside is weekly allowance
     * Only displays 300 minutes and weekly windows
     */
    protected getDisplayText(data: ChatGPTStatusData): string {
        const primaryWindow = data.rateLimit.primary_window;
        const secondaryWindow = data.rateLimit.secondary_window;

        // Get window types
        const primaryType = getWindowType(primaryWindow.limit_window_seconds);
        const secondaryType = secondaryWindow ? getWindowType(secondaryWindow.limit_window_seconds) : null;

        // Determine which is weekly and which is hourly
        let weeklyRemaining = 0;
        let hourlyRemaining = 0;

        if (primaryType.type === 'weekly') {
            weeklyRemaining = Math.max(0, 100 - primaryWindow.used_percent);
            if (secondaryType && secondaryType.type === 'hourly' && secondaryWindow) {
                hourlyRemaining = Math.max(0, 100 - secondaryWindow.used_percent);
            }
        } else if (primaryType.type === 'hourly') {
            hourlyRemaining = Math.max(0, 100 - primaryWindow.used_percent);
            if (secondaryType && secondaryType.type === 'weekly' && secondaryWindow) {
                weeklyRemaining = Math.max(0, 100 - secondaryWindow.used_percent);
            }
        }

        // Parentheses contain 5-hour allowance, outside is weekly allowance
        if (hourlyRemaining > 0) {
            return `${this.config.icon} ${weeklyRemaining.toFixed(0)}% (${hourlyRemaining.toFixed(0)}%)`;
        }

        return `${this.config.icon} ${weeklyRemaining.toFixed(0)}%`;
    }

    /**
     * Generate Tooltip content
     */
    protected generateTooltip(data: ChatGPTStatusData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;

        const primaryWindow = data.rateLimit.primary_window;
        const secondaryWindow = data.rateLimit.secondary_window;

        const primaryType = getWindowType(primaryWindow.limit_window_seconds);
        const secondaryType = secondaryWindow ? getWindowType(secondaryWindow.limit_window_seconds) : null;

        // Plan type mapping
        const planTypeMap: Record<string, string> = {
            free: 'Free',
            plus: 'Plus',
            pro: 'Pro',
            team: 'Team',
            enterprise: 'Enterprise'
        };
        const planTypeDisplay = planTypeMap[data.planType] || data.planType;

        md.appendMarkdown(`#### ChatGPT ${planTypeDisplay}\n\n`);
        md.appendMarkdown('| Rate Limit Type | Remaining | Reset Time |\n');
        md.appendMarkdown('| :----: | ----: | :------: |\n');

        // Primary window
        const primaryRemaining = Math.max(0, 100 - primaryWindow.used_percent);
        const primaryResetDate = new Date(primaryWindow.reset_at * 1000);
        const primaryResetTimeStr = primaryResetDate.toLocaleString('en-US', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        md.appendMarkdown(
            `| **${primaryType.label}** | **${primaryRemaining.toFixed(0)}%** | ${primaryResetTimeStr} |\n`
        );

        // Secondary window (if valid type)
        if (secondaryWindow && secondaryType) {
            const secondaryRemaining = Math.max(0, 100 - secondaryWindow.used_percent);
            const secondaryResetDate = new Date(secondaryWindow.reset_at * 1000);
            const secondaryResetTimeStr = secondaryResetDate.toLocaleString('en-US', {
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
            md.appendMarkdown(
                `| **${secondaryType.label}** | **${secondaryRemaining.toFixed(0)}%** | ${secondaryResetTimeStr} |\n`
            );
        }

        md.appendMarkdown('\n');
        md.appendMarkdown('---\n');
        md.appendMarkdown(`**Last Updated** ${data.lastUpdated}\n`);
        md.appendMarkdown('\n');
        md.appendMarkdown('---\n');
        md.appendMarkdown('Click status bar to manually refresh\n');

        return md;
    }

    /**
     * Perform API query
     * Implement ChatGPT usage query logic
     */
    protected async performApiQuery(): Promise<{ success: boolean; data?: ChatGPTStatusData; error?: string }> {
        const USAGE_QUERY_URL = 'https://chatgpt.com/backend-api/wham/usage';

        try {
            // Get Codex auth instance
            const codexAuth = CliAuthFactory.getInstance('codex') as CodexCliAuth | null;
            if (!codexAuth) {
                return {
                    success: false,
                    error: 'Codex CLI authentication not configured, please complete Codex CLI login first'
                };
            }

            // Ensure authentication is valid (auto-refresh tokens)
            const credentials = await codexAuth.ensureAuthenticated();
            if (!credentials || !credentials.access_token) {
                return {
                    success: false,
                    error: 'Codex CLI authentication invalid, please login again'
                };
            }

            // Get account_id
            const accountId = await codexAuth.getAccountId();
            if (!accountId) {
                return {
                    success: false,
                    error: 'Unable to get ChatGPT account ID'
                };
            }

            Logger.debug('Triggered ChatGPT usage query');
            StatusLogger.debug(`[${this.config.logPrefix}] Starting ChatGPT usage query...`);

            // Build request
            const requestOptions: RequestInit = {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${credentials.access_token}`,
                    'user-agent': configProviders.codex.customHeader?.['user-agent'] as string,
                    'chatgpt-account-id': accountId
                }
            };

            // Send request
            const response = await fetch(USAGE_QUERY_URL, requestOptions);
            const responseText = await response.text();

            StatusLogger.debug(
                `[${this.config.logPrefix}] Usage query response status: ${response.status} ${response.statusText}`
            );

            // Parse response
            let parsedResponse: ChatGPTUsageResponse;
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
                Logger.error(`Usage query failed: ${errorMessage}`);
                return {
                    success: false,
                    error: `Query failed: ${errorMessage}`
                };
            }

            // Check required fields
            if (!parsedResponse.rate_limit || !parsedResponse.rate_limit.primary_window) {
                Logger.error('Failed to retrieve valid usage data');
                return {
                    success: false,
                    error: 'Failed to retrieve valid usage data'
                };
            }

            const rateLimit = parsedResponse.rate_limit;

            // Format last update time
            const lastUpdated = new Date().toLocaleString('en-US');

            // Parse code review usage
            let codeReviewUsedPercent = 0;
            if (parsedResponse.code_review_rate_limit?.primary_window) {
                codeReviewUsedPercent = parsedResponse.code_review_rate_limit.primary_window.used_percent;
            }

            // Parse successful response
            StatusLogger.debug(`[${this.config.logPrefix}] Usage query successful`);

            return {
                success: true,
                data: {
                    userId: parsedResponse.user_id,
                    accountId: parsedResponse.account_id,
                    email: parsedResponse.email,
                    planType: parsedResponse.plan_type,
                    rateLimit: rateLimit,
                    codeReviewUsedPercent,
                    lastUpdated
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
     * Highlight when weekly usage exceeds 80%
     */
    protected shouldHighlightWarning(data: ChatGPTStatusData): boolean {
        const primaryWindow = data.rateLimit.primary_window;
        const secondaryWindow = data.rateLimit.secondary_window;

        // Check weekly allowance usage rate
        const primaryType = getWindowType(primaryWindow.limit_window_seconds);
        if (primaryType.type === 'weekly') {
            return primaryWindow.used_percent >= this.HIGH_USAGE_THRESHOLD;
        }

        // If primary window is not weekly, check secondary window
        if (secondaryWindow) {
            const secondaryType = getWindowType(secondaryWindow.limit_window_seconds);
            if (secondaryType.type === 'weekly') {
                return secondaryWindow.used_percent >= this.HIGH_USAGE_THRESHOLD;
            }
        }

        return false;
    }

    /**
     * Check if cache refresh is needed
     * Fixed refresh every 5 minutes
     */
    protected shouldRefresh(): boolean {
        if (!this.lastStatusData) {
            return true;
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
    getLastStatusData(): { data: ChatGPTStatusData; timestamp: number } | null {
        return this.lastStatusData;
    }
}

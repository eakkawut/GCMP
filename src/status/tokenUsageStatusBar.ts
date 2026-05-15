/*---------------------------------------------------------------------------------------------
 *  Token Usage Status Bar
 *  Token usage status bar - displays today's token usage
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TokenUsagesManager } from '../usages/usagesManager';
import { StatusLogger } from '../utils/statusLogger';
import { DateUtils } from '../usages/fileLogger/dateUtils';
import { UserActivityService } from './userActivityService';
import type { TokenUsageStatsFromFile } from '../usages/fileLogger/types';

/**
 * Token usage status bar
 * Displays today's token usage, click to open detailed view
 */
export class TokenUsageStatusBar {
    private statusBarItem: vscode.StatusBarItem | undefined;
    private usagesManager: TokenUsagesManager;
    private updateDisposable: vscode.Disposable | undefined;
    private updateTimer: NodeJS.Timeout | undefined;
    private lastUpdateTime = 0;
    private readonly UPDATE_INTERVAL = 30000; // Update every 30 seconds
    private readonly UPDATE_COOLDOWN = 10000; // No duplicate updates within 10 seconds after recent update

    constructor(private context: vscode.ExtensionContext) {
        this.usagesManager = TokenUsagesManager.instance;
    }

    /**
     * Initialize status bar
     */
    async initialize(): Promise<void> {
        this.statusBarItem = vscode.window.createStatusBarItem(
            'ccmp.statusBar.tokenUsage',
            vscode.StatusBarAlignment.Right,
            11 // Priority set before contextUsage (12)
        );

        this.statusBarItem.name = 'CCMP: Token Usage';
        this.statusBarItem.command = 'ccmp.tokenUsage.showDetails';

        // Initial update display
        this.updateDisplay().then(() => {
            this.statusBarItem?.show();
        });

        // Listen for statistics update events from file log system
        const fileLogger = this.usagesManager.getFileLogger();
        this.updateDisposable = fileLogger.onStatsUpdate(async () => {
            await this.updateDisplay();
        });

        // Start periodic update
        this.startPeriodicUpdate();

        this.context.subscriptions.push(this.statusBarItem);
        StatusLogger.debug('[Token statistics status bar] Initialization complete');
    }

    /**
     * Start periodic update
     */
    private startPeriodicUpdate(): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
        }

        this.updateTimer = setInterval(async () => {
            await this.periodicUpdate();
        }, this.UPDATE_INTERVAL);

        StatusLogger.debug(`[Token statistics status bar] Started periodic update, interval: ${this.UPDATE_INTERVAL}ms`);
    }

    /**
     * Stop periodic update
     */
    private stopPeriodicUpdate(): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = undefined;
            StatusLogger.debug('[Token statistics status bar] Stopped periodic update');
        }
    }

    /**
     * Periodic update callback
     */
    private async periodicUpdate(): Promise<void> {
        // Check if user is active
        if (!UserActivityService.isUserActive()) {
            StatusLogger.trace('[Token statistics status bar] User inactive, skipping update');
            return;
        }

        // Check if in cooldown period
        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastUpdateTime;
        if (timeSinceLastUpdate < this.UPDATE_COOLDOWN) {
            StatusLogger.trace(`[Token statistics status bar] Only ${timeSinceLastUpdate}ms since last update, waiting for next cycle`);
            return;
        }

        // Execute update
        await this.updateDisplay();
    }

    /**
     * Update display
     */
    async updateDisplay(): Promise<void> {
        if (!this.statusBarItem) {
            return;
        }

        try {
            const today = DateUtils.getTodayDateString();
            const todayStats = await this.usagesManager.getDateStats(today);

            // Calculate today's total tokens
            let totalInputTokens = 0;
            let totalOutputTokens = 0;
            let totalRequests = 0;

            for (const stats of Object.values(todayStats.providers)) {
                totalInputTokens += stats.actualInput;
                totalOutputTokens += stats.outputTokens;
                totalRequests += stats.requests;
            }

            const totalTokens = totalInputTokens + totalOutputTokens;

            // Update status bar text
            if (totalRequests === 0) {
                this.statusBarItem.text = '$(pulse)';
            } else {
                this.statusBarItem.text = `$(pulse) ${this.formatTokens(totalTokens)}`;
            }

            // Update Tooltip (asynchronously generated)
            this.statusBarItem.tooltip = await this.generateTooltip(todayStats);

            // Update last update time
            this.lastUpdateTime = Date.now();
        } catch (err) {
            StatusLogger.error('[Token statistics status bar] Failed to update display:', err);
            this.statusBarItem.text = '$(pulse)';
        }
    }

    /**
     * Generate Tooltip (displays today's per-provider statistics + recent history)
     */
    private async generateTooltip(stats: TokenUsageStatsFromFile): Promise<vscode.MarkdownString> {
        const md = new vscode.MarkdownString();
        md.supportHtml = false;
        md.isTrusted = true;

        md.appendMarkdown('**CCMP: Today Token Consumption Statistics**\n\n');
        md.appendMarkdown('\n---\n');

        const providers = Object.values(stats.providers);
        if (providers.length === 0) {
            md.appendMarkdown('No usage records');
            md.appendMarkdown('\n\n---\n\nClick to view details');
            return md;
        }

        // ========== Today's usage table ==========
        // Statistics by provider (sorted by total tokens)
        const sortedProviders = providers.sort((a, b) => {
            const totalA = a.actualInput + a.outputTokens;
            const totalB = b.actualInput + b.outputTokens;
            return totalB - totalA;
        });
        // Create provider statistics table
        md.appendMarkdown(
            '| Provider        | Input Tokens | Cache Hit | Output Tokens | Consumed Tokens | Requests | Avg Latency | Avg Speed |\n'
        );
        md.appendMarkdown('| :------------ | ------: | ------: | ------: | ------: | ----: | ------: | ------: |\n');
        for (const providerStats of sortedProviders) {
            const providerTotal = providerStats.actualInput + providerStats.outputTokens;
            // Calculate average output speed
            const avgSpeed = this.calculateAverageSpeed(providerStats);
            // Calculate average first Token latency
            const avgLatency = this.calculateAverageFirstTokenLatency(providerStats.firstTokenLatency);
            md.appendMarkdown(
                `| ${providerStats.providerName} | ${this.formatTokens(providerStats.actualInput)} | ` +
                `${this.formatTokens(providerStats.cacheTokens)} | ` +
                `${this.formatTokens(providerStats.outputTokens)} | ` +
                `**${this.formatTokens(providerTotal)}** | ${providerStats.requests} | ${avgLatency} | ${avgSpeed} |\n`
            );
        }
        // Total row (only shown when there are multiple providers)
        if (providers.length > 1) {
            const total = stats.total.actualInput + stats.total.outputTokens;
            const avgSpeedTotal = this.calculateAverageSpeed(stats.total);
            const avgLatencyTotal = this.calculateAverageFirstTokenLatency(stats.total.firstTokenLatency);
            md.appendMarkdown(
                `| **Total** | **${this.formatTokens(stats.total.actualInput)}** | ` +
                `**${this.formatTokens(stats.total.cacheTokens)}** | ` +
                `**${this.formatTokens(stats.total.outputTokens)}** | ` +
                `**${this.formatTokens(total)}** | **${stats.total.requests}** | **${avgLatencyTotal}** | **${avgSpeedTotal}** |\n`
            );
        }

        // ========== Recent request records table ==========
        try {
            const recentRequests = await this.usagesManager.getRecentRecords(3); // Get recent 3 records

            if (recentRequests.length > 0) {
                md.appendMarkdown('\n\n ---- \n\n\n\n');
                // Create table header
                md.appendMarkdown(
                    '| Provider      | Request Time | Consumption | Status | Input Tokens | Cache Hit | Output Tokens | Response Latency | Output Speed |\n'
                );
                md.appendMarkdown(
                    '| :----------- | :-----: | -----: | :----: | -----: | -----: | -----: | ------: | -----: |\n'
                );

                // Reverse array, show latest requests at the bottom
                const reversedRequests = [...recentRequests].reverse();
                for (const req of reversedRequests) {
                    const startTime = new Date(req.timestamp);
                    // Determine status icon: only show when rawUsage exists and status is completed
                    let statusIcon = '⏳'; // Default is in progress
                    if (req.status === 'completed' && req.rawUsage) {
                        statusIcon = '✅'; // Truly completed
                    } else if (req.status === 'failed') {
                        statusIcon = '❌'; // Failed
                    } else if (req.status === 'estimated') {
                        statusIcon = '⏳'; // Estimating
                    }
                    const timeStr = startTime.toLocaleTimeString('zh-CN');

                    // Directly access extension properties
                    const actualInput = req.actualInput;
                    const cacheTokens = req.cacheReadTokens;
                    const outputTokens = req.outputTokens;
                    const totalTokens = req.totalTokens;

                    // Format output speed
                    const speedStr = req.outputSpeed !== undefined ? `${req.outputSpeed.toFixed(1)} t/s` : '-';

                    // Format first Token latency
                    let latencyStr = '-';
                    if (req.streamStartTime !== undefined && req.timestamp !== undefined) {
                        const latency = req.streamStartTime - req.timestamp;
                        if (Number.isFinite(latency) && latency >= 0) {
                            if (latency >= 1000) {
                                latencyStr = `${(latency / 1000).toFixed(1)} s`;
                            } else {
                                latencyStr = `${Math.round(latency)} ms`;
                            }
                        }
                    }

                    // Decide whether to show actual or estimated value based on status
                    let inputStr = '-';
                    let cacheStr = '-';
                    let outputStr = '-';
                    let totalStr = '-';
                    if (req.status === 'completed' && req.rawUsage && totalTokens > 0) {
                        // Completed status with actual values: show actual values
                        inputStr = this.formatTokens(actualInput);
                        cacheStr = cacheTokens > 0 ? this.formatTokens(cacheTokens) : '-';
                        outputStr = outputTokens > 0 ? this.formatTokens(outputTokens) : '-';
                        totalStr = this.formatTokens(totalTokens);
                    } else {
                        // Estimated or failed status or no actual values: show estimated values (with ~ prefix)
                        if (req.estimatedInput !== undefined && req.estimatedInput > 0) {
                            totalStr = inputStr = `~${this.formatTokens(req.estimatedInput)}`;
                        }
                    }

                    md.appendMarkdown(
                        `| ${req.providerName} | ${timeStr} | ${totalStr} | ${statusIcon} | ${inputStr} | ${cacheStr} | ${outputStr} | ${latencyStr} | ${speedStr} |\n`
                    );
                }
            }
        } catch (err) {
            // Ignore errors, does not affect basic functionality
            StatusLogger.debug('[Token statistics status bar] Failed to get request records:', err);
        }

        md.appendMarkdown('\n---\n\nClick to view details');

        return md;
    }

    /**
     * Calculate average output speed
     * Prefer to use outputSpeeds (already aggregated average speed)
     * @param stats Statistics data
     * @returns Formatted average speed string
     */
    private calculateAverageSpeed(stats: { outputSpeeds?: number }): string {
        if (stats.outputSpeeds && stats.outputSpeeds > 0) {
            return `${stats.outputSpeeds.toFixed(1)} t/s`;
        }
        return '-';
    }

    /**
     * Calculate average first Token latency
     * @param firstTokenLatency Average first Token latency (milliseconds)
     * @returns Formatted average first Token latency string
     */
    private calculateAverageFirstTokenLatency(firstTokenLatency?: number): string {
        if (!firstTokenLatency || firstTokenLatency <= 0) {
            return '-';
        }
        const avgLatency = firstTokenLatency;
        if (avgLatency >= 1000) {
            return `${(avgLatency / 1000).toFixed(1)} s`;
        }
        return `${Math.round(avgLatency)} ms`;
    }

    /**
     * Format token quantity
     */
    private formatTokens(tokens: number): string {
        if (tokens >= 1000000) {
            return (tokens / 1000000).toFixed(1) + 'M';
        } else if (tokens >= 1000) {
            return (tokens / 1000).toFixed(1) + 'K';
        } else {
            return tokens.toString();
        }
    }

    /**
     * Check and display status
     */
    async checkAndShowStatus(): Promise<void> {
        if (this.statusBarItem) {
            this.statusBarItem.show();
        }
    }

    /**
     * Delayed update
     */
    delayedUpdate(delayMs: number = 1000): void {
        setTimeout(() => {
            this.updateDisplay();
        }, delayMs);
    }

    /**
     * Destroy status bar
     */
    dispose(): void {
        this.stopPeriodicUpdate();
        this.updateDisposable?.dispose();
        this.statusBarItem?.dispose();
    }
}

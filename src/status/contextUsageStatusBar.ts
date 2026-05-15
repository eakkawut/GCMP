/*---------------------------------------------------------------------------------------------
 *  Model Context Window Usage Status Bar
 *  Displays the model context window usage of the most recent request
 *  Independent implementation, does not use caching mechanism
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StatusLogger } from '../utils/statusLogger';

/**
 * Token usage details for prompt parts
 */
export interface PromptPartTokens {
    /** System prompt token count */
    systemPrompt?: number;
    /** Available tools description token count */
    availableTools?: number;
    /** Environment info token count (environment_info and workspace_info) */
    environment?: number;
    /** User/assistant message token count (user + assistant + tool roles merged) */
    userAssistantMessage?: number;
    /** History message token count (all messages before this conversation round) */
    historyMessages?: number;
    /** Current round message token count (all messages starting from the last user text message) */
    currentRoundMessages?: number;
    /** Current round image token count (only counts image DataPart in current round messages) */
    currentRoundImages?: number;
    /** Thinking process token count (thinking content) */
    thinking?: number;
    /** Auto-compressed part token count */
    autoCompressed?: number;
    /** Context content token count (sum) */
    context?: number;
}

/**
 * Model context window usage data interface
 */
export interface ContextUsageData {
    /** Model ID */
    modelId: string;
    /** Model name */
    modelName: string;
    /** Input token count */
    inputTokens: number;
    /** Maximum input token count */
    maxInputTokens: number;
    /** Usage percentage */
    percentage: number;
    /** Request timestamp */
    timestamp: number;
    /** Token usage details for each prompt part */
    promptParts?: PromptPartTokens;
    /** Remaining available token count */
    remainingTokens?: number;
}

/**
 * Model context window usage status bar
 * Independent implementation, not dependent on caching mechanism
 * Only updates status directly via updateContextUsage when requests occur
 */
export class ContextUsageStatusBar {
    // Static instance for global access
    private static instance: ContextUsageStatusBar | undefined;

    // Status bar item
    private statusBarItem: vscode.StatusBarItem | undefined;

    // Default data showing 0%
    private readonly defaultData: ContextUsageData = {
        modelId: '',
        modelName: 'No Requests',
        inputTokens: 0,
        maxInputTokens: 0,
        percentage: 0,
        timestamp: 0
    };

    constructor() {
        // Save instance reference
        ContextUsageStatusBar.instance = this;
    }

    /**
     * Get global instance
     */
    static getInstance(): ContextUsageStatusBar | undefined {
        return ContextUsageStatusBar.instance;
    }

    /**
     * Initialize status bar
     */
    async initialize(context: vscode.ExtensionContext): Promise<void> {
        this.statusBarItem = vscode.window.createStatusBarItem(
            'ccmp.statusBar.contextUsage',
            vscode.StatusBarAlignment.Right,
            12
        );

        this.statusBarItem.name = 'CCMP: Context Usage';

        // Initial display
        this.updateUI(this.defaultData);
        this.statusBarItem.show();

        context.subscriptions.push(this.statusBarItem);
        StatusLogger.debug('[Context Window Usage StatusBar] Initialization complete');
    }

    /**
     * Update context usage data (external call)
     */
    updateContextUsage(data: ContextUsageData): void {
        StatusLogger.debug(`[Context Window Usage StatusBar] Updating context usage: ${data.inputTokens}/${data.maxInputTokens}`);

        // Update UI directly (no cache)
        this.updateUI(data);

        // Ensure status bar is visible
        if (this.statusBarItem) {
            this.statusBarItem.show();
        }
    }

    /**
     * Update status bar UI
     */
    private updateUI(data: ContextUsageData): void {
        if (!this.statusBarItem) {
            return;
        }

        // Update text
        this.statusBarItem.text = this.getDisplayText(data);

        // Update Tooltip
        this.statusBarItem.tooltip = this.generateTooltip(data);
    }

    /**
     * Get icon based on percentage
     */
    private getPieChartIcon(percentage: number): string {
        if (percentage === 0) {
            return '$(ccmp-tokens)'; // 0%
        } else if (percentage <= 25) {
            return '$(ccmp-token1)'; // 1/8
        } else if (percentage <= 35) {
            return '$(ccmp-token2)'; // 2/8
        } else if (percentage <= 45) {
            return '$(ccmp-token3)'; // 3/8
        } else if (percentage <= 55) {
            return '$(ccmp-token4)'; // 4/8
        } else if (percentage <= 65) {
            return '$(ccmp-token5)'; // 5/8
        } else if (percentage <= 75) {
            return '$(ccmp-token6)'; // 6/8
        } else if (percentage <= 85) {
            return '$(ccmp-token7)'; // 7/8
        } else {
            return '$(ccmp-token8)'; // 8/8 (full)
        }
    }

    /**
     * Format token count to human-readable format (e.g., 2K, 96K)
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
     * Get display text
     */
    protected getDisplayText(data: ContextUsageData): string {
        // const percentage = data.percentage.toFixed(1);
        const icon = this.getPieChartIcon(data.percentage);
        // return data.percentage === 0 ? icon : `${icon} ${percentage}%`;
        return icon;
    }

    /**
     * Generate tooltip content
     */
    private generateTooltip(data: ContextUsageData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;

        md.appendMarkdown('#### Model Context Window Usage\n\n');

        // If default data (no requests), show hint
        if (data.inputTokens === 0 && data.maxInputTokens === 0) {
            md.appendMarkdown('💡 Displayed after sending any CCMP model request\n');
            return md;
        }

        md.appendMarkdown('\n---\n');
        md.appendMarkdown('|        |          |\n');
        md.appendMarkdown('| ------ | :------- |\n');

        const requestTime = new Date(data.timestamp);
        const requestTimeStr = requestTime.toLocaleString('en-US');
        md.appendMarkdown(`| **Request Time** | ${requestTimeStr} |\n`);
        md.appendMarkdown(`| **Model Name** | ${data.modelName} |\n`);
        const usageString = `${this.formatTokens(data.inputTokens)}/${this.formatTokens(data.maxInputTokens)}`;
        md.appendMarkdown(`| **Usage** | **${data.percentage.toFixed(1)}%** \t ${usageString} |\n`);

        if (data.promptParts) {
            md.appendMarkdown('\n---\n');
            const parts = data.promptParts;
            const totalTokens = data.inputTokens;

            // Header row (display window info, three-column format)
            md.appendMarkdown('|          |          |          |\n');
            md.appendMarkdown('| :------- | -------: | -------: |\n');

            // 1. System prompt
            if (parts.systemPrompt !== undefined && parts.systemPrompt > 0) {
                const percent = totalTokens > 0 ? ((parts.systemPrompt / totalTokens) * 100).toFixed(1) : '0';
                md.appendMarkdown(`| **System Prompt** | ${percent}% | ${this.formatTokens(parts.systemPrompt)} |\n`);
            }
            // 2. Available tools
            if (parts.availableTools !== undefined && parts.availableTools > 0) {
                const percent = totalTokens > 0 ? ((parts.availableTools / totalTokens) * 100).toFixed(1) : '0';
                md.appendMarkdown(`| **Available Tools** | ${percent}% | ${this.formatTokens(parts.availableTools)} |\n`);
            }
            // 3. Environment info
            if (parts.environment !== undefined && parts.environment > 0) {
                const percent = totalTokens > 0 ? ((parts.environment / totalTokens) * 100).toFixed(1) : '0';
                md.appendMarkdown(`| **Environment Info** | ${percent}% | ${this.formatTokens(parts.environment)} |\n`);
            }
            // 4. Compressed messages
            if (parts.autoCompressed !== undefined && parts.autoCompressed > 0) {
                const percent = totalTokens > 0 ? ((parts.autoCompressed / totalTokens) * 100).toFixed(1) : '0';
                md.appendMarkdown(`| **Compressed Messages** | ${percent}% | ${this.formatTokens(parts.autoCompressed)} |\n`);
            }
            // 5. History messages
            if (parts.historyMessages !== undefined && parts.historyMessages > 0) {
                const percent = totalTokens > 0 ? ((parts.historyMessages / totalTokens) * 100).toFixed(1) : '0';
                md.appendMarkdown(`| **History Messages** | ${percent}% | ${this.formatTokens(parts.historyMessages)} |\n`);
            }
            // 6. Thinking content
            if (parts.thinking !== undefined && parts.thinking > 0) {
                const percent = totalTokens > 0 ? ((parts.thinking / totalTokens) * 100).toFixed(1) : '0';
                md.appendMarkdown(`| **Thinking Content** | ${percent}% | ${this.formatTokens(parts.thinking)} |\n`);
            }
            // 7. Current round image attachments
            if (parts.currentRoundImages !== undefined && parts.currentRoundImages > 0) {
                const currentRoundImages = parts.currentRoundImages;
                const percent = totalTokens > 0 ? ((currentRoundImages / totalTokens) * 100).toFixed(1) : '0';
                md.appendMarkdown(`| **Current Round Images** | ${percent}% | ${this.formatTokens(currentRoundImages)} |\n`);
            }
            // 8. Current round session messages
            if (parts.currentRoundMessages !== undefined && parts.currentRoundMessages > 0) {
                const currentRoundMessages = parts.currentRoundMessages;
                const percent = totalTokens > 0 ? ((currentRoundMessages / totalTokens) * 100).toFixed(1) : '0';
                md.appendMarkdown(`| **Current Round Messages** | ${percent}% | ${this.formatTokens(currentRoundMessages)} |\n`);
            }
            md.appendMarkdown('\n');
        }

        md.appendMarkdown('\n---\n');
        md.appendMarkdown('💡 This data shows estimated values from the most recent request\n');

        return md;
    }

    /**
     * Check and display status
     * Token usage status bar is always displayed
     */
    async checkAndShowStatus(): Promise<void> {
        if (this.statusBarItem) {
            this.statusBarItem.show();
        }
    }

    /**
     * Update status based on token usage of each part
     * @param modelName Model name
     * @param maxInputTokens Maximum input token count
     * @param promptParts Token usage of each prompt part
     */
    updateWithPromptParts(modelName: string, maxInputTokens: number, promptParts: PromptPartTokens): void {
        // Use context as total token usage (includes all parts)
        const inputTokens = promptParts.context || 0;
        const remainingTokens = maxInputTokens - inputTokens;
        const percentage = (inputTokens / maxInputTokens) * 100;
        const data: ContextUsageData = {
            modelId: modelName,
            modelName,
            inputTokens,
            maxInputTokens,
            percentage,
            timestamp: Date.now(),
            promptParts,
            remainingTokens
        };
        this.updateContextUsage(data);
    }

    /**
     * Delayed update (not used, context usage is externally driven)
     */
    delayedUpdate(_delayMs?: number): void {
        // Context usage status bar does not need periodic updates
        // Data is externally driven via updateContextUsage()
    }

    /**
     * Dispose status bar
     */
    dispose(): void {
        this.statusBarItem?.dispose();
        StatusLogger.debug('[Context Window Usage StatusBar] Disposed');
    }
}

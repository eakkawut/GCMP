/*---------------------------------------------------------------------------------------------
 *  Token Usages View
 *  Token Usage Detailed View
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TokenUsagesManager } from '../../usages/usagesManager';
import { StatusLogger } from '../../utils/statusLogger';
import { UpdateDateDetailsMessage, UpdateDateListMessage } from './types';
import { getTodayDateString } from './utils';

/**
 * WebView Message Type Definitions
 */
type WebViewMessage =
    | { command: 'getInitialData' }
    | { command: 'refresh'; date?: string }
    | { command: 'selectDate'; date: string }
    | { command: 'openStorageDir' };

/**
 * Token Usage WebView View
 */
export class TokenUsagesView {
    private panel: vscode.WebviewPanel | undefined;
    private usagesManager: TokenUsagesManager;
    private updateDisposable: vscode.Disposable | undefined;
    private currentSelectedDate: string | undefined; // Currently viewed date
    private hasCheckedOutdatedStats: boolean = false; // Whether outdated stats have been checked

    constructor(private context: vscode.ExtensionContext) {
        this.usagesManager = TokenUsagesManager.instance;
    }

    /**
     * Show WebView
     */
    show(): void {
        // If panel already exists, just show it
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        // Reset check flag, check outdated stats each time opened
        this.hasCheckedOutdatedStats = false;

        // Get today's date as title
        const today = getTodayDateString();
        this.panel = vscode.window.createWebviewPanel(
            'ccmpTokenStats',
            `CCMP Token Consumption Statistics - ${today}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.updateView();

        // Listen for messages
        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            undefined,
            this.context.subscriptions
        );

        // Listen for stats update events, intelligently refresh view
        this.updateDisposable = this.usagesManager.onStatsUpdate(() => {
            if (this.panel) {
                this.smartRefresh();
            }
        });

        // Listen for close event
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.updateDisposable?.dispose();
            this.updateDisposable = undefined;
        });
    }

    /**
     * Update view content
     */
    private async updateView(selectedDate?: string): Promise<void> {
        if (!this.panel) {
            return;
        }

        try {
            // Check and regenerate outdated statistics (only executed on first open)
            if (!this.hasCheckedOutdatedStats) {
                await this.usagesManager.getFileLogger().regenerateOutdatedStats();
                this.hasCheckedOutdatedStats = true;
            }

            // Get all date summaries
            await this.usagesManager.getAllDateSummaries();

            // Determine date to display (default to today)
            const today = getTodayDateString();
            const displayDate = selectedDate || today;

            // Record currently viewed date
            this.currentSelectedDate = displayDate;

            this.panel.webview.html = this.getWebviewContent();
        } catch (err) {
            StatusLogger.error('[TokenUsagesView] Failed to update view:', err);
        }
    }

    /**
     * Smart refresh - always notify page update when data changes
     * - If viewing today: refresh entire details (including request records) + update date list
     * - If viewing other dates: only refresh left date list statistics
     */
    private async smartRefresh(): Promise<void> {
        if (!this.panel) {
            return;
        }

        const today = getTodayDateString();
        const isViewingToday = this.currentSelectedDate === today;

        StatusLogger.debug(
            `[TokenUsagesView] Smart refresh: viewing date=${this.currentSelectedDate}, today=${today}, viewing today=${isViewingToday}`
        );

        if (isViewingToday) {
            // Viewing today - refresh entire details (including request records) + update date list
            StatusLogger.debug('[TokenUsagesView] Refresh today details + date list');
            await this.updateDateDetails(today);
            await this.updateDateListOnly();
        } else {
            // Viewing other dates - only refresh date list statistics
            StatusLogger.debug('[TokenUsagesView] Only refresh date list');
            await this.updateDateListOnly();
        }
    }

    /**
     * Only update date list statistics, do not refresh right side details
     */
    private async updateDateListOnly(): Promise<void> {
        if (!this.panel) {
            return;
        }

        try {
            const dateSummaries = await this.usagesManager.getAllDateSummaries();
            const today = getTodayDateString();
            // Send raw data directly, let components handle formatting themselves
            this.panel.webview.postMessage({
                command: 'updateDateList',
                dateList: dateSummaries,
                selectedDate: this.currentSelectedDate || today,
                today
            } as UpdateDateListMessage);
        } catch (err) {
            StatusLogger.error('[TokenUsagesView] Failed to update date list:', err);
        }
    }

    /**
     * Send initial data to WebView
     */
    private async sendInitialData(): Promise<void> {
        if (!this.panel) {
            return;
        }

        try {
            const dateSummaries = await this.usagesManager.getAllDateSummaries();
            const today = getTodayDateString();
            const displayDate = today;

            // Get detailed data for selected date
            const dateStats = await this.usagesManager.getDateStatsFromFile(displayDate);
            const dateRecords = await this.usagesManager.getDateRecords(displayDate);

            // Convert providers to array, while adding providerKey field (because Object.values loses key)
            const providers = Object.entries(dateStats.providers).map(([key, value]) => ({
                ...value,
                providerKey: key
            }));

            // Update current state
            this.currentSelectedDate = displayDate;

            // Send date list (send raw data directly, full)
            this.panel.webview.postMessage({
                command: 'updateDateList',
                dateList: dateSummaries,
                selectedDate: displayDate,
                today
            } as UpdateDateListMessage);

            // Send date details (send raw data directly)
            this.panel.webview.postMessage({
                command: 'updateDateDetails',
                date: displayDate,
                isToday: displayDate === today,
                providers: providers,
                hourlyStats: dateStats.hourly || {},
                records: dateRecords // getDateRecords already returns extended records
            } as UpdateDateDetailsMessage);

            StatusLogger.debug('[TokenUsagesView] Initial data sent');
        } catch (err) {
            StatusLogger.error('[TokenUsagesView] Failed to send initial data:', err);
        }
    }

    /**
     * Handle messages from WebView
     */
    private async handleMessage(message: WebViewMessage): Promise<void> {
        switch (message.command) {
            case 'getInitialData':
                await this.sendInitialData();
                break;

            case 'refresh':
                await this.updateView(message.date);
                break;

            case 'selectDate':
                await this.updateDateDetails(message.date);
                break;

            case 'openStorageDir':
                await this.openStorageDir();
                break;
        }
    }

    /**
     * Update date details (dynamic update)
     */
    private async updateDateDetails(date: string): Promise<void> {
        try {
            const today = getTodayDateString();

            // Read directly from file, without using cache
            const dateStats = await this.usagesManager.getDateStatsFromFile(date);
            const dateRecords = await this.usagesManager.getDateRecords(date);

            // Convert providers to array, while adding providerKey field (because Object.values loses key)
            const providers = Object.entries(dateStats.providers).map(([key, value]) => ({
                ...value,
                providerKey: key
            }));

            // Update current state
            this.currentSelectedDate = date;

            // Update panel title
            if (this.panel) {
                this.panel.title = `CCMP Token Consumption Statistics - ${date}`;
            }

            // Send message to WebView to update details area
            if (this.panel) {
                this.panel.webview.postMessage({
                    command: 'updateDateDetails',
                    date,
                    isToday: date === today,
                    providers: providers,
                    hourlyStats: dateStats.hourly || {},
                    records: dateRecords // getDateRecords already returns extended records
                } as UpdateDateDetailsMessage);
            }

            StatusLogger.debug(`[TokenUsagesView] Date details updated: ${date}, record count=${dateRecords.length}`);
        } catch (err) {
            StatusLogger.error('[TokenUsagesView] Failed to update date details:', err);
        }
    }

    /**
     * Open storage directory
     */
    private async openStorageDir(): Promise<void> {
        try {
            const storageDir = this.usagesManager.getStorageDir();
            await vscode.env.openExternal(vscode.Uri.file(storageDir));
            StatusLogger.debug(`[TokenUsagesView] Storage directory opened: ${storageDir}`);
        } catch (err) {
            StatusLogger.error('[TokenUsagesView] Failed to open storage directory:', err);
            vscode.window.showErrorMessage('Failed to open storage directory');
        }
    }

    /**
     * Generate WebView HTML content
     */
    private getWebviewContent(): string {
        const cspSource = this.panel?.webview.cspSource || '';

        // Read compiled application JS file (already includes framework and application code)
        const usagesViewJsPath = path.join(this.context.extensionPath, 'dist', 'ui', 'usagesView.js');
        let usagesViewJs = '';
        try {
            usagesViewJs = fs.readFileSync(usagesViewJsPath, 'utf8');
        } catch (error) {
            StatusLogger.error('[TokenUsagesView] Failed to read usagesView.js:', error);
            usagesViewJs = '/* Error loading usagesView.js */';
        }

        const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>CCMP Token Consumption Statistics</title>
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'unsafe-inline' ${cspSource};" />
</head>
<body>
	<div id="app"></div>
	<script>
		// Inject VSCode API (must be before other scripts)
		const vscode = acquireVsCodeApi();
		window.vscode = vscode;

		// Load application (IIFE, already includes framework and application code)
		${usagesViewJs}
	</script>
</body>
</html>`;

        return htmlContent;
    }

    /**
     * Destroy view
     */
    dispose(): void {
        this.updateDisposable?.dispose();
        this.panel?.dispose();
    }
}

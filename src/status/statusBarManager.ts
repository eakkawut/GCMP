/*---------------------------------------------------------------------------------------------
 *  Status Bar Manager
 *  Global static manager, unified management of all status bar item lifecycle and operations
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StatusLogger } from '../utils/statusLogger';
import { MiniMaxStatusBar } from './minimaxStatusBar';
import { KimiStatusBar } from './kimiStatusBar';
import { DeepSeekStatusBar } from './deepseekStatusBar';
import { MoonshotStatusBar } from './moonshotStatusBar';
import { ZhipuStatusBar } from './zhipuStatusBar';
import { ChatGPTStatusBar } from './chatgptStatusBar';
import { CompatibleStatusBar } from './compatibleStatusBar';
import { ContextUsageStatusBar } from './contextUsageStatusBar';
import { TokenUsageStatusBar } from './tokenUsageStatusBar';

/**
 * Status bar item interface
 */
interface IStatusBar {
    initialize(context: vscode.ExtensionContext): Promise<void>;
    checkAndShowStatus(): Promise<void>;
    delayedUpdate(delayMs?: number): void;
    dispose(): void;
}
interface ICompatibleStatusBar extends IStatusBar {
    /** @deprecated Use delayedUpdate with providerId instead */
    delayedUpdate(delayMs?: number): void;
    delayedUpdate(providerId: string, delayMs?: number): void;
}

/**
 * Status bar manager
 * Global static class, unified management of all status bar item lifecycle and operations
 * All status bar instances are accessible as public members
 */
export class StatusBarManager {
    // ==================== Public status bar instances ====================
    /** MiniMax Coding Plan status bar */
    static minimax: IStatusBar | undefined;
    /** Kimi For Coding status bar */
    static kimi: IStatusBar | undefined;
    /** DeepSeek balance query status bar */
    static deepseek: IStatusBar | undefined;
    /** Moonshot balance query status bar */
    static moonshot: IStatusBar | undefined;
    /** ZhipuAI usage status bar */
    static zhipu: IStatusBar | undefined;
    /** Codex usage query status bar */
    static codex: IStatusBar | undefined;
    /** Compatible provider status bar */
    static compatible: ICompatibleStatusBar | undefined;
    /** Model context window usage status bar */
    static contextUsage: IStatusBar | undefined;
    /** Token usage statistics status bar */
    static tokenUsage: IStatusBar | undefined;

    // ==================== Private members ====================
    private static statusBars: Map<string, IStatusBar> = new Map<string, IStatusBar>();
    private static initialized = false;

    /**
     * Register all built-in status bars
     * Automatically create and register all status bar instances during initialization
     */
    private static registerBuiltInStatusBars(context: vscode.ExtensionContext): void {
        // Create and register MiniMax status bar
        const miniMaxStatusBar = new MiniMaxStatusBar();
        this.registerStatusBar('minimax', miniMaxStatusBar);

        // Create and register Zhipu status bar
        const zhipuStatusBar = new ZhipuStatusBar();
        this.registerStatusBar('zhipu', zhipuStatusBar);

        // Create and register Kimi status bar
        const kimiStatusBar = new KimiStatusBar();
        this.registerStatusBar('kimi', kimiStatusBar);

        // Create and register DeepSeek status bar
        const deepseekStatusBar = new DeepSeekStatusBar();
        this.registerStatusBar('deepseek', deepseekStatusBar);

        // Create and register Moonshot status bar
        const moonshotStatusBar = new MoonshotStatusBar();
        this.registerStatusBar('moonshot', moonshotStatusBar);

        // Create and register Codex status bar
        const chatgptStatusBar = new ChatGPTStatusBar();
        this.registerStatusBar('codex', chatgptStatusBar);

        // Create and register Compatible provider status bar
        const compatibleStatusBar = new CompatibleStatusBar();
        this.registerStatusBar('compatible', compatibleStatusBar);

        // Create and register Model context window usage status bar
        const contextUsageStatusBar = new ContextUsageStatusBar();
        this.registerStatusBar('contextUsage', contextUsageStatusBar);

        // Create and register Token usage statistics status bar
        const tokenUsageStatusBar = new TokenUsageStatusBar(context);
        this.registerStatusBar('tokenUsage', tokenUsageStatusBar);
    }

    /**
     * Register status bar item
     * Used to register all status bars during initialization
     * @param key Unique identifier for status bar item
     * @param statusBar Status bar item instance
     */
    static registerStatusBar(key: string, statusBar: IStatusBar): void {
        if (this.statusBars.has(key)) {
            StatusLogger.warn(`[StatusBarManager] Status bar item ${key} already exists, overriding registration`);
        }
        this.statusBars.set(key, statusBar);

        // Associate status bar instance with public members
        switch (key) {
            case 'minimax':
                this.minimax = statusBar;
                break;
            case 'zhipu':
                this.zhipu = statusBar;
                break;
            case 'kimi':
                this.kimi = statusBar;
                break;
            case 'deepseek':
                this.deepseek = statusBar;
                break;
            case 'moonshot':
                this.moonshot = statusBar;
                break;
            case 'codex':
                this.codex = statusBar;
                break;
            case 'compatible':
                this.compatible = statusBar as ICompatibleStatusBar;
                break;
            case 'contextUsage':
                this.contextUsage = statusBar;
                break;
            case 'tokenUsage':
                this.tokenUsage = statusBar;
                break;
            default:
                break;
        }
    }

    /**
     * Get specified status bar item
     * @param key Unique identifier for status bar item
     */
    static getStatusBar(key: 'compatible'): ICompatibleStatusBar | undefined;
    static getStatusBar(key: string): IStatusBar | undefined;
    static getStatusBar(key: string): IStatusBar | undefined {
        return this.statusBars.get(key);
    }

    /**
     * Initialize all registered status bar items
     * Batch load and initialize all status bars
     * @param context Extension context
     */
    static async initializeAll(context: vscode.ExtensionContext): Promise<void> {
        if (this.initialized) {
            StatusLogger.warn('[StatusBarManager] Status bar manager already initialized, skipping duplicate initialization');
            return;
        }

        // Step 1: Register all built-in status bars
        this.registerBuiltInStatusBars(context);

        StatusLogger.info(`[StatusBarManager] Starting to initialize ${this.statusBars.size} status bar items`);

        // Parallel initialization of all status bars, recording elapsed time for each
        const initPromises = Array.from(this.statusBars.entries()).map(async ([key, statusBar]) => {
            const startTime = Date.now();
            try {
                await statusBar.initialize(context);
                const duration = Date.now() - startTime;
                StatusLogger.debug(`[StatusBarManager] Status bar item ${key} initialization successful (elapsed: ${duration}ms)`);
            } catch (error) {
                const duration = Date.now() - startTime;
                StatusLogger.error(`[StatusBarManager] Status bar item ${key} initialization failed (elapsed: ${duration}ms)`, error);
            }
        });

        await Promise.all(initPromises);

        this.initialized = true;
        StatusLogger.info('[StatusBarManager] All status bar items initialization complete');
    }

    /**
     * Check and display specified status bar item
     * @param key Unique identifier for status bar item
     */
    static async checkAndShowStatus(key: string): Promise<void> {
        const statusBar = this.getStatusBar(key);
        if (statusBar) {
            try {
                await statusBar.checkAndShowStatus();
            } catch (error) {
                StatusLogger.error(`[StatusBarManager] Failed to check and display status bar ${key}`, error);
            }
        } else {
            StatusLogger.warn(`[StatusBarManager] Status bar item ${key} not found`);
        }
    }

    /**
     * Delayed update for specified status bar item
     * @param key Unique identifier for status bar item
     * @param delayMs Delay time (milliseconds)
     */
    static delayedUpdate(key: string, delayMs?: number): void {
        const statusBar = this.getStatusBar(key);
        if (statusBar) {
            statusBar.delayedUpdate(delayMs);
        } else {
            StatusLogger.warn(`[StatusBarManager] Status bar item ${key} not found`);
        }
    }

    /**
     * Destroy all status bar items
     */
    static disposeAll(): void {
        for (const [key, statusBar] of this.statusBars) {
            try {
                statusBar.dispose();
                StatusLogger.debug(`[StatusBarManager] Status bar item ${key} destroyed`);
            } catch (error) {
                StatusLogger.error(`[StatusBarManager] Failed to destroy status bar item ${key}`, error);
            }
        }
        this.statusBars.clear();
        this.initialized = false;

        // Clear public instance references
        this.minimax = undefined;
        this.zhipu = undefined;
        this.kimi = undefined;
        this.deepseek = undefined;
        this.moonshot = undefined;
        this.codex = undefined;
        this.compatible = undefined;
        this.contextUsage = undefined;
        this.tokenUsage = undefined;
    }

    /**
     * Get list of all registered status bar items
     */
    static getRegisteredKeys(): string[] {
        return Array.from(this.statusBars.keys());
    }

    /**
     * Get initialization status
     */
    static isInitialized(): boolean {
        return this.initialized;
    }
}

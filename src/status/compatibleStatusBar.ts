/*---------------------------------------------------------------------------------------------
 *  Compatible Provider Status Bar Item
 *  Extends BaseStatusBarItem, reuses common status bar logic
 *  This status bar manages multiple built-in vendor queries, each provider cache is independent
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BaseStatusBarItem, BaseStatusBarItemConfig } from './baseStatusBarItem';
import { StatusLogger } from '../utils/statusLogger';
import { CompatibleModelManager } from '../utils/compatibleModelManager';
import { BalanceQueryManager } from './compatible/balanceQueryManager';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { KnownProviders } from '../utils/knownProviders';

/**
 * Compatible provider balance information
 */
export interface CompatibleProviderBalance {
    /** Provider identifier */
    providerId: string;
    /** Provider display name */
    providerName: string;
    /** Paid balance */
    paid?: number;
    /** Granted balance */
    granted?: number;
    /** Available balance */
    balance: number;
    /** Currency symbol */
    currency: string;
    /** Last update time */
    lastUpdated: Date;
    /** Whether query was successful */
    success: boolean;
    /** Error message (if query failed) */
    error?: string;
}

/**
 * Compatible status bar data
 */
export interface CompatibleStatusData {
    /** Balance information for all providers */
    providers: CompatibleProviderBalance[];
    /** Number of providers queried successfully */
    successCount: number;
    /** Total number of providers */
    totalCount: number;
}

/**
 * Cache data for a single provider
 */
interface ProviderCacheData {
    /** Provider balance information */
    balance: CompatibleProviderBalance;
    /** Cache timestamp */
    timestamp: number;
}

/**
 * Compatible provider status bar item
 * Displays balance information for multiple compatible providers, including:
 * - Each provider's balance
 * - Total balance (same currency accumulated)
 * - Query status
 *
 * Extends BaseStatusBarItem, reusing common status bar logic:
 * - Lifecycle management
 * - Refresh mechanism
 * - Cache management
 * - Debounce logic
 *
 * Special logic:
 * - Manages queries for multiple built-in vendors
 * - Each provider cache is independent
 */
export class CompatibleStatusBar extends BaseStatusBarItem<CompatibleStatusData> {
    /** Independent cache for each provider */
    private providerCaches = new Map<string, ProviderCacheData>();

    /** Last delayed update timestamp for each provider */
    private providerLastDelayedUpdateTimes = new Map<string, number>();

    /** List of providers supporting delayed update */
    private static readonly SUPPORTED_DELAYED_UPDATE_PROVIDERS = ['aihubmix', 'openrouter'];

    constructor() {
        const config: BaseStatusBarItemConfig = {
            id: 'ccmp.statusBar.compatible',
            name: 'CCMP: Compatible Balance',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 10, // Priority set to a low value, displayed on the right
            refreshCommand: 'ccmp.compatible.refreshBalance',
            cacheKeyPrefix: 'compatible',
            logPrefix: 'Compatible StatusBar',
            icon: '$(ccmp-compatible)'
        };
        super(config);
    }

    // ==================== Implement base class abstract methods ====================

    /**
     * Check if status bar should be displayed
     * Determined by checking if there are configured compatible providers with API Key
     * Check one by one, return true immediately when first valid API Key is found
     */
    protected async shouldShowStatusBar(): Promise<boolean> {
        const models = CompatibleModelManager.getModels();
        const supportedProviders = new Set(BalanceQueryManager.getRegisteredProviders());

        // Collect all providers that need to be checked (deduplicated)
        const providersToCheck = new Set<string>();
        for (const model of models) {
            if (model.provider && supportedProviders.has(model.provider)) {
                providersToCheck.add(model.provider);
            }
        }

        if (providersToCheck.size === 0) {
            return false;
        }

        // Check each provider's API Key one by one, return true immediately when first valid one is found
        for (const provider of providersToCheck) {
            const hasApiKey = await ApiKeyManager.hasValidApiKey(provider);
            if (hasApiKey) {
                return true;
            }
        }

        return false;
    }

    /**
     * Get display text
     */
    protected getDisplayText(data: CompatibleStatusData): string {
        const { successCount, totalCount, providers } = data;
        if (successCount === 0) {
            return `${this.config.icon} Compatible`;
        }

        // Only show amounts for successful providers
        const balanceTexts: string[] = [];
        const successfulProviders = providers.filter(p => p.success);
        const sortedProviders = successfulProviders.sort((a, b) => a.providerId.localeCompare(b.providerId));

        for (const provider of sortedProviders) {
            if (provider.balance === Number.MAX_SAFE_INTEGER) {
                // balanceTexts.push('∞');
                continue;
            }
            if (provider.balance === Number.MIN_SAFE_INTEGER) {
                balanceTexts.push('Depleted');
                continue;
            }
            // Default currency is CNY unless explicitly specified as USD
            const currencySymbol = provider.currency === 'USD' ? '$' : '¥';
            balanceTexts.push(`${currencySymbol}${provider.balance.toFixed(2)}`);
        }

        const balanceText = balanceTexts.join(' ');
        if (successCount === totalCount) {
            return `${this.config.icon} ${balanceText}`;
        }
        return `${this.config.icon} (${successCount}/${totalCount}) | ${balanceText}`;
    }

    /**
     * Generate tooltip content
     */
    protected generateTooltip(data: CompatibleStatusData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        md.appendMarkdown('#### Compatible Provider Balance Information\n\n');

        if (data.providers.length === 0) {
            md.appendMarkdown('No Compatible providers configured\n');
            md.appendMarkdown('\n---\n');
            md.appendMarkdown('Click status bar to manually refresh\n');
            return md;
        }

        md.appendMarkdown('| Provider | Paid Balance | Granted Balance | Available Balance |\n');
        md.appendMarkdown('| :--- |---: | ---: | ---: |\n');

        const sortedProviders = [...data.providers].sort((a, b) => a.providerId.localeCompare(b.providerId));
        for (const provider of sortedProviders) {
            if (provider.success) {
                const currencySymbol = provider.currency === 'USD' ? '$' : '¥';
                const paidBalance = provider.paid !== undefined ? `${currencySymbol}${provider.paid.toFixed(2)}` : '-';
                const grantedBalance =
                    provider.granted !== undefined ? `${currencySymbol}${provider.granted.toFixed(2)}` : '-';
                let availableBalance = `${currencySymbol}${provider.balance.toFixed(2)}`;
                if (provider.balance === Number.MAX_SAFE_INTEGER) {
                    availableBalance = 'Unlimited';
                } else if (provider.balance === Number.MIN_SAFE_INTEGER) {
                    availableBalance = 'Depleted';
                }

                md.appendMarkdown(
                    `| ${provider.providerName} | ${paidBalance} | ${grantedBalance} | ${availableBalance} |\n`
                );
            } else {
                md.appendMarkdown(`| ${provider.providerName} |  - | - | Query Failed |\n`);
            }
        }

        md.appendMarkdown('\n---\n');
        md.appendMarkdown('Click status bar to manually refresh\n');
        return md;
    }

    /**
     * Execute API query
     * Query balance information for all compatible providers
     * Use each provider's independent cache, only query providers with expired cache
     * When manually refreshing, force query all providers, ignore cache
     * Only query providers that have API Key set
     */
    protected async performApiQuery(
        isManualRefresh = false
    ): Promise<{ success: boolean; data?: CompatibleStatusData; error?: string }> {
        try {
            const models = CompatibleModelManager.getModels();
            const supportedProviders = new Set(BalanceQueryManager.getRegisteredProviders());
            const providerMap = new Map<string, CompatibleProviderBalance>();

            // Group models by provider, only process supported providers
            for (const model of models) {
                if (!model.provider || !supportedProviders.has(model.provider)) {
                    continue;
                }

                // Check if provider has valid API Key, skip if not
                const hasApiKey = await ApiKeyManager.hasValidApiKey(model.provider);
                if (!hasApiKey) {
                    StatusLogger.debug(`[${this.config.logPrefix}] Skipping provider without API Key configured: ${model.provider}`);
                    continue;
                }

                if (!providerMap.has(model.provider)) {
                    const knownProvider = KnownProviders[model.provider];

                    // When manually refreshing, force query all providers, ignore cache
                    if (isManualRefresh) {
                        providerMap.set(model.provider, {
                            providerId: model.provider,
                            providerName: knownProvider?.displayName || model.provider,
                            balance: 0,
                            currency: 'CNY', // Default currency
                            lastUpdated: new Date(),
                            success: false
                        });
                    } else {
                        // When auto-refreshing, first try loading from independent cache
                        const cachedProvider = this.providerCaches.get(model.provider);
                        if (cachedProvider && !this.isProviderCacheExpired(model.provider)) {
                            // Use cached data
                            providerMap.set(model.provider, cachedProvider.balance);
                        } else {
                            // Provider that needs to be queried
                            providerMap.set(model.provider, {
                                providerId: model.provider,
                                providerName: knownProvider?.displayName || model.provider,
                                balance: 0,
                                currency: 'CNY', // Default currency
                                lastUpdated: new Date(),
                                success: false
                            });
                        }
                    }
                }
            }

            // Find providers that need to be queried
            const providersToQuery = Array.from(providerMap.values()).filter(
                provider =>
                    !provider.success || (isManualRefresh ? true : this.isProviderCacheExpired(provider.providerId))
            );

            StatusLogger.debug(
                `[${this.config.logPrefix}] ${isManualRefresh ? 'Manual refresh' : 'Auto refresh'}: ${providersToQuery.length}/${providerMap.size} providers need to be queried`
            );

            // Parallel query providers that need to be updated
            const queryPromises = providersToQuery.map(async provider => {
                try {
                    // Use balance query manager to query balance
                    const balanceInfo = await BalanceQueryManager.queryBalance(provider.providerId);

                    provider.paid = balanceInfo.paid;
                    provider.granted = balanceInfo.granted;
                    provider.balance = balanceInfo.balance;
                    provider.currency = balanceInfo.currency;
                    provider.lastUpdated = new Date();
                    provider.success = true;

                    // Save to independent cache
                    await this.saveProviderCache(provider.providerId, provider);
                } catch (error) {
                    StatusLogger.error(`[${this.config.logPrefix}] Failed to query provider ${provider.providerId} balance`, error);
                    provider.error = typeof error === 'string' ? error : 'Query failed';
                    provider.success = false;
                }
            });

            await Promise.all(queryPromises);

            const successCount = Array.from(providerMap.values()).filter(p => p.success).length;

            const statusData: CompatibleStatusData = {
                providers: Array.from(providerMap.values()),
                successCount,
                totalCount: providerMap.size
            };

            return { success: true, data: statusData };
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] Failed to query compatible provider balance`, error);
            return { success: false, error: typeof error === 'string' ? error : 'Query failed' };
        }
    }

    /**
     * Check if highlight warning is needed
     * Highlight warning if any provider query fails
     */
    protected shouldHighlightWarning(data: CompatibleStatusData): boolean {
        return data.successCount < data.totalCount;
    }

    /**
     * Check if refresh is needed
     * Check if any provider's cache has expired
     */
    protected shouldRefresh(): boolean {
        // Check if overall cache exists
        if (!this.lastStatusData) {
            return true;
        }

        // Check if any provider cache has expired
        const models = CompatibleModelManager.getModels();
        const providerIds = new Set<string>();
        for (const model of models) {
            if (model.provider) {
                providerIds.add(model.provider);
            }
        }

        for (const providerId of providerIds) {
            if (this.isProviderCacheExpired(providerId)) {
                StatusLogger.debug(`[${this.config.logPrefix}] Cache time exceeds 5-minute fixed expiry time, triggering API refresh`);
                return true;
            }
        }

        return false;
    }

    // ==================== Override base class hook methods ====================

    /**
     * Post-initialization hook
     * Load provider caches and listen for model change events
     */
    protected override async onInitialized(): Promise<void> {
        // Load independent caches for each provider
        this.loadProviderCaches();

        // Listen for compatible model change events
        if (this.context) {
            const disposable = CompatibleModelManager.onDidChangeModels(() => {
                StatusLogger.debug(`[${this.config.logPrefix}] Compatible model configuration changed, triggering status update`);
                this.delayedUpdate(1000); // Delay update by 1 second to avoid frequent calls
            });
            this.context.subscriptions.push(disposable);
        }
    }

    /**
     * Pre-disposal hook
     * Clean up provider caches
     */
    protected override async onDispose(): Promise<void> {
        this.providerCaches.clear();
        this.providerLastDelayedUpdateTimes.clear();
    }

    // ==================== Override base class methods ====================

    /**
     * Delayed update for specified provider's balance (overload base class method)
     * Includes debounce mechanism to avoid frequent requests
     * @param providerId Provider identifier
     * @param delayMs Delay time (milliseconds)
     */
    override delayedUpdate(delayMs?: number): void;
    override delayedUpdate(providerId: string, delayMs?: number): void;
    override delayedUpdate(providerId?: string | number, delayMs = 2000): void {
        // If providerId is not provided or providerId is not a string, call base class implementation
        if (!providerId || typeof providerId !== 'string') {
            super.delayedUpdate(typeof providerId === 'number' ? providerId : delayMs);
            return;
        }

        // Check if provider is in supported list
        const supportedProviders = new Set(BalanceQueryManager.getRegisteredProviders());
        if (!CompatibleStatusBar.SUPPORTED_DELAYED_UPDATE_PROVIDERS.includes(providerId)) {
            // Only output this log for providers known to support querying
            if (supportedProviders.has(providerId)) {
                StatusLogger.debug(
                    `[${this.config.logPrefix}] Provider ${providerId} does not need delayed update, managed by timer for unified refresh`
                );
            }
            return;
        }

        // Clear previous debounce timer
        if (this.updateDebouncer) {
            clearTimeout(this.updateDebouncer);
        }

        const now = Date.now();
        const lastUpdateTime = this.providerLastDelayedUpdateTimes.get(providerId) || 0;
        const timeSinceLastUpdate = now - lastUpdateTime;

        // If time since last update is less than threshold, wait until threshold is met before executing
        const finalDelayMs =
            timeSinceLastUpdate < this.MIN_DELAYED_UPDATE_INTERVAL
                ? this.MIN_DELAYED_UPDATE_INTERVAL - timeSinceLastUpdate
                : delayMs;

        StatusLogger.debug(
            `[${this.config.logPrefix}] Setting delayed update for provider ${providerId}, will execute in ${finalDelayMs / 1000} seconds`
        );

        // Set new debounce timer
        this.updateDebouncer = setTimeout(async () => {
            try {
                StatusLogger.debug(`[${this.config.logPrefix}] Executing delayed update for provider ${providerId}`);
                this.providerLastDelayedUpdateTimes.set(providerId, Date.now());
                await this.performProviderUpdate(providerId);
            } catch (error) {
                StatusLogger.error(`[${this.config.logPrefix}] Failed to delayed update provider ${providerId}`, error);
            } finally {
                this.updateDebouncer = undefined;
            }
        }, finalDelayMs);
    }

    /**
     * Override base class executeApiQuery method
     * Always execute query when manually refreshing, not subject to base class cache limits
     * When some provider queries fail, do not display ERR, only show successful provider information
     */
    protected override async executeApiQuery(isManualRefresh = false): Promise<void> {
        // Prevent concurrent execution
        if (this.isLoading) {
            StatusLogger.debug(`[${this.config.logPrefix}] Query in progress, skipping duplicate call`);
            return;
        }

        // When manually refreshing, skip base class cache check and execute query directly
        if (isManualRefresh) {
            StatusLogger.debug(`[${this.config.logPrefix}] Manual refresh, skipping cache check`);
        } else {
            // When auto-refreshing, check if cache is valid within 5 seconds, skip if valid
            if (this.lastStatusData) {
                try {
                    const dataAge = Date.now() - this.lastStatusData.timestamp;
                    if (dataAge >= 0 && dataAge < 5000) {
                        StatusLogger.debug(
                            `[${this.config.logPrefix}] Data is valid within 5 seconds (${(dataAge / 1000).toFixed(1)}s ago), skipping this auto refresh`
                        );
                        return;
                    }
                } catch {
                    // Old version data format incompatible, ignore error and continue refresh
                    StatusLogger.debug(`[${this.config.logPrefix}] Cache data format incompatible, continuing refresh`);
                }
            }
        }

        this.isLoading = true;

        try {
            StatusLogger.debug(`[${this.config.logPrefix}] Starting balance query...`);

            const result = await this.performApiQuery(isManualRefresh);

            if (result.success && result.data) {
                if (this.statusBarItem) {
                    const data = result.data;

                    // Check if there are any query results
                    if (data.providers.length === 0) {
                        // No providers can be queried, hide status bar
                        this.statusBarItem.hide();
                        StatusLogger.debug(`[${this.config.logPrefix}] No providers supporting query, hiding status bar`);
                        return;
                    }

                    // Check if there are successful query results
                    if (data.successCount === 0) {
                        // All providers query failed, display ERR
                        this.statusBarItem.text = `${this.config.icon} ERR`;
                        this.statusBarItem.tooltip = 'All provider queries failed';
                        StatusLogger.warn(`[${this.config.logPrefix}] All provider queries failed`);
                        return;
                    }

                    // Save complete status data
                    this.lastStatusData = {
                        data: data,
                        timestamp: Date.now()
                    };

                    // Save to global state
                    if (this.context) {
                        this.context.globalState.update(this.getCacheKey('statusData'), this.lastStatusData);
                    }

                    // Update status bar UI
                    this.updateStatusBarUI(data);

                    StatusLogger.info(
                        `[${this.config.logPrefix}] Balance check successful (${data.successCount}/${data.totalCount})`
                    );
                }
            } else {
                // Query completely failed, display ERR
                const errorMsg = result.error || 'Unknown error';
                if (this.statusBarItem) {
                    this.statusBarItem.text = `${this.config.icon} ERR`;
                    this.statusBarItem.tooltip = `Query failed: ${errorMsg}`;
                }
                StatusLogger.warn(`[${this.config.logPrefix}] Balance query failed: ${errorMsg}`);
            }
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] Failed to update status bar`, error);

            // Query exception, display ERR
            if (this.statusBarItem) {
                this.statusBarItem.text = `${this.config.icon} ERR`;
                this.statusBarItem.tooltip = `Failed to get: ${error instanceof Error ? error.message : 'Unknown error'}`;
            }
        } finally {
            // Must reset loading state at the end
            this.isLoading = false;
        }
    }

    // ==================== Private methods: Provider cache management ====================

    /**
     * Get provider independent cache key name
     */
    private getProviderCacheKey(providerId: string): string {
        return `${this.config.cacheKeyPrefix}.provider.${providerId}`;
    }

    /**
     * Load independent caches for each provider
     */
    private loadProviderCaches(): void {
        if (!this.context) {
            return;
        }

        try {
            const registeredProviders = BalanceQueryManager.getRegisteredProviders();

            for (const providerId of registeredProviders) {
                const cacheKey = this.getProviderCacheKey(providerId);
                const cached = this.context.globalState.get<ProviderCacheData>(cacheKey);
                if (cached) {
                    // Use cached data directly, no need to fix Date object serialization issue
                    this.providerCaches.set(providerId, cached);
                }
            }

            StatusLogger.debug(`[${this.config.logPrefix}] Loaded ${this.providerCaches.size} provider caches`);
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] Failed to load provider cache`, error);
        }
    }

    /**
     * Save provider independent cache
     */
    private async saveProviderCache(providerId: string, balance: CompatibleProviderBalance): Promise<void> {
        if (!this.context) {
            return;
        }

        try {
            const cacheData: ProviderCacheData = {
                balance,
                timestamp: Date.now()
            };

            this.providerCaches.set(providerId, cacheData);

            const cacheKey = this.getProviderCacheKey(providerId);
            await this.context.globalState.update(cacheKey, cacheData);

            StatusLogger.debug(`[${this.config.logPrefix}] Saved provider ${providerId} cache`);
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] Failed to save provider ${providerId} cache`, error);
        }
    }

    /**
     * Check if provider cache has expired
     */
    private isProviderCacheExpired(providerId: string): boolean {
        const cached = this.providerCaches.get(providerId);
        if (!cached) {
            return true;
        }

        const PROVIDER_CACHE_EXPIRY = (5 * 60 - 10) * 1000; // Cache expiry threshold 5 minutes

        const now = Date.now();
        const cacheAge = now - cached.timestamp;
        return cacheAge > PROVIDER_CACHE_EXPIRY;
    }

    // ==================== Private methods: Single provider update ====================

    /**
     * Execute single provider balance query and update status bar
     * @param providerId Provider identifier
     */
    private async performProviderUpdate(providerId: string): Promise<void> {
        // Prevent concurrent execution
        if (this.isLoading) {
            StatusLogger.debug(`[${this.config.logPrefix}] Query in progress, skipping update for provider ${providerId}`);
            return;
        }

        // Check if provider is supported
        const supportedProviders = new Set(BalanceQueryManager.getRegisteredProviders());
        if (!supportedProviders.has(providerId)) {
            StatusLogger.warn(`[${this.config.logPrefix}] Provider ${providerId} does not support balance query`);
            return;
        }

        this.isLoading = true;

        try {
            StatusLogger.debug(`[${this.config.logPrefix}] Starting to query provider ${providerId} balance...`);

            // Get provider information
            const knownProvider = KnownProviders[providerId];
            const providerName = knownProvider?.displayName || providerId;

            // Create provider balance information object
            const providerBalance: CompatibleProviderBalance = {
                providerId,
                providerName,
                balance: 0,
                currency: 'CNY', // Default currency
                lastUpdated: new Date(),
                success: false
            };

            // Query balance
            try {
                const balanceInfo = await BalanceQueryManager.queryBalance(providerId);

                providerBalance.paid = balanceInfo.paid;
                providerBalance.granted = balanceInfo.granted;
                providerBalance.balance = balanceInfo.balance;
                providerBalance.currency = balanceInfo.currency;
                providerBalance.lastUpdated = new Date();
                providerBalance.success = true;

                // Save to independent cache
                await this.saveProviderCache(providerId, providerBalance);

                StatusLogger.info(`[${this.config.logPrefix}] Provider ${providerId} balance query successful`);
            } catch (error) {
                StatusLogger.error(`[${this.config.logPrefix}] Failed to query provider ${providerId} balance`, error);
                providerBalance.error = typeof error === 'string' ? error : 'Query failed';
                providerBalance.success = false;
            }

            // Update status data
            if (this.lastStatusData && this.lastStatusData.data) {
                // Find and update existing provider data
                const existingProviderIndex = this.lastStatusData.data.providers.findIndex(
                    p => p.providerId === providerId
                );

                if (existingProviderIndex >= 0) {
                    // Update existing provider
                    this.lastStatusData.data.providers[existingProviderIndex] = providerBalance;
                } else {
                    // Add new provider
                    this.lastStatusData.data.providers.push(providerBalance);
                    this.lastStatusData.data.totalCount++;
                }

                // Update success count
                this.lastStatusData.data.successCount = this.lastStatusData.data.providers.filter(
                    p => p.success
                ).length;

                // Update timestamp
                this.lastStatusData.timestamp = Date.now();

                // Save to global state
                if (this.context) {
                    this.context.globalState.update(this.getCacheKey('statusData'), this.lastStatusData);
                }

                // Update status bar UI
                this.updateStatusBarUI(this.lastStatusData.data);
            } else {
                // If no existing data, execute checkAndShowStatus for complete update
                await this.checkAndShowStatus();
            }
        } catch (error) {
            StatusLogger.error(`[${this.config.logPrefix}] Failed to update provider ${providerId} balance`, error);
        } finally {
            // Must reset loading state at the end
            this.isLoading = false;
        }
    }
}

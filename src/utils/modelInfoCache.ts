/*---------------------------------------------------------------------------------------------
 *  Model Info Cache Manager
 *  Provides persistent caching for model information, accelerating model selector display during extension activation
 *  Reference: Microsoft vscode-copilot-chat LanguageModelAccessPromptBaseCountCache
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { LanguageModelChatInformation } from 'vscode';
import { Logger } from './logger';
import { configProviders } from '../providers/config';

/**
 * Saved model selection information
 */
interface SavedModelSelection {
    /** Provider identifier */
    providerKey: string;
    /** Model ID */
    modelId: string;
    /** Save timestamp */
    timestamp: number;
}

/**
 * Cached model info structure
 */
interface CachedModelInfo {
    /** Model info list */
    models: LanguageModelChatInformation[];
    /** Extension version when cached (used for version check invalidation) */
    extensionVersion: string;
    /** Cache creation timestamp */
    timestamp: number;
    /** API key hash (used for key change check) */
    apiKeyHash: string;
}

/**
 * Model Info Cache Manager
 *
 * Uses VS Code globalState for persistent caching, supporting:
 * - Cross-activation session cache persistence
 * - Automatic version check invalidation
 * - API key change detection
 * - 24-hour time expiry
 * - Global model selection persistence (saves user's last selected model, across all providers)
 */
export class ModelInfoCache {
    private readonly context: vscode.ExtensionContext;
    private readonly cacheVersion = '1';
    private readonly cacheExpiryMs = 24 * 60 * 60 * 1000; // 24 hours
    private static readonly SELECTED_MODEL_KEY = 'ccmp_selected_model'; // Global model selection storage key

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * Get cached model info
     *
     * Quickly check if cache is valid. Checks:
     * - Cache existence
     * - Extension version match
     * - API key hash match
     * - Cache time not expired
     *
     * @param providerKey Provider identifier (e.g., 'zhipu', 'kimi')
     * @param apiKeyHash Hash of API key
     * @returns Valid model info list, or null (indicating cache is invalid or doesn't exist)
     */
    async getCachedModels(providerKey: string, apiKeyHash: string): Promise<LanguageModelChatInformation[] | null> {
        try {
            // In development mode, always return null to force re-fetching model list
            const isDevelopment = this.context.extensionMode === vscode.ExtensionMode.Development;
            if (isDevelopment) {
                Logger.trace(`[ModelInfoCache] ${providerKey}: Skipping cache in development mode`);
                return null;
            }

            const cacheKey = this.getCacheKey(providerKey);
            const cached = this.context.globalState.get<CachedModelInfo>(cacheKey);

            if (!cached) {
                Logger.trace(`[ModelInfoCache] ${providerKey}: No cache`);
                return null;
            }

            // Check 1: Version match
            const currentVersion = vscode.extensions.getExtension('guokoko.ccmp')?.packageJSON.version || '';
            if (cached.extensionVersion !== currentVersion) {
                Logger.trace(
                    `[ModelInfoCache] ${providerKey}: Version mismatch ` +
                    `(cached: ${cached.extensionVersion}, current: ${currentVersion})`
                );
                return null;
            }

            // Check 2: API key match
            if (cached.apiKeyHash !== apiKeyHash) {
                Logger.trace(`[ModelInfoCache] ${providerKey}: API key has changed`);
                return null;
            }

            // Check 3: Time not expired
            const now = Date.now();
            const ageMs = now - cached.timestamp;
            if (ageMs > this.cacheExpiryMs) {
                const ageHours = (ageMs / (60 * 60 * 1000)).toFixed(1);
                Logger.trace(`[ModelInfoCache] ${providerKey}: Cache expired ` + `(${ageHours} hours ago)`);
                return null;
            }

            Logger.trace(
                `[ModelInfoCache] ${providerKey}: Cache hit ` +
                `(${cached.models.length} models, alive ${(ageMs / 1000).toFixed(1)}s)`
            );
            return cached.models;
        } catch (err) {
            // Cache read errors should not affect extension operation
            Logger.warn(
                `[ModelInfoCache] Failed to read ${providerKey} cache:`,
                err instanceof Error ? err.message : String(err)
            );
            return null;
        }
    }

    /**
     * Cache model info
     *
     * Asynchronously store model info to globalState. This operation should not block return flow.
     *
     * @param providerKey Provider identifier
     * @param models Model info list to cache
     * @param apiKeyHash Hash of API key
     */
    async cacheModels(providerKey: string, models: LanguageModelChatInformation[], apiKeyHash: string): Promise<void> {
        try {
            const currentVersion = vscode.extensions.getExtension('guokoko.ccmp')?.packageJSON.version || '';

            const cacheData: CachedModelInfo = {
                models,
                extensionVersion: currentVersion,
                timestamp: Date.now(),
                apiKeyHash
            };

            const cacheKey = this.getCacheKey(providerKey);
            await this.context.globalState.update(cacheKey, cacheData);

            Logger.trace(`[ModelInfoCache] ${providerKey}: Cache saved ` + `(${models.length} models)`);
        } catch (err) {
            // Cache failure should not block extension
            Logger.warn(`[ModelInfoCache] Failed to cache ${providerKey}:`, err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * Invalidate cache for specific provider
     *
     * Called in the following situations:
     * - API key change (ApiKeyManager.setApiKey)
     * - Provider config change (onDidChangeConfiguration)
     * - User manually clears cache
     *
     * @param providerKey Provider identifier
     */
    async invalidateCache(providerKey: string): Promise<void> {
        try {
            const cacheKey = this.getCacheKey(providerKey);
            await this.context.globalState.update(cacheKey, undefined);
            Logger.trace(`[ModelInfoCache] ${providerKey}: Cache cleared`);
        } catch (err) {
            Logger.warn(
                `[ModelInfoCache] Failed to clear ${providerKey} cache:`,
                err instanceof Error ? err.message : String(err)
            );
        }
    }

    /**
     * Clear all cache
     *
     * Called when extension is uninstalled or user requests
     */
    async clearAll(): Promise<void> {
        // Dynamically get all provider keys from config file, then add 'compatible'
        const allProviderKeys = [...Object.keys(configProviders), 'compatible'];

        let clearedCount = 0;
        for (const key of allProviderKeys) {
            try {
                await this.invalidateCache(key);
                clearedCount++;
            } catch (err) {
                // Continue clearing other caches, don't interrupt flow
                Logger.warn(
                    `[ModelInfoCache] Error clearing ${key} cache:`,
                    err instanceof Error ? err.message : String(err)
                );
            }
        }

        Logger.info(`[ModelInfoCache] All caches cleared (${clearedCount}/${allProviderKeys.length})`);
    }

    /**
     * Compute hash of API key
     *
     * Uses SHA-256 hash and takes only first 16 characters to avoid storing full key in cache
     *
     * @param apiKey API key
     * @returns First 16 characters of key hash
     */
    static async computeApiKeyHash(apiKey: string): Promise<string> {
        try {
            const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
            return hash.substring(0, 16);
        } catch (err) {
            Logger.warn('Failed to compute API key hash:', err instanceof Error ? err.message : String(err));
            // If hash fails, return fixed value (at this point key change verification will not work)
            return 'hash-error';
        }
    }

    /**
     * Get cache storage key
     *
     * Format: ccmp_modelinfo_cache_<version>_<providerKey>
     * This way different version caches won't conflict
     */
    private getCacheKey(providerKey: string): string {
        return `ccmp_modelinfo_cache_${this.cacheVersion}_${providerKey}`;
    }

    /**
     * Save user selected model (global save of provider+model pair)
     *
     * Reference: Microsoft vscode-copilot-chat COPILOT_CLI_MODEL_MEMENTO_KEY
     * Saves user's last selected model and its provider, so we can distinguish same-named models from different providers
     *
     * @param providerKey Provider identifier
     * @param modelId Model ID
     */
    async saveLastSelectedModel(providerKey: string, modelId: string): Promise<void> {
        try {
            const selection: SavedModelSelection = {
                providerKey,
                modelId,
                timestamp: Date.now()
            };
            await this.context.globalState.update(ModelInfoCache.SELECTED_MODEL_KEY, selection);
            Logger.trace(`[ModelInfoCache] Saved default model selection (${providerKey}: ${modelId})`);
        } catch (err) {
            Logger.warn('[ModelInfoCache] Failed to save model selection:', err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * Get user's last selected model (global query)
     * Only returns saved model matching current provider
     *
     * @param providerKey Current provider identifier
     * @returns If last selected provider matches current, returns model ID; otherwise returns null
     */
    getLastSelectedModel(providerKey: string): string | null {
        try {
            const saved = this.context.globalState.get<SavedModelSelection>(ModelInfoCache.SELECTED_MODEL_KEY);
            if (saved && saved.providerKey === providerKey) {
                Logger.trace(`[ModelInfoCache] ${providerKey}: Read default model (${saved.modelId})`);
                return saved.modelId;
            }
            if (saved) {
                Logger.trace(
                    `[ModelInfoCache] ${providerKey}: Skipping other providers' default selection (` +
                    `saved: ${saved.providerKey}/${saved.modelId})`
                );
            }
            return null;
        } catch (err) {
            Logger.warn('[ModelInfoCache] Failed to read model selection:', err instanceof Error ? err.message : String(err));
            return null;
        }
    }
}

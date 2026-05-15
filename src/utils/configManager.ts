/*---------------------------------------------------------------------------------------------
 *  Configuration Manager
 *  Manages global configuration settings and provider configurations for CCMP extension
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ConfigProvider, UserConfigOverrides, ProviderConfig, ModelConfig, ModelOverride } from '../types/sharedTypes';
import { configProviders } from '../providers/config';
import { CommitFormat, CommitLanguage, CommitModelSelection } from '../commit/types';

/**
 * ZhipuAI Search Configuration
 */
export interface ZhipuSearchConfig {
    /** Whether to enable SSE communication mode (only Pro+ plan supports) */
    enableMCP: boolean;
}

/**
 * ZhipuAI Unified Configuration
 */
export interface ZhipuConfig {
    /** Search feature configuration */
    search: ZhipuSearchConfig;
    /** Access endpoint */
    endpoint: 'open.bigmodel.cn' | 'api.z.ai';
}

/**
 * MiniMax Configuration
 */
export interface MiniMaxConfig {
    /** Coding Plan endpoint */
    endpoint: 'minimaxi.com' | 'minimax.io';
}

/**
 * Xiaomi MiMo Configuration
 */
export interface XiaomimimoConfig {
    /** Token Plan endpoint */
    endpoint: 'cn' | 'sgp' | 'ams';
}

/**
 * NES Completion Configuration
 */
export interface NESCompletionConfig {
    enabled: boolean;
    debounceMs: number;
    timeoutMs: number; // Request timeout
    manualOnly: boolean; // Manual trigger only mode
    modelConfig: {
        provider: string;
        baseUrl: string;
        model: string;
        maxTokens: number;
        extraBody?: Record<string, unknown>;
    };
}
export type FIMCompletionConfig = Omit<NESCompletionConfig, 'manualOnly'>;

/**
 * Request Retry Configuration
 */
export interface RequestRetryConfig {
    maxAttempts: number;
}

/**
 * Commit Configuration
 */
export interface CommitConfig {
    language: CommitLanguage;
    format: CommitFormat;
    customInstructions: string;
    model?: CommitModelSelection;
}

/**
 * CCMP Configuration Interface
 */
export interface CCMPConfig {
    /** Maximum output token count */
    maxTokens: number;
    /** Request failure retry configuration */
    retry: RequestRetryConfig;
    /** Automatically add provider prefix to model ID */
    autoPrefixModelId: boolean;
    /** ZhipuAI configuration */
    zhipu: ZhipuConfig;
    /** MiniMax configuration */
    minimax: MiniMaxConfig;
    /** Xiaomi MiMo configuration */
    xiaomimimo: XiaomimimoConfig;
    /** FIM completion configuration */
    fimCompletion: FIMCompletionConfig;
    /** NES completion configuration */
    nesCompletion: NESCompletionConfig;
    /** Commit module configuration */
    commit: CommitConfig;
    /** Provider configuration overrides */
    providerOverrides: UserConfigOverrides;
}

/**
 * Configuration Manager Class
 * Responsible for reading and managing CCMP configuration in VS Code settings and provider configuration in package.json
 */
export class ConfigManager {
    private static readonly CONFIG_SECTION = 'ccmp';
    private static cache: CCMPConfig | null = null;
    private static configListener: vscode.Disposable | null = null;

    /**
     * Initialize configuration manager
     * Set up configuration change listener
     */
    static initialize(): vscode.Disposable {
        // Dispose previous listener
        if (this.configListener) {
            this.configListener.dispose();
        }

        // Set up configuration change listener
        this.configListener = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(this.CONFIG_SECTION)) {
                this.cache = null; // Clear cache, force reload
                Logger.info('CCMP configuration updated, cache cleared');
            }
        });

        Logger.debug('Configuration manager initialized');
        return this.configListener;
    }

    /**
     * Get current configuration
     * Uses caching mechanism for performance
     */
    static getConfig(): CCMPConfig {
        if (this.cache) {
            return this.cache;
        }

        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);

        this.cache = {
            maxTokens: this.validateMaxTokens(config.get<number>('maxTokens', 256000)),
            retry: {
                maxAttempts: this.validateRetryMaxAttempts(config.get<number>('retry.maxAttempts', 3))
            },
            autoPrefixModelId: config.get<boolean>('autoPrefixModelId', false),
            zhipu: {
                search: {
                    enableMCP: config.get<boolean>('zhipu.search.enableMCP', true) // Enable MCP mode by default (Coding Plan exclusive)
                },
                endpoint: config.get<ZhipuConfig['endpoint']>('zhipu.endpoint', 'open.bigmodel.cn')
            },
            minimax: {
                endpoint: config.get<MiniMaxConfig['endpoint']>('minimax.endpoint', 'minimaxi.com')
            },
            xiaomimimo: {
                endpoint: config.get<XiaomimimoConfig['endpoint']>('xiaomimimo.endpoint', 'cn')
            },
            fimCompletion: {
                enabled: config.get<boolean>('fimCompletion.enabled', false),
                debounceMs: this.validateNESDebounceMs(config.get<number>('fimCompletion.debounceMs', 500)),
                timeoutMs: this.validateNESTimeoutMs(config.get<number>('fimCompletion.timeoutMs', 5000)),
                modelConfig: {
                    provider: config.get<string>('fimCompletion.modelConfig.provider', ''),
                    baseUrl: config.get<string>('fimCompletion.modelConfig.baseUrl', ''),
                    model: config.get<string>('fimCompletion.modelConfig.model', ''),
                    maxTokens: this.validateNESMaxTokens(
                        config.get<number>('fimCompletion.modelConfig.maxTokens', 200)
                    ),
                    extraBody: config.get('fimCompletion.modelConfig.extraBody')
                }
            },
            nesCompletion: {
                enabled: config.get<boolean>('nesCompletion.enabled', false),
                debounceMs: this.validateNESDebounceMs(config.get<number>('nesCompletion.debounceMs', 500)),
                timeoutMs: this.validateNESTimeoutMs(config.get<number>('nesCompletion.timeoutMs', 5000)),
                manualOnly: config.get<boolean>('nesCompletion.manualOnly', false),
                modelConfig: {
                    provider: config.get<string>('nesCompletion.modelConfig.provider', ''),
                    baseUrl: config.get<string>('nesCompletion.modelConfig.baseUrl', ''),
                    model: config.get<string>('nesCompletion.modelConfig.model', ''),
                    maxTokens: this.validateNESMaxTokens(
                        config.get<number>('nesCompletion.modelConfig.maxTokens', 200)
                    ),
                    extraBody: config.get('nesCompletion.modelConfig.extraBody')
                }
            },
            commit: {
                // VS Code will automatically apply defaults from package.json configuration contribution.
                language: (config.get<CommitLanguage>('commit.language') ?? 'chinese') as CommitLanguage,
                format: (config.get<CommitFormat>('commit.format') ?? 'auto') as CommitFormat,
                customInstructions: config.get<string>('commit.customInstructions') ?? '',
                model: config.get<CommitModelSelection>('commit.model')
            },
            providerOverrides: config.get<UserConfigOverrides>('providerOverrides', {})
        };

        Logger.debug('Configuration loaded', this.cache);
        return this.cache;
    }

    /**
     * Get maximum token count
     */
    static getMaxTokens(): number {
        return this.getConfig().maxTokens;
    }

    /**
     * Get request retry configuration
     */
    static getRetryConfig(): RequestRetryConfig {
        return this.getConfig().retry;
    }

    /**
     * Get maximum retry count
     */
    static getRetryMaxAttempts(): number {
        return this.getRetryConfig().maxAttempts;
    }

    /**
     * Get configuration for automatically adding provider prefix to model ID
     */
    static getAutoPrefixModelId(): boolean {
        return this.getConfig().autoPrefixModelId;
    }
    /**
     * Get ZhipuAI search configuration
     */
    static getZhipuSearchConfig(): ZhipuSearchConfig {
        return this.getConfig().zhipu.search;
    }

    /**
     * Get ZhipuAI unified configuration
     */
    static getZhipuConfig(): ZhipuConfig {
        return this.getConfig().zhipu;
    }

    /**
     * Get ZhipuAI endpoint configuration
     * @returns 'open.bigmodel.cn' or 'api.z.ai', default 'open.bigmodel.cn'
     */
    static getZhipuEndpoint(): 'open.bigmodel.cn' | 'api.z.ai' {
        return this.getConfig().zhipu.endpoint;
    }

    /**
     * Get MiniMax Coding Plan endpoint configuration
     * @returns 'minimaxi.com' or 'minimax.io', default 'minimaxi.com'
     */
    static getMinimaxEndpoint(): 'minimaxi.com' | 'minimax.io' {
        return this.getConfig().minimax.endpoint;
    }

    /**
     * Get Xiaomi MiMo Token Plan endpoint configuration
     * @returns 'cn' | 'sgp' | 'ams', default 'cn'
     */
    static getXiaomimimoEndpoint(): XiaomimimoConfig['endpoint'] {
        return this.getConfig().xiaomimimo.endpoint;
    }

    /**
     * Get FIM completion configuration
     */
    static getFIMConfig(): FIMCompletionConfig {
        return this.getConfig().fimCompletion;
    }

    /**
     * Get NES completion configuration
     */
    static getNESConfig(): NESCompletionConfig {
        return this.getConfig().nesCompletion;
    }

    /**
     * Get Commit configuration object
     */
    static getCommitConfig(): CommitConfig {
        return this.getConfig().commit;
    }

    /**
     * Get maximum token count suitable for model
     * Considering model limits and user configuration
     */
    static getMaxTokensForModel(modelMaxTokens: number): number {
        const configMaxTokens = this.getMaxTokens();
        return Math.min(modelMaxTokens, configMaxTokens);
    }

    /**
     * Validate maximum token count
     */
    private static validateMaxTokens(value: number): number {
        if (isNaN(value) || value < 32 || value > 256000) {
            Logger.warn(`Invalid maxTokens value: ${value}, using default value 16000`);
            return 16000;
        }
        return Math.floor(value);
    }

    /**
     * Validate maximum retry count
     */
    private static validateRetryMaxAttempts(value: number): number {
        if (isNaN(value) || value < 1 || value > 5) {
            Logger.warn(`Invalid retry.maxAttempts value: ${value}, using default value 3`);
            return 3;
        }
        return Math.floor(value);
    }

    /**
     * Validate debounce delay time
     */
    private static validateNESDebounceMs(value: number): number {
        if (isNaN(value) || value < 50 || value > 2000) {
            Logger.warn(`Invalid debounceMs value: ${value}, using default value 500`);
            return 500;
        }
        return Math.floor(value);
    }

    /**
     * Validate timeout
     */
    private static validateNESTimeoutMs(value: number): number {
        if (isNaN(value) || value < 1000 || value > 30000) {
            Logger.warn(`Invalid timeoutMs value: ${value}, using default value 5000`);
            return 5000;
        }
        return Math.floor(value);
    }

    /**
     * Validate NES completion maxTokens parameter
     */
    private static validateNESMaxTokens(value: number): number {
        if (isNaN(value) || value < 50 || value > 16000) {
            Logger.warn(`Invalid NES maxTokens value: ${value}, using default value 200`);
            return 200;
        }
        return Math.floor(value);
    }

    /**
     * Get provider configuration (new mode: directly import configProviders)
     */
    static getConfigProvider(): ConfigProvider {
        return configProviders;
    }

    /**
     * Get configuration override settings
     */
    static getProviderOverrides(): UserConfigOverrides {
        return this.getConfig().providerOverrides;
    }

    /**
     * Apply configuration overrides to original provider configuration
     */
    static applyProviderOverrides(providerKey: string, originalConfig: ProviderConfig): ProviderConfig {
        const overrides = this.getProviderOverrides();
        const override = overrides[providerKey];

        if (!override) {
            return originalConfig;
        }

        Logger.debug(`🔧 Applying configuration override for provider ${providerKey}`);

        // Create deep copy of configuration
        const config: ProviderConfig = JSON.parse(JSON.stringify(originalConfig));

        const applyModelOverride = (target: ModelConfig, modelOverride: ModelOverride): void => {
            if (modelOverride.name !== undefined) {
                target.name = modelOverride.name;
                Logger.debug(`  Model ${modelOverride.id}: override name = ${modelOverride.name}`);
            }
            if (modelOverride.tooltip !== undefined) {
                target.tooltip = modelOverride.tooltip;
                Logger.debug(`  Model ${modelOverride.id}: override tooltip = ${modelOverride.tooltip}`);
            }
            if (modelOverride.model !== undefined) {
                target.model = modelOverride.model;
                Logger.debug(`  Model ${modelOverride.id}: override model = ${modelOverride.model}`);
            }
            if (modelOverride.maxInputTokens !== undefined) {
                target.maxInputTokens = modelOverride.maxInputTokens;
                Logger.debug(`  Model ${modelOverride.id}: override maxInputTokens = ${modelOverride.maxInputTokens}`);
            }
            if (modelOverride.maxOutputTokens !== undefined) {
                target.maxOutputTokens = modelOverride.maxOutputTokens;
                Logger.debug(`  Model ${modelOverride.id}: override maxOutputTokens = ${modelOverride.maxOutputTokens}`);
            }
            if (modelOverride.sdkMode !== undefined) {
                target.sdkMode = modelOverride.sdkMode;
                Logger.debug(`  Model ${modelOverride.id}: override sdkMode = ${modelOverride.sdkMode}`);
            }
            if (modelOverride.baseUrl !== undefined) {
                target.baseUrl = modelOverride.baseUrl;
                Logger.debug(`  Model ${modelOverride.id}: override baseUrl = ${modelOverride.baseUrl}`);
            }
            if (modelOverride.useInstructions !== undefined) {
                target.useInstructions = modelOverride.useInstructions;
                Logger.debug(`  Model ${modelOverride.id}: override useInstructions = ${modelOverride.useInstructions}`);
            }
            if (modelOverride.webSearchTool !== undefined) {
                target.webSearchTool = modelOverride.webSearchTool;
                Logger.debug(`  Model ${modelOverride.id}: override webSearchTool = ${modelOverride.webSearchTool}`);
            }
            if (modelOverride.family !== undefined) {
                target.family = modelOverride.family;
                Logger.debug(`  Model ${modelOverride.id}: override family = ${modelOverride.family}`);
            }
            if (modelOverride.thinking !== undefined) {
                target.thinking = [...modelOverride.thinking];
                Logger.debug(`  Model ${modelOverride.id}: override thinking = ${JSON.stringify(modelOverride.thinking)}`);
            }
            if (modelOverride.thinkingFormat !== undefined) {
                target.thinkingFormat = modelOverride.thinkingFormat;
                Logger.debug(`  Model ${modelOverride.id}: override thinkingFormat = ${modelOverride.thinkingFormat}`);
            }
            if (modelOverride.reasoningEffort !== undefined) {
                target.reasoningEffort = [...modelOverride.reasoningEffort];
                Logger.debug(
                    `  Model ${modelOverride.id}: override reasoningEffort = ${JSON.stringify(modelOverride.reasoningEffort)}`
                );
            }
            if (modelOverride.capabilities) {
                target.capabilities = {
                    ...target.capabilities,
                    ...modelOverride.capabilities
                };
                Logger.debug(`  Model ${modelOverride.id}: merge capabilities = ${JSON.stringify(target.capabilities)}`);
            }
            if (modelOverride.customHeader) {
                target.customHeader = { ...target.customHeader, ...modelOverride.customHeader };
                Logger.debug(`  Model ${modelOverride.id}: merge customHeader = ${JSON.stringify(target.customHeader)}`);
            }
            if (modelOverride.extraBody) {
                target.extraBody = { ...target.extraBody, ...modelOverride.extraBody };
                Logger.debug(`  Model ${modelOverride.id}: merge extraBody = ${JSON.stringify(target.extraBody)}`);
            }
        };

        // Apply provider-level overrides
        if (override.baseUrl) {
            config.baseUrl = override.baseUrl;
            Logger.debug(`  Override baseUrl: ${override.baseUrl}`);
        }
        if (override.customHeader) {
            config.customHeader = { ...config.customHeader, ...override.customHeader };
            Logger.debug(`  Override provider customHeader = ${JSON.stringify(config.customHeader)}`);
        }

        // Apply model-level overrides
        if (override.models && override.models.length > 0) {
            for (const modelOverride of override.models) {
                const existingModelIndex = config.models.findIndex(m => m.id === modelOverride.id);
                if (existingModelIndex >= 0) {
                    // Override existing model
                    const existingModel = config.models[existingModelIndex];
                    applyModelOverride(existingModel, modelOverride);
                } else {
                    // Add new model
                    const newModel: ModelConfig = {
                        id: modelOverride.id,
                        name: modelOverride.name || modelOverride.id,
                        tooltip: modelOverride.tooltip || `User-defined model: ${modelOverride.id}`,
                        maxInputTokens: modelOverride.maxInputTokens || 128000,
                        maxOutputTokens: modelOverride.maxOutputTokens || 8192,
                        capabilities: {
                            toolCalling: modelOverride.capabilities?.toolCalling ?? false,
                            imageInput: modelOverride.capabilities?.imageInput ?? false
                        }
                    };
                    applyModelOverride(newModel, modelOverride);
                    config.models.push(newModel);
                    Logger.info(`  Added new model: ${modelOverride.id}`);
                }
            }
        }

        // Merge provider-level customHeader into all models (model-level customHeader takes priority)
        if (override.customHeader) {
            for (const model of config.models) {
                if (model.customHeader) {
                    // If model already has customHeader, merge provider-level as default values
                    model.customHeader = { ...override.customHeader, ...model.customHeader };
                } else {
                    // If model has no customHeader, use provider-level directly
                    model.customHeader = { ...override.customHeader };
                }
            }
            Logger.debug(`  Provider ${providerKey}: Merged provider-level customHeader into all models`);
        }

        return config;
    }

    /**
     * Dispose resources
     */
    static dispose(): void {
        if (this.configListener) {
            this.configListener.dispose();
            this.configListener = null;
        }
        this.cache = null;
        Logger.trace('Configuration manager disposed');
    }
}

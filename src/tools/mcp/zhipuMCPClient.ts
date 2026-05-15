/*---------------------------------------------------------------------------------------------
 *  ZhipuAI MCP WebSearch Client
 *  Uses official @modelcontextprotocol/sdk to connect to ZhipuAI MCP via StreamableHTTP
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Logger } from '../../utils/logger';
import { ConfigManager } from '../../utils/configManager';
import { ApiKeyManager } from '../../utils/apiKeyManager';
import { VersionManager } from '../../utils/versionManager';
import { ZhipuSearchResult } from '../zhipuSearch';

/**
 * Search request parameters
 */
export interface ZhipuWebSearchRequest {
    search_query: string;
    search_engine?: 'search_std' | 'search_pro' | 'search_pro_sogou' | 'search_pro_quark';
    search_intent?: boolean;
    count?: number;
    search_domain_filter?: string;
    search_recency_filter?: 'noLimit' | 'day' | 'week' | 'month' | 'year';
    content_size?: 'low' | 'medium' | 'high';
}

/**
 * ZhipuAI MCP WebSearch client
 */
export class ZhipuMCPWebSearchClient {
    private static clientCache = new Map<string, ZhipuMCPWebSearchClient>();

    private client: Client | null = null;
    private transport: StreamableHTTPClientTransport | null = null;
    private readonly userAgent: string;
    private currentApiKey: string | null = null;
    private isConnecting = false;
    private connectionPromise: Promise<void> | null = null;

    private constructor() {
        this.userAgent = VersionManager.getUserAgent('MCPWebSearch');
    }

    static async getInstance(apiKey?: string): Promise<ZhipuMCPWebSearchClient> {
        const key = apiKey || (await ApiKeyManager.getApiKey('zhipu'));
        if (!key) {
            throw new Error('ZhipuAI API key not set');
        }

        let instance = ZhipuMCPWebSearchClient.clientCache.get(key);

        if (!instance) {
            Logger.debug(`📦 [Zhipu MCP] Creating new client instance (API key: ${key.substring(0, 8)}...)`);
            instance = new ZhipuMCPWebSearchClient();
            instance.currentApiKey = key;
            ZhipuMCPWebSearchClient.clientCache.set(key, instance);
        } else {
            Logger.debug(`♻️ [Zhipu MCP] Reusing cached client instance (API key: ${key.substring(0, 8)}...)`);
        }

        await instance.ensureConnected();

        return instance;
    }

    static async clearCache(apiKey?: string): Promise<void> {
        if (apiKey) {
            const instance = ZhipuMCPWebSearchClient.clientCache.get(apiKey);
            if (instance) {
                await instance.cleanup();
                ZhipuMCPWebSearchClient.clientCache.delete(apiKey);
                Logger.info(`🗑️ [Zhipu MCP] Cleared cache for API key ${apiKey.substring(0, 8)}...`);
            }
        } else {
            for (const [key, instance] of ZhipuMCPWebSearchClient.clientCache.entries()) {
                await instance.cleanup();
                Logger.info(`🗑️ [Zhipu MCP] Cleared cache for API key ${key.substring(0, 8)}...`);
            }
            ZhipuMCPWebSearchClient.clientCache.clear();
            Logger.info('🗑️ [Zhipu MCP] Cleared all client caches');
        }
    }

    static getCacheStats(): { totalClients: number; connectedClients: number; apiKeys: string[] } {
        const stats = {
            totalClients: ZhipuMCPWebSearchClient.clientCache.size,
            connectedClients: 0,
            apiKeys: [] as string[]
        };

        for (const [key, instance] of ZhipuMCPWebSearchClient.clientCache.entries()) {
            if (instance.isConnected()) {
                stats.connectedClients++;
            }
            stats.apiKeys.push(key.substring(0, 8) + '...');
        }

        return stats;
    }

    private async handleErrorResponse(error: Error): Promise<void> {
        const errorMessage = error.message;

        if (errorMessage.includes('403') || errorMessage.includes('You do not have permission to access')) {
            if (errorMessage.includes('search-prime') || errorMessage.includes('web_search_prime')) {
                Logger.warn(`⚠️ [Zhipu MCP] Detected insufficient web search MCP permissions: ${errorMessage}`);

                const shouldDisableMCP = await this.showMCPDisableDialog();

                if (shouldDisableMCP) {
                    await this.disableMCPMode();
                    throw new Error('ZhipuAI search permission insufficient: MCP mode has been disabled, please try searching again.');
                } else {
                    throw new Error(
                        'ZhipuAI search permission insufficient: Your account does not have permission to access web search MCP functionality. Please check your ZhipuAI subscription status.'
                    );
                }
            } else {
                throw new Error('ZhipuAI search permission insufficient: 403 error. Please check your API key permissions or subscription status.');
            }
        } else if (errorMessage.includes('MCP error')) {
            const mcpErrorMatch = errorMessage.match(/MCP error (\d+): (.+)/);
            if (mcpErrorMatch) {
                const [, errorCode, errorDesc] = mcpErrorMatch;
                throw new Error(`ZhipuAI MCP protocol error ${errorCode}: ${errorDesc}`);
            }
        }

        throw error;
    }

    private async showMCPDisableDialog(): Promise<boolean> {
        const message =
            'Your ZhipuAI account does not have permission to access web search MCP functionality. This may be because:\n\n' +
            '1. Your account does not support MCP functionality (Coding Plan subscription required)\n' +
            '2. API key permissions are insufficient\n\n' +
            'Switch to standard billing mode (pay-per-use)?';

        const result = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            'Switch to Standard Mode',
            'Keep MCP Mode'
        );

        return result === 'Switch to Standard Mode';
    }

    private async disableMCPMode(): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('ccmp.zhipu.search');
            await config.update('enableMCP', false, vscode.ConfigurationTarget.Global);

            Logger.info('✅ [Zhipu MCP] MCP mode disabled, switched to standard billing mode');

            vscode.window.showInformationMessage(
                'ZhipuAI search has switched to standard billing mode (pay-per-use). You can re-enable MCP mode in settings.'
            );

            await this.internalCleanup();
        } catch (error) {
            Logger.error('❌ [Zhipu MCP] Failed to disable MCP mode', error instanceof Error ? error : undefined);
            throw new Error(`Failed to disable MCP mode: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    async isEnabled(): Promise<boolean> {
        const apiKey = await ApiKeyManager.getApiKey('zhipu');
        return !!apiKey;
    }

    private isConnected(): boolean {
        return this.client !== null && this.transport !== null;
    }

    private async ensureConnected(): Promise<void> {
        if (this.isConnected()) {
            Logger.debug('✅ [Zhipu MCP] Client connected');
            return;
        }

        if (this.isConnecting && this.connectionPromise) {
            Logger.debug('⏳ [Zhipu MCP] Waiting for connection to complete...');
            return this.connectionPromise;
        }

        this.isConnecting = true;
        this.connectionPromise = this.initializeClient().finally(() => {
            this.isConnecting = false;
            this.connectionPromise = null;
        });

        return this.connectionPromise;
    }

    private async initializeClient(): Promise<void> {
        if (this.client && this.transport) {
            Logger.debug('✅ [Zhipu MCP] Client initialized');
            return;
        }

        const apiKey = this.currentApiKey || (await ApiKeyManager.getApiKey('zhipu'));
        if (!apiKey) {
            throw new Error('ZhipuAI API key not set');
        }

        this.currentApiKey = apiKey;

        Logger.info('🔗 [Zhipu MCP] Initializing MCP client...');

        try {
            let httpUrl = 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp';
            const endpoint = ConfigManager.getZhipuEndpoint();
            if (endpoint === 'api.z.ai') {
                httpUrl = httpUrl.replace('open.bigmodel.cn', 'api.z.ai');
            }

            this.client = new Client(
                {
                    name: 'CCMP-Zhipu-WebSearch-Client',
                    version: VersionManager.getVersion()
                },
                {
                    capabilities: {
                        sampling: {
                            tools: {}
                        }
                    }
                }
            );

            this.transport = new StreamableHTTPClientTransport(new URL(httpUrl), {
                requestInit: {
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'User-Agent': this.userAgent
                    }
                }
            });

            await this.client.connect(this.transport);
            Logger.info('✅ [Zhipu MCP] Connected successfully using StreamableHTTP transport');
        } catch (error) {
            Logger.error('❌ [Zhipu MCP] Client initialization failed', error instanceof Error ? error : undefined);
            await this.internalCleanup();
            throw new Error(`MCP client connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    async search(params: ZhipuWebSearchRequest): Promise<ZhipuSearchResult[]> {
        Logger.info(`🔍 [Zhipu MCP] Starting search: "${params.search_query}"`);

        await this.ensureConnected();

        if (!this.client) {
            throw new Error('MCP client not initialized');
        }

        try {
            const tools = await this.client.listTools();
            Logger.debug(`📋 [Zhipu MCP] Available tools: ${tools.tools.map(t => t.name).join(', ')}`);

            const webSearchTool = tools.tools.find(t => t.name === 'web_search_prime');
            if (!webSearchTool) {
                throw new Error('web_search_prime tool not found');
            }

            const result = await this.client.callTool({
                name: 'web_search_prime',
                arguments: {
                    search_query: params.search_query,
                    search_engine: params.search_engine || 'search_std',
                    search_intent: params.search_intent || false,
                    count: params.count || 10,
                    search_domain_filter: params.search_domain_filter,
                    search_recency_filter: params.search_recency_filter || 'noLimit',
                    content_size: params.content_size || 'medium'
                }
            });

            if (Array.isArray(result.content)) {
                const [{ text }] = result.content as { type: 'text'; text: string }[];
                if (text.startsWith('MCP error')) {
                    throw new Error(text);
                }
                const searchResults = JSON.parse(JSON.parse(text) as string) as ZhipuSearchResult[];
                Logger.debug(`📊 [Zhipu MCP] Tool invocation successful: ${searchResults?.length || 0} results`);
                return searchResults;
            }

            Logger.debug('📊 [Zhipu MCP] Tool invocation ended: no results');
            return [];
        } catch (error) {
            Logger.error('❌ [Zhipu MCP] Search failed', error instanceof Error ? error : undefined);

            if (error instanceof Error) {
                await this.handleErrorResponse(error);
            }

            if (error instanceof Error && (error.message.includes('connect') || error.message.includes('connection'))) {
                Logger.warn('⚠️ [Zhipu MCP] Detected connection error, will auto-reconnect on next search');
                await this.internalCleanup();
            }

            throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    getStatus(): { name: string; version: string; enabled: boolean; connected: boolean } {
        return {
            name: 'CCMP-Zhipu-MCP-WebSearch-Client',
            version: VersionManager.getVersion(),
            enabled: true,
            connected: this.isConnected()
        };
    }

    private async internalCleanup(): Promise<void> {
        Logger.debug('🔌 [Zhipu MCP] Cleaning up client connection...');

        try {
            if (this.transport) {
                await this.transport.close();
                this.transport = null;
            }

            this.client = null;

            Logger.debug('✅ [Zhipu MCP] Client connection cleaned up');
        } catch (error) {
            Logger.error('❌ [Zhipu MCP] Connection cleanup failed', error instanceof Error ? error : undefined);
        }
    }

    async cleanup(): Promise<void> {
        Logger.info('🔌 [Zhipu MCP] Cleaning up client resources...');

        try {
            await this.internalCleanup();

            if (this.currentApiKey) {
                ZhipuMCPWebSearchClient.clientCache.delete(this.currentApiKey);
                Logger.info(`🗑️ [Zhipu MCP] Removed client from cache (API key: ${this.currentApiKey.substring(0, 8)}...)`);
            }

            Logger.info('✅ [Zhipu MCP] Client resources cleaned up');
        } catch (error) {
            Logger.error('❌ [Zhipu MCP] Resource cleanup failed', error instanceof Error ? error : undefined);
        }
    }

    async reconnect(): Promise<void> {
        Logger.info('🔄 [Zhipu MCP] Reconnecting client...');
        await this.internalCleanup();
        await this.ensureConnected();
    }
}

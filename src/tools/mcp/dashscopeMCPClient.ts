/*---------------------------------------------------------------------------------------------
 *  Alibaba Cloud DashScope MCP WebSearch Client
 *  Uses official @modelcontextprotocol/sdk to connect to DashScope WebSearch MCP via StreamableHTTP
 *--------------------------------------------------------------------------------------------*/

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Logger } from '../../utils/logger';
import { ApiKeyManager } from '../../utils/apiKeyManager';
import { VersionManager } from '../../utils/versionManager';

/**
 * DashScope search request parameters
 */
export interface DashscopeWebSearchRequest {
    query: string;
    count?: number;
}

/**
 * DashScope search result page item
 */
export interface DashscopeSearchPage {
    title: string;
    url: string;
    snippet: string;
    hostname?: string;
    hostlogo?: string;
}

/**
 * DashScope MCP raw response
 */
export interface DashscopeMCPResponse {
    pages: DashscopeSearchPage[];
    request_id?: string;
    tools?: unknown[];
    status?: number;
}

/**
 * DashScope MCP WebSearch client
 */
export class DashscopeMCPWebSearchClient {
    private static clientCache = new Map<string, DashscopeMCPWebSearchClient>();

    private static readonly MCP_URL = 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp';

    private client: Client | null = null;
    private transport: StreamableHTTPClientTransport | null = null;
    private readonly userAgent: string;
    private currentApiKey: string | null = null;
    private isConnecting = false;
    private connectionPromise: Promise<void> | null = null;
    private activeSearchCount = 0;
    private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
    private cleanupPromise: Promise<void> | null = null;

    private constructor() {
        this.userAgent = VersionManager.getUserAgent('DashScopeMCPWebSearch');
    }

    static async getInstance(apiKey?: string): Promise<DashscopeMCPWebSearchClient> {
        const key = apiKey || (await ApiKeyManager.getApiKey('dashscope'));
        if (!key) {
            throw new Error('DashScope API key not set, please run command "CCMP: Set DashScope API Key" first');
        }

        let instance = DashscopeMCPWebSearchClient.clientCache.get(key);
        if (!instance) {
            Logger.debug(`📦 [DashScope MCP] Creating new client instance (API key: ${key.substring(0, 8)}...)`);
            instance = new DashscopeMCPWebSearchClient();
            instance.currentApiKey = key;
            DashscopeMCPWebSearchClient.clientCache.set(key, instance);
        } else {
            Logger.debug(`♻️ [DashScope MCP] Reusing cached client instance (API key: ${key.substring(0, 8)}...)`);
        }

        await instance.ensureConnected();
        return instance;
    }

    static async clearCache(apiKey?: string): Promise<void> {
        if (apiKey) {
            const instance = DashscopeMCPWebSearchClient.clientCache.get(apiKey);
            if (instance) {
                await instance.cleanup();
                DashscopeMCPWebSearchClient.clientCache.delete(apiKey);
                Logger.info(`🗑️ [DashScope MCP] Cleared cache for API key ${apiKey.substring(0, 8)}...`);
            }
        } else {
            for (const [key, instance] of DashscopeMCPWebSearchClient.clientCache.entries()) {
                await instance.cleanup();
                Logger.info(`🗑️ [DashScope MCP] Cleared cache for API key ${key.substring(0, 8)}...`);
            }
            DashscopeMCPWebSearchClient.clientCache.clear();
            Logger.info('🗑️ [DashScope MCP] Cleared all client caches');
        }
    }

    static getCacheStats(): { totalClients: number; connectedClients: number; apiKeys: string[] } {
        const stats = {
            totalClients: DashscopeMCPWebSearchClient.clientCache.size,
            connectedClients: 0,
            apiKeys: [] as string[]
        };

        for (const [key, instance] of DashscopeMCPWebSearchClient.clientCache.entries()) {
            if (instance.isConnected()) {
                stats.connectedClients++;
            }
            stats.apiKeys.push(key.substring(0, 8) + '...');
        }

        return stats;
    }

    async isEnabled(): Promise<boolean> {
        const apiKey = await ApiKeyManager.getApiKey('dashscope');
        return !!apiKey;
    }

    private isConnected(): boolean {
        return this.client !== null && this.transport !== null;
    }

    private async ensureConnected(): Promise<void> {
        this.cancelPendingCleanup();

        if (this.cleanupPromise) {
            Logger.debug('⏳ [DashScope MCP] Waiting for connection cleanup to complete...');
            await this.cleanupPromise;
        }

        if (this.isConnected()) {
            Logger.debug('✅ [DashScope MCP] Client connected');
            return;
        }

        if (this.isConnecting && this.connectionPromise) {
            Logger.debug('⏳ [DashScope MCP] Waiting for connection to complete...');
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
            Logger.debug('✅ [DashScope MCP] Client initialized');
            return;
        }

        const apiKey = this.currentApiKey || (await ApiKeyManager.getApiKey('dashscope'));
        if (!apiKey) {
            throw new Error('DashScope API key not set');
        }

        this.currentApiKey = apiKey;

        Logger.info('🔗 [DashScope MCP] Initializing MCP client...');

        try {
            this.client = new Client(
                {
                    name: 'CCMP-DashScope-WebSearch-Client',
                    version: VersionManager.getVersion()
                },
                {
                    capabilities: {}
                }
            );

            this.transport = new StreamableHTTPClientTransport(new URL(DashscopeMCPWebSearchClient.MCP_URL), {
                requestInit: {
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'User-Agent': this.userAgent
                    }
                },
                reconnectionOptions: {
                    maxRetries: 2,
                    initialReconnectionDelay: 300, // 30 seconds initial reconnection delay
                    maxReconnectionDelay: 120000, // Max 2 minutes
                    reconnectionDelayGrowFactor: 2.0
                }
            });

            await this.client.connect(this.transport);
            Logger.info('✅ [DashScope MCP] Connected successfully using StreamableHTTP transport');
        } catch (error) {
            let errorDetail = error instanceof Error ? error.message : String(error);
            let cause: unknown = error instanceof Error ? error.cause : undefined;
            while (cause) {
                errorDetail += ` | cause: ${cause instanceof Error ? cause.message : String(cause)}`;
                cause = cause instanceof Error ? cause.cause : undefined;
            }
            Logger.error(`❌ [DashScope MCP] Client initialization failed ${errorDetail}`);
            await this.internalCleanup();
            throw new Error(`MCP client connection failed: ${errorDetail}`);
        }
    }

    async search(params: DashscopeWebSearchRequest): Promise<DashscopeSearchPage[]> {
        Logger.info(`🔍 [DashScope MCP] Starting search: "${params.query}"`);

        this.cancelPendingCleanup();
        this.activeSearchCount++;

        await this.ensureConnected();

        if (!this.client) {
            this.activeSearchCount = Math.max(0, this.activeSearchCount - 1);
            throw new Error('MCP client not initialized');
        }

        try {
            const tools = await this.client.listTools();
            Logger.debug(`📋 [DashScope MCP] Available tools: ${tools.tools.map(t => t.name).join(', ')}`);

            const webSearchTool = tools.tools.find(t => t.name === 'bailian_web_search');
            if (!webSearchTool) {
                throw new Error('bailian_web_search tool not found, please confirm that DashScope web search MCP service is enabled');
            }

            const result = await this.client.callTool({
                name: 'bailian_web_search',
                arguments: {
                    query: params.query,
                    ...(params.count ? { count: params.count } : {})
                }
            });

            if (Array.isArray(result.content) && result.content.length > 0) {
                const text = result.content.map(item => (item.type === 'text' ? item.text : '')).join('\n');
                if (text.startsWith('MCP error')) {
                    throw new Error(text);
                }
                const response = JSON.parse(text) as DashscopeMCPResponse;
                const pages = response.pages || [];
                Logger.info(`✅ [DashScope MCP] Search completed: found ${pages.length} results`);
                return pages;
            }
            Logger.debug('📊 [DashScope MCP] Tool invocation ended: no results');
            return [];
        } catch (error) {
            Logger.error('❌ [DashScope MCP] Search failed', error instanceof Error ? error : undefined);

            if (error instanceof Error && (error.message.includes('connect') || error.message.includes('Connection') || error.message.includes('connection'))) {
                Logger.warn('⚠️ [DashScope MCP] Detected connection error, will auto-reconnect on next search');
                await this.internalCleanup();
            }

            throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        } finally {
            this.activeSearchCount = Math.max(0, this.activeSearchCount - 1);
            this.scheduleCleanupAfterIdle();
        }
    }

    getStatus(): { name: string; version: string; enabled: boolean; connected: boolean } {
        return {
            name: 'CCMP-DashScope-MCP-WebSearch-Client',
            version: VersionManager.getVersion(),
            enabled: true,
            connected: this.isConnected()
        };
    }

    private async internalCleanup(): Promise<void> {
        Logger.debug('🔌 [DashScope MCP] Cleaning up client connection...');

        try {
            if (this.transport) {
                await this.transport.close();
                this.transport = null;
            }
            this.client = null;
            Logger.debug('✅ [DashScope MCP] Client connection cleaned up');
        } catch (error) {
            Logger.error('❌ [DashScope MCP] Connection cleanup failed', error instanceof Error ? error : undefined);
        }
    }

    private cancelPendingCleanup(): void {
        if (this.cleanupTimer) {
            clearTimeout(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    private scheduleCleanupAfterIdle(): void {
        if (this.activeSearchCount > 0 || this.cleanupTimer || this.cleanupPromise) {
            return;
        }

        // Delay cleanup to next iteration of event loop to avoid concurrent searches sharing instance closing connections.
        this.cleanupTimer = setTimeout(() => {
            this.cleanupTimer = null;
            void this.cleanupIfIdle();
        }, 0);
    }

    private async cleanupIfIdle(): Promise<void> {
        if (this.activeSearchCount > 0 || this.cleanupPromise) {
            return;
        }

        this.cleanupPromise = (async () => {
            await this.internalCleanup();
            Logger.debug('🔌 [DashScope MCP] Connection closed after idle');
        })().finally(() => {
            this.cleanupPromise = null;
        });

        await this.cleanupPromise;
    }

    async cleanup(): Promise<void> {
        this.cancelPendingCleanup();
        await this.internalCleanup();
    }
}

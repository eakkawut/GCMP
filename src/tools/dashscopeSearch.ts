/*---------------------------------------------------------------------------------------------
 *  Alibaba Cloud DashScope Web Search Tool
 *  Accesses DashScope WebSearch MCP service via MCP protocol
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';
import {
    DashscopeMCPWebSearchClient,
    type DashscopeWebSearchRequest,
    type DashscopeSearchPage
} from './mcp/dashscopeMCPClient';

/**
 * Search request parameters
 */
export interface DashscopeSearchRequest {
    query: string;
    count?: number;
}

/**
 * Alibaba Cloud DashScope Web Search Tool
 */
export class DashscopeSearchTool {
    /**
     * Search via MCP
     */
    private async searchViaMCP(params: DashscopeSearchRequest): Promise<DashscopeSearchPage[]> {
        const mcpClient = await DashscopeMCPWebSearchClient.getInstance();

        const searchRequest: DashscopeWebSearchRequest = {
            query: params.query,
            ...(params.count ? { count: params.count } : {})
        };

        return await mcpClient.search(searchRequest);
    }

    /**
     * Tool invocation handler
     */
    async invoke(
        request: vscode.LanguageModelToolInvocationOptions<DashscopeSearchRequest>
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            Logger.info(`🚀 [Tool Invocation] Alibaba Cloud DashScope Web Search Tool invoked: ${JSON.stringify(request.input)}`);

            const params = request.input as DashscopeSearchRequest;
            if (!params.query) {
                throw new Error('Missing required parameter: query');
            }

            Logger.info(`🔄 [DashScope Search] Using MCP mode to search: "${params.query}"`);
            const searchResults = await this.searchViaMCP(params);

            Logger.info('✅ [Tool Invocation] Alibaba Cloud DashScope Web Search Tool invoked successfully');

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(searchResults))
            ]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            Logger.error('❌ [Tool Invocation] Alibaba Cloud DashScope Web Search Tool invocation failed', error instanceof Error ? error : undefined);

            throw new vscode.LanguageModelError(`DashScope search failed: ${errorMessage}`);
        }
    }

    /**
     * Clean up tool resources
     */
    async cleanup(): Promise<void> {
        try {
            // MCP client uses singleton pattern, no cleanup needed here
            // If needed to clear all MCP client cache, call DashscopeMCPWebSearchClient.clearCache()
            Logger.info('✅ [DashScope Search] Tool resources cleaned up');
        } catch (error) {
            Logger.error('❌ [DashScope Search] Resource cleanup failed', error instanceof Error ? error : undefined);
        }
    }

    /**
     * Get MCP client cache statistics
     */
    getMCPCacheStats() {
        return DashscopeMCPWebSearchClient.getCacheStats();
    }

    /**
     * Clear MCP client cache
     */
    async clearMCPCache(apiKey?: string): Promise<void> {
        await DashscopeMCPWebSearchClient.clearCache(apiKey);
    }
}

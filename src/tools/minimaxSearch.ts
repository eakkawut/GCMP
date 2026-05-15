/*---------------------------------------------------------------------------------------------
 *  MiniMax Web Search Tool
 *  Uses Coding Plan API for direct HTTP requests
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as https from 'https';
import { ConfigManager, Logger } from '../utils';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { VersionManager } from '../utils/versionManager';
import { StatusBarManager } from '../status';

/**
 * MiniMax search request parameters
 */
export interface MiniMaxSearchRequest {
    q: string; // Search query term
}

/**
 * MiniMax search result item
 */
export interface MiniMaxSearchResult {
    title: string;
    link: string;
    snippet: string; // Content summary
    date: string; // Publication date
}

/**
 * MiniMax search response
 */
export interface MiniMaxSearchResponse {
    organic: MiniMaxSearchResult[]; // Search results list
    base_resp: {
        status_code: number;
        status_msg: string;
    };
}

/**
 * MiniMax web search tool
 */
export class MiniMaxSearchTool {
    private readonly baseURL = 'https://api.minimax.chat/v1/coding_plan/search';

    /**
     * Execute search
     */
    async search(params: MiniMaxSearchRequest): Promise<MiniMaxSearchResponse> {
        const apiKey = await ApiKeyManager.getApiKey('minimax-coding');
        if (!apiKey) {
            throw new Error('MiniMax Coding Plan API key not set, please run command "CCMP: Set MiniMax Coding Plan API Key" first');
        }

        const requestData = JSON.stringify({
            q: params.q
        });

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(requestData),
                'User-Agent': VersionManager.getUserAgent('MiniMaxSearch')
            }
        };

        Logger.info(`🔍 [MiniMax Search] Starting search: "${params.q}"`);
        Logger.debug(`📝 [MiniMax Search] Request data: ${requestData}`);

        let requestUrl = this.baseURL;
        if (ConfigManager.getMinimaxEndpoint() === 'minimax.io') {
            // International site needs to use the specified search endpoint
            requestUrl = requestUrl.replace('api.minimax.chat', 'api.minimax.io');
        }

        return new Promise((resolve, reject) => {
            const req = https.request(requestUrl, options, res => {
                let data = '';

                res.on('data', chunk => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        Logger.debug(`📊 [MiniMax Search] Response status code: ${res.statusCode}`);
                        Logger.debug(`📄 [MiniMax Search] Response data: ${data}`);

                        if (res.statusCode !== 200) {
                            let errorMessage = `MiniMax search API error ${res.statusCode}`;
                            try {
                                const errorData = JSON.parse(data);
                                errorMessage += `: ${errorData.error?.message || JSON.stringify(errorData)}`;
                            } catch {
                                errorMessage += `: ${data}`;
                            }
                            Logger.error('❌ [MiniMax Search] API returned error', new Error(errorMessage));
                            reject(new Error(errorMessage));
                            return;
                        }

                        const response = JSON.parse(data) as MiniMaxSearchResponse;
                        Logger.info(`✅ [MiniMax Search] Search completed: found ${response.organic?.length || 0} results`);
                        resolve(response);
                    } catch (error) {
                        Logger.error('❌ [MiniMax Search] Failed to parse response', error instanceof Error ? error : undefined);
                        reject(
                            new Error(`Failed to parse MiniMax search response: ${error instanceof Error ? error.message : 'Unknown error'}`)
                        );
                    }
                });
            });

            req.on('error', error => {
                Logger.error('❌ [MiniMax Search] Request failed', error);
                reject(new Error(`MiniMax search request failed: ${error.message}`));
            });

            req.write(requestData);
            req.end();
        });
    }

    /**
     * Tool invocation handler
     */
    async invoke(
        request: vscode.LanguageModelToolInvocationOptions<MiniMaxSearchRequest>
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            Logger.info(`🚀 [Tool Invocation] MiniMax web search tool invoked: ${JSON.stringify(request.input)}`);

            const params = request.input as MiniMaxSearchRequest;
            if (!params.q) {
                throw new Error('Missing required parameter: q');
            }

            const response = await this.search(params);
            Logger.info('✅ [Tool Invocation] MiniMax web search tool invoked successfully');

            StatusBarManager.minimax?.delayedUpdate();

            const searchResults = response.organic;
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(searchResults))
            ]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            Logger.error('❌ [Tool Invocation] MiniMax web search tool invocation failed', error instanceof Error ? error : undefined);
            throw new vscode.LanguageModelError(`MiniMax search failed: ${errorMessage}`);
        }
    }

    /**
     * Clean up tool resources
     */
    async cleanup(): Promise<void> {
        try {
            Logger.info('✅ [MiniMax Search] Tool resources cleaned up');
        } catch (error) {
            Logger.error('❌ [MiniMax Search] Resource cleanup failed', error instanceof Error ? error : undefined);
        }
    }
}

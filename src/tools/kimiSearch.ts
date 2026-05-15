/*-----------------------------------------------------------------
 *  Kimi Web Search Tool
 *  Uses Kimi Code search API for HTTP requests
 *--------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as https from 'https';
import { Logger } from '../utils';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { StatusBarManager } from '../status';

/**
 * Kimi search request parameters
 */
export interface KimiSearchRequest {
    query: string; // Search query term
    limit?: number; // Number of results to return (1-50, default 10)
    includeContent?: boolean; // Whether to fetch page content
}

/**
 * Kimi search result item
 */
export interface KimiSearchResult {
    title: string;
    url: string;
    snippet?: string; // Content summary
    content?: string; // Page content (if includeContent is true)
    date?: string; // Publication date
    siteName?: string; // Website name
}

/**
 * Kimi search response
 */
export interface KimiSearchResponse {
    searchResults: KimiSearchResult[];
    requestId?: string;
}

/**
 * Kimi API raw response format
 */
interface KimiApiResponse {
    search_results?: Array<{
        title?: string;
        url?: string;
        snippet?: string;
        content?: string;
        date?: string;
        site_name?: string;
    }>;
}

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 50;
const DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * Kimi web search tool
 */
export class KimiSearchTool {
    private readonly baseURL = 'https://api.kimi.com/coding/v1/search';

    /**
     * Clamp result count to valid range
     */
    private clampNumResults(value: number | undefined): number {
        if (!value || Number.isNaN(value)) {
            return DEFAULT_NUM_RESULTS;
        }

        return Math.min(MAX_NUM_RESULTS, Math.max(1, value));
    }

    /**
     * Get API Key
     */
    private async getApiKey(): Promise<string | undefined> {
        let apiKey = await ApiKeyManager.getApiKey('kimi');

        if (!apiKey) {
            apiKey = await ApiKeyManager.getApiKey('moonshot');
        }

        return apiKey;
    }

    /**
     * Execute search
     */
    async search(params: KimiSearchRequest): Promise<KimiSearchResponse> {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error('Kimi API key not set, please run command "CCMP: Set Kimi For Coding API Key" first');
        }

        const limit = this.clampNumResults(params.limit);
        const requestData = JSON.stringify({
            text_query: params.query,
            limit,
            enable_page_crawling: params.includeContent ?? false,
            timeout_seconds: DEFAULT_TIMEOUT_SECONDS
        });

        const options = {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': 'KimiCLI/OpenClawKimiSearchPlugin',
                Authorization: `Bearer ${apiKey}`
            }
        };

        Logger.info(`🔍 [Kimi Search] Starting search: "${params.query}"`);
        Logger.debug(`📝 [Kimi Search] Request data: ${requestData}`);

        return new Promise((resolve, reject) => {
            const req = https.request(this.baseURL, options, res => {
                let data = '';

                res.on('data', chunk => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        Logger.debug(`📊 [Kimi Search] Response status code: ${res.statusCode}`);
                        // Logger.debug(`📄 [Kimi Search] Response data: ${data}`);

                        if (res.statusCode !== 200) {
                            let errorMessage = `Kimi search API error ${res.statusCode}`;
                            try {
                                const errorData = JSON.parse(data);
                                errorMessage += `: ${errorData.error?.message || JSON.stringify(errorData)}`;
                            } catch {
                                errorMessage += `: ${data}`;
                            }

                            Logger.error('❌ [Kimi Search] API returned error', new Error(errorMessage));
                            reject(new Error(errorMessage));
                            return;
                        }

                        const apiResponse = JSON.parse(data) as KimiApiResponse;
                        const requestId =
                            res.headers['x-request-id']?.toString() ??
                            res.headers['x-msh-request-id']?.toString() ??
                            undefined;

                        const searchResults: KimiSearchResult[] = [];
                        for (const result of apiResponse.search_results ?? []) {
                            if (!result.url) {
                                continue;
                            }

                            searchResults.push({
                                title: result.title ?? result.url,
                                url: result.url,
                                snippet: result.snippet,
                                content: result.content,
                                date: result.date,
                                siteName: result.site_name
                            });
                        }

                        Logger.info(`✅ [Kimi Search] Search completed: found ${searchResults.length} results`);
                        resolve({
                            searchResults,
                            requestId
                        });
                    } catch (error) {
                        Logger.error('❌ [Kimi Search] Failed to parse response', error instanceof Error ? error : undefined);
                        reject(
                            new Error(`Failed to parse Kimi search response: ${error instanceof Error ? error.message : 'Unknown error'}`)
                        );
                    }
                });
            });

            req.on('error', error => {
                Logger.error('❌ [Kimi Search] Request failed', error);
                reject(new Error(`Kimi search request failed: ${error.message}`));
            });

            req.setTimeout(DEFAULT_TIMEOUT_SECONDS * 1000, () => {
                req.destroy();
                reject(new Error('Kimi search request timed out'));
            });

            req.write(requestData);
            req.end();
        });
    }

    /**
     * Tool invocation handler
     */
    async invoke(
        request: vscode.LanguageModelToolInvocationOptions<KimiSearchRequest>
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            Logger.info(`🚀 [Tool Invocation] Kimi web search tool invoked: ${JSON.stringify(request.input)}`);
            const params = request.input as KimiSearchRequest;
            if (!params.query) {
                throw new Error('Missing required parameter: query');
            }

            const response = await this.search(params);
            Logger.info('✅ [Tool Invocation] Kimi web search tool invoked successfully');

            StatusBarManager.kimi?.delayedUpdate();

            const searchResults = response.searchResults;
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(searchResults))
            ]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            Logger.error('❌ [Tool Invocation] Kimi web search tool invocation failed', error instanceof Error ? error : undefined);
            throw new vscode.LanguageModelError(`Kimi search failed: ${errorMessage}`);
        }
    }

    /**
     * Clean up tool resources
     */
    async cleanup(): Promise<void> {
        try {
            Logger.info('✅ [Kimi Search] Tool resources cleaned up');
        } catch (error) {
            Logger.error('❌ [Kimi Search] Resource cleanup failed', error instanceof Error ? error : undefined);
        }
    }
}

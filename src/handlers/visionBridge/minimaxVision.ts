/*---------------------------------------------------------------------------------------------
 *  MiniMax Image Understanding Tool
 *  Makes HTTP requests directly using Coding Plan API
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as https from 'https';
import { ConfigManager } from '../../utils';
import { ApiKeyManager } from '../../utils/apiKeyManager';
import { VersionManager } from '../../utils/versionManager';
import { StatusBarManager } from '../../status';

/**
 * MiniMax image understanding request parameters
 */
export interface MiniMaxVisionRequest {
    prompt: string; // Question or analysis request
    image_url: string; // Image URL (HTTP/HTTPS URL or data URL)
}

/**
 * MiniMax image understanding response
 */
export interface MiniMaxVisionResponse {
    content: string; // Image analysis result text
}

/**
 * MiniMax image understanding tool
 */
export class MiniMaxVisionTool {
    private getBaseURL(): string {
        // Return corresponding base URL based on endpoint configuration
        if (ConfigManager.getMinimaxEndpoint() === 'minimax.io') {
            return 'https://api.minimax.io';
        }
        return 'https://api.minimaxi.com';
    }

    /**
     * Execute image understanding
     * @param params Request parameters
     * @param abortSignal Abort signal
     */
    async understand(params: MiniMaxVisionRequest, abortSignal?: AbortSignal): Promise<MiniMaxVisionResponse> {
        const apiKey = await ApiKeyManager.getApiKey('minimax-coding');
        if (!apiKey) {
            throw new Error('MiniMax Coding Plan API key not set, please run command "CCMP: Set MiniMax Coding Plan API Key" first');
        }

        const requestData = JSON.stringify({
            prompt: params.prompt,
            image_url: params.image_url
        });

        const requestUrl = `${this.getBaseURL()}/v1/coding_plan/vlm`;

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(requestData),
                'User-Agent': VersionManager.getUserAgent('MiniMaxVision')
            }
        };

        return new Promise((resolve, reject) => {
            const req = https.request(requestUrl, options, res => {
                let data = '';

                res.on('data', chunk => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        if (res.statusCode !== 200) {
                            let errorMessage = `MiniMax image understanding API error ${res.statusCode}`;
                            try {
                                const errorData = JSON.parse(data);
                                errorMessage += `: ${errorData.error?.message || JSON.stringify(errorData)}`;
                            } catch {
                                errorMessage += `: ${data}`;
                            }
                            reject(new Error(errorMessage));
                            return;
                        }

                        const response = JSON.parse(data) as MiniMaxVisionResponse;
                        resolve(response);
                    } catch (error) {
                        reject(
                            new Error(
                                `Failed to parse MiniMax image understanding response: ${error instanceof Error ? error.message : 'Unknown error'}`
                            )
                        );
                    }
                });
            });

            req.on('error', error => {
                if (abortSignal?.aborted) {
                    reject(new Error('User cancelled image understanding request'));
                    return;
                }
                reject(new Error(`MiniMax image understanding request failed: ${error.message}`));
            });

            // Request timeout: 60 seconds
            req.setTimeout(60000, () => {
                req.destroy();
                reject(new Error('MiniMax image understanding request timeout (60 seconds)'));
            });

            // Cancel signal listener
            if (abortSignal) {
                abortSignal.addEventListener('abort', () => {
                    req.destroy();
                });
            }

            req.write(requestData);
            req.end();
        });
    }

    /**
     * Directly understand image data (for image bridge functionality)
     * @param imageData Binary data of the image
     * @param mimeType MIME type of the image
     * @param prompt Optional prompt, default is "Describe this image"
     * @param abortSignal Abort signal
     */
    async understandImage(
        imageData: Uint8Array,
        mimeType: string,
        prompt = 'Describe this image',
        abortSignal?: AbortSignal
    ): Promise<MiniMaxVisionResponse> {
        // Convert image data to data URL (do not log complete data URL, only log metadata)
        const base64Data = Buffer.from(imageData).toString('base64');
        const dataUrl = `data:${mimeType};base64,${base64Data}`;

        return this.understand(
            {
                prompt,
                image_url: dataUrl
            },
            abortSignal
        );
    }

    /**
     * Tool call handler
     */
    async invoke(
        request: vscode.LanguageModelToolInvocationOptions<MiniMaxVisionRequest>
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const params = request.input as MiniMaxVisionRequest;

            if (!params.prompt) {
                throw new Error('Missing required parameter: prompt');
            }
            if (!params.image_url) {
                throw new Error('Missing required parameter: image_url');
            }

            const response = await this.understand(params);

            StatusBarManager.minimax?.delayedUpdate();

            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(response.content)]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new vscode.LanguageModelError(`MiniMax image understanding failed: ${errorMessage}`);
        }
    }

    /**
     * Clean up tool resources
     */
    async cleanup(): Promise<void> {
        // Currently no resources that need cleanup
    }
}

/*---------------------------------------------------------------------------------------------
 *  OpenAI Custom SSE Handler
 *  Uses native fetch API and custom SSE stream processing, supports extended fields like reasoning_content
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import OpenAI from 'openai';
import { Logger } from '../utils';
import { ConfigManager } from '../utils/configManager';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { TokenUsagesManager } from '../usages/usagesManager';
import { ModelConfig, ProviderConfig } from '../types/sharedTypes';
import { StreamReporter } from './streamReporter';
import type { GenericModelProvider } from '../providers/genericModelProvider';

/**
 * OpenAI Handler interface (for type-safe message and tool conversion)
 */
interface IOpenAIHandler {
    convertMessagesToOpenAI(
        messages: readonly vscode.LanguageModelChatMessage[],
        modelConfig?: ModelConfig
    ): OpenAI.Chat.ChatCompletionMessageParam[];
    convertToolsToOpenAI(tools: vscode.LanguageModelChatTool[]): OpenAI.Chat.ChatCompletionTool[];
}

/**
 * Extended Delta type to support reasoning_content field
 */
export interface ExtendedDelta extends OpenAI.Chat.ChatCompletionChunk.Choice.Delta {
    reasoning_content?: string;
}

/**
 * Extended CompletionUsage interface, containing prompt_tokens_details and completion_tokens_details
 */
interface ExtendedCompletionUsage extends OpenAI.Completions.CompletionUsage {
    prompt_tokens_details?: {
        cached_tokens?: number;
        audio_tokens?: number;
        [key: string]: number | undefined;
    };
    completion_tokens_details?: {
        reasoning_tokens?: number;
        audio_tokens?: number;
        [key: string]: number | undefined;
    };
}

/**
 * OpenAI Custom SSE Handler
 * Uses native fetch API and custom SSE stream processing
 */
export class OpenAICustomHandler {
    constructor(
        private providerInstance: GenericModelProvider,
        private openaiHandler: IOpenAIHandler
    ) { }
    private get provider(): string {
        return this.providerInstance.provider;
    }
    private get providerConfig(): ProviderConfig {
        return this.providerInstance.providerConfig;
    }

    /**
     * Request method using custom SSE stream processing
     */
    async handleRequest(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken,
        requestId?: string | null
    ): Promise<void> {
        const provider = modelConfig.provider || this.provider;
        const apiKey = await ApiKeyManager.getApiKey(provider);
        if (!apiKey) {
            throw new Error(`Missing ${provider} API key`);
        }

        const baseURL = (modelConfig.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
        const customEndpoint = modelConfig.endpoint;
        const url = customEndpoint
            ? customEndpoint.startsWith('http://') || customEndpoint.startsWith('https://')
                ? customEndpoint
                : `${baseURL}${customEndpoint.startsWith('/') ? customEndpoint : `/${customEndpoint}`}`
            : `${baseURL}/chat/completions`;

        Logger.info(`[${model.name}] Processing ${messages.length} messages using custom SSE processing`);

        if (!this.openaiHandler) {
            throw new Error('OpenAI handler not initialized');
        }

        // Build request parameters
        const requestBody: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
            model: modelConfig.model || modelConfig.id,
            messages: this.openaiHandler.convertMessagesToOpenAI(messages, modelConfig),
            max_tokens: ConfigManager.getMaxTokensForModel(model.maxOutputTokens),
            stream: true,
            stream_options: { include_usage: true }
        };

        // Add tool support (if any)
        if (options.tools && options.tools.length > 0 && modelConfig.capabilities?.toolCalling) {
            requestBody.tools = this.openaiHandler.convertToolsToOpenAI([...options.tools]);
        }

        // Merge extraBody parameters (if any)
        if (modelConfig.extraBody) {
            const filteredExtraBody = modelConfig.extraBody;
            Object.assign(requestBody, filteredExtraBody);
            Logger.trace(`${model.name} Merged extraBody parameters: ${JSON.stringify(filteredExtraBody)}`);
        }

        Logger.debug(`[${model.name}] Sending API request`);

        const abortController = new AbortController();
        const cancellationListener = token.onCancellationRequested(() => abortController.abort());

        try {
            // Merge provider-level and model-level customHeader
            // Model-level customHeader overrides provider-level customHeader with the same name
            const mergedCustomHeader = {
                ...this.providerConfig?.customHeader,
                ...modelConfig?.customHeader
            };

            // Handle API key replacement in merged customHeader
            const processedCustomHeader = ApiKeyManager.processCustomHeader(mergedCustomHeader, apiKey);

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                    ...processedCustomHeader
                },
                body: JSON.stringify(requestBody),
                signal: abortController.signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                let errorMessage = `API request failed: ${response.status} ${response.statusText}`;

                // Try to parse error response, extract detailed error information
                try {
                    const errorJson = JSON.parse(errorText);
                    if (errorJson.error) {
                        if (typeof errorJson.error === 'string') {
                            errorMessage = errorJson.error;
                        } else if (errorJson.error.message) {
                            errorMessage = errorJson.error.message;
                        }
                    }
                } catch {
                    // If parsing fails, use original error text
                    if (errorText) {
                        errorMessage = `${errorMessage} - ${errorText}`;
                    }
                }

                throw new Error(errorMessage);
            }

            if (!response.body) {
                throw new Error('Response body is empty');
            }

            // Create unified stream reporter
            const reporter = new StreamReporter({
                modelName: model.name,
                modelId: model.id,
                provider: this.provider,
                sdkMode: 'openai',
                progress
            });

            await this.processStream(model, response.body, reporter, requestId || '', token);

            Logger.debug(`[${model.name}] API request completed`);
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                Logger.warn(`[${model.name}] User cancelled the request`);
                throw new vscode.CancellationError();
            }
            throw error;
        } finally {
            cancellationListener.dispose();
        }
    }

    /**
     * Process SSE stream
     */
    private async processStream(
        model: vscode.LanguageModelChatInformation,
        body: ReadableStream<Uint8Array>,
        reporter: StreamReporter,
        requestId: string,
        token: vscode.CancellationToken
    ): Promise<void> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let chunkCount = 0;

        // Token statistics: Collect usage information
        let finalUsage: ExtendedCompletionUsage | undefined;
        // Record stream processing start and end times
        let streamStartTime: number | undefined = undefined;

        try {
            while (true) {
                if (token.isCancellationRequested) {
                    Logger.warn(`[${model.name}] User cancelled the request`);
                    break;
                }

                const { done, value } = await reader.read();
                if (done) {
                    break;
                }

                // Record time of first chunk as stream start time
                if (streamStartTime === undefined) {
                    streamStartTime = Date.now();
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim() || line.trim() === '') {
                        continue;
                    }

                    // Process SSE data line
                    if (line.startsWith('data:')) {
                        const data = line.substring(5).trim();

                        if (data === '[DONE]') {
                            Logger.debug(`[${model.name}] Received stream end marker`);
                            continue;
                        }

                        try {
                            const chunk = JSON.parse(data);
                            chunkCount++;

                            // Extract response ID (from first chunk)
                            if (chunk.id && typeof chunk.id === 'string') {
                                reporter.setResponseId(chunk.id);
                            }

                            // Check if this is the final chunk containing usage information
                            if (chunk.usage) {
                                finalUsage = chunk.usage;
                            }

                            // Process normal choices
                            for (const choice of chunk.choices || []) {
                                const delta = choice.delta as ExtendedDelta | undefined;

                                // Process thinking content (reasoning_content)
                                if (delta && delta.reasoning_content && typeof delta.reasoning_content === 'string') {
                                    reporter.bufferThinking(delta.reasoning_content);
                                }

                                // Process text content
                                if (delta && delta.content && typeof delta.content === 'string') {
                                    reporter.reportText(delta.content);
                                }

                                // Process tool calls - support accumulated processing of chunked data
                                if (delta && delta.tool_calls && Array.isArray(delta.tool_calls)) {
                                    for (const toolCall of delta.tool_calls) {
                                        const toolIndex = toolCall.index ?? 0;
                                        reporter.accumulateToolCall(
                                            toolIndex,
                                            toolCall.id,
                                            toolCall.function?.name,
                                            toolCall.function?.arguments
                                        );
                                    }
                                }

                                // Note: Do not call flushAll here, handle uniformly at stream end
                            }
                        } catch (error) {
                            Logger.error(`[${model.name}] Failed to parse JSON: ${data}`, error);
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        // Record stream end time
        const streamEndTime = Date.now();

        // Stream ended, output all remaining content
        reporter.flushAll(null);

        Logger.trace(`[${model.name}] SSE stream processing statistics: ${chunkCount} chunks, hasContent=${reporter.hasContent}`);
        Logger.debug(`[${model.name}] Stream processing completed`);

        if (finalUsage) {
            // Extract cached token information
            const cacheReadTokens = finalUsage.prompt_tokens_details?.cached_tokens ?? 0;
            // Calculate output speed
            const duration = streamStartTime && streamEndTime ? streamEndTime - streamStartTime : 0;
            const speed = duration > 0 ? ((finalUsage.completion_tokens / duration) * 1000).toFixed(1) : 'N/A';
            Logger.info(
                `📊 ${model.name} Token Usage: Input ${finalUsage.prompt_tokens}${cacheReadTokens > 0 ? ` (cached:${cacheReadTokens})` : ''} + Output ${finalUsage.completion_tokens} = Total ${finalUsage.total_tokens}, Elapsed=${duration}ms, Speed=${speed} tokens/s`
            );
        }

        // === Token statistics: Update actual tokens ===
        try {
            const usagesManager = TokenUsagesManager.instance;
            await usagesManager.updateActualTokens({
                requestId,
                rawUsage: finalUsage || {},
                status: 'completed',
                streamStartTime,
                streamEndTime
            });
        } catch (err) {
            Logger.warn('Failed to update Token statistics:', err);
        }
    }
}

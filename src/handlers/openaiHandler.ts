/*---------------------------------------------------------------------------------------------
 *  OpenAI SDK Handler
 *  Implement streaming chat completion using OpenAI SDK
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import OpenAI from 'openai';
import { Logger, VersionManager, sanitizeToolSchemaForTarget } from '../utils';
import { ConfigManager } from '../utils/configManager';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { TokenUsagesManager } from '../usages/usagesManager';
import { ModelChatResponseOptions, ModelConfig, ProviderConfig } from '../types/sharedTypes';
import { StreamReporter } from './streamReporter';
import { getReasoningReplayPolicy, shouldInjectReasoningPlaceholder } from './reasoningReplayPolicy';
import { decodeStatefulMarker } from './statefulMarker';
import { CustomDataPartMimeTypes } from './types';
import type { GenericModelProvider } from '../providers/genericModelProvider';
import type { CommitChatModelOptions } from '../commit';

/**
 * Extended Delta type to support reasoning_content field
 */
export interface ExtendedDelta extends OpenAI.Chat.ChatCompletionChunk.Choice.Delta {
    reasoning_content?: string;
}

/**
 * Extended Choice type to support compatible old-format message field
 */
interface ExtendedChoice extends OpenAI.Chat.Completions.ChatCompletionChunk.Choice {
    message?: {
        content?: string;
        reasoning_content?: string;
    };
}

interface ParsedSSEChoice {
    message?: Record<string, unknown>;
    delta?: Record<string, unknown>;
    finish_reason?: unknown;
    index?: number | null;
}

interface ParsedSSEResponsePayload {
    object?: string;
    output?: unknown[];
}

interface ParsedSSEItemPayload {
    type?: string;
    content?: unknown[];
}

interface ParsedSSEChunk {
    choices?: ParsedSSEChoice[];
    type?: string;
    response?: ParsedSSEResponsePayload;
    item?: ParsedSSEItemPayload;
    output_index?: number | null;
}

/**
 * Extended assistant message type, supporting reasoning_content field
 */
interface ExtendedAssistantMessageParam extends OpenAI.Chat.ChatCompletionAssistantMessageParam {
    reasoning_content?: string;
}

/**
 * OpenAI API error detail type
 */
interface APIErrorDetail {
    message?: string;
    code?: string | null;
    type?: string;
    param?: string | null;
}

/**
 * OpenAI APIError type (contains error property)
 */
interface APIErrorWithError extends Error {
    error?: APIErrorDetail | string;
    status?: number;
    headers?: Headers;
}

/**
 * OpenAI SDK Handler
 * Implement streaming chat completion using OpenAI SDK, supporting tool calls
 */
export class OpenAIHandler {
    // SDK event deduplication tracker (request-level based)
    private currentRequestProcessedEvents = new Set<string>();

    constructor(private providerInstance: GenericModelProvider) {
        // providerInstance provides dynamic ability to get providerConfig and providerKey
    }
    private get provider(): string {
        return this.providerInstance.provider;
    }
    private get providerConfig(): ProviderConfig | undefined {
        return this.providerInstance.providerConfig;
    }
    private get displayName(): string {
        return this.providerConfig?.displayName || this.provider;
    }
    private get baseURL(): string | undefined {
        return this.providerConfig?.baseUrl;
    }

    /**
     * Create new OpenAI client
     */
    async createOpenAIClient(modelConfig?: ModelConfig): Promise<OpenAI> {
        // Priority: model.provider -> this.provider
        const providerKey = modelConfig?.provider || this.provider;
        const currentApiKey = await ApiKeyManager.getApiKey(providerKey);
        if (!currentApiKey) {
            throw new Error(`Missing ${this.displayName} API key`);
        }
        // Prefer model-specific baseUrl, fallback to provider-level baseUrl if not available
        let baseURL = modelConfig?.baseUrl || this.baseURL;

        // Override baseURL for ZhipuAI international site
        if (providerKey === 'zhipu') {
            const endpoint = ConfigManager.getZhipuEndpoint();
            if (baseURL && endpoint === 'api.z.ai') {
                baseURL = baseURL.replace('open.bigmodel.cn', 'api.z.ai');
            }
        }

        // Build default headers, including custom headers
        const defaultHeaders: Record<string, string> = {
            'User-Agent': VersionManager.getUserAgent('OpenAI')
        };

        // Merge provider-level and model-level customHeader
        // Model-level customHeader overrides provider-level customHeader with the same name
        const mergedCustomHeader = {
            ...this.providerConfig?.customHeader,
            ...modelConfig?.customHeader
        };

        // Process merged customHeader
        const processedCustomHeader = ApiKeyManager.processCustomHeader(mergedCustomHeader, currentApiKey);
        if (Object.keys(processedCustomHeader).length > 0) {
            Object.assign(defaultHeaders, processedCustomHeader);
            Logger.debug(`${this.displayName} Applied custom headers: ${JSON.stringify(mergedCustomHeader)}`);
        }

        let customFetch: typeof fetch | undefined = undefined; // Use default fetch implementation
        customFetch = this.createCustomFetch(modelConfig, baseURL); // Use custom fetch to solve SSE format issues
        const client = new OpenAI({
            apiKey: currentApiKey,
            baseURL: baseURL,
            defaultHeaders: defaultHeaders,
            fetch: customFetch
        });
        Logger.trace(`${this.displayName} OpenAI SDK client created, using baseURL: ${baseURL}`);
        return client;
    }

    /**
     * Create custom fetch function to handle non-standard SSE format
     * Fix issue where some models output "data:" without trailing space
     * If modelConfig.endpoint is set, replace SDK-constructed request URL with custom endpoint
     */
    private createCustomFetch(modelConfig?: ModelConfig, resolvedBaseURL?: string): typeof fetch {
        return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
            let requestUrl: string | URL | Request = url;
            // If custom endpoint is configured, override SDK-constructed request URL
            if (modelConfig?.endpoint) {
                const customEndpoint = modelConfig.endpoint;
                if (customEndpoint.startsWith('http://') || customEndpoint.startsWith('https://')) {
                    // Complete URL, use directly
                    requestUrl = customEndpoint;
                } else {
                    // Relative path, concatenate to baseURL
                    const base = (resolvedBaseURL || '').replace(/\/$/, '');
                    requestUrl = `${base}${customEndpoint.startsWith('/') ? customEndpoint : `/${customEndpoint}`}`;
                }
                Logger.debug(`Custom endpoint: ${String(url)} -> ${String(requestUrl)}`);
            }
            // Call original fetch
            const response = await fetch(requestUrl, init);
            // All calls of current plugin are streaming requests, directly preprocess all responses
            // preprocessSSEResponse is now async, may throw errors for upper layers to catch
            return await this.preprocessSSEResponse(response);
        };
    }

    /**
     * Compatible with some gateways directly outputting control characters in JSON string literals, causing OpenAI SDK's SSE JSON.parse to fail prematurely.
     * Only escape U+0000-U+001F in string context, do not modify normal JSON structure.
     */
    private escapeControlCharsInJsonString(input: string): { text: string; changed: boolean } {
        let changed = false;
        let inString = false;
        let isEscaped = false;
        let output = '';

        for (const char of input) {
            if (!inString) {
                if (char === '"') {
                    inString = true;
                }
                output += char;
                continue;
            }

            if (isEscaped) {
                output += char;
                isEscaped = false;
                continue;
            }

            if (char === '\\') {
                output += char;
                isEscaped = true;
                continue;
            }

            if (char === '"') {
                inString = false;
                output += char;
                continue;
            }

            const code = char.charCodeAt(0);
            if (code <= 0x1f) {
                changed = true;
                switch (char) {
                    case '\b':
                        output += '\\b';
                        break;
                    case '\f':
                        output += '\\f';
                        break;
                    case '\n':
                        output += '\\n';
                        break;
                    case '\r':
                        output += '\\r';
                        break;
                    case '\t':
                        output += '\\t';
                        break;
                    default:
                        output += `\\u${code.toString(16).padStart(4, '0')}`;
                        break;
                }
                continue;
            }

            output += char;
        }

        return { text: output, changed };
    }

    /**
     * Preprocess SSE response, fix non-standard format
     * Fix issue where some models output "data:" without trailing space
     */
    private async preprocessSSEResponse(response: Response): Promise<Response> {
        const contentType = response.headers.get('Content-Type');

        // For responses with non-200 status code, try to read error information
        if (!response.ok && response.status >= 400) {
            const text = await response.text();
            let errorMessage = text || `HTTP ${response.status} ${response.statusText}`;

            // Try to parse JSON format error
            if (text && text.trim().startsWith('{')) {
                try {
                    const errorJson = JSON.parse(text);
                    if (errorJson.error) {
                        if (typeof errorJson.error === 'string') {
                            errorMessage = errorJson.error;
                        } else if (errorJson.error.message) {
                            errorMessage = errorJson.error.message;
                        }
                    }
                } catch {
                    // If parsing fails, use original text
                }
            }

            // Throw Error containing detailed error information
            const error = new Error(errorMessage);
            (error as APIErrorWithError).status = response.status;
            (error as APIErrorWithError).headers = response.headers;
            throw error;
        }

        // If returning application/json, read body and directly throw Error, let upper-layer chat receive the exception
        if (contentType && contentType.includes('application/json')) {
            const text = await response.text();
            // Directly throw Error (upper layer will catch and display), do not swallow or construct fake Response yourself
            // Try to parse error message, extract useful information
            let errorMessage = text || `HTTP ${response.status} ${response.statusText}`;
            try {
                const errorJson = JSON.parse(text);
                if (errorJson.error) {
                    if (typeof errorJson.error === 'string') {
                        errorMessage = errorJson.error;
                    } else if (errorJson.error.message) {
                        errorMessage = errorJson.error.message;
                    }
                }
            } catch {
                // If parsing fails, use original text
            }
            throw new Error(errorMessage);
        }
        // Only process SSE responses, return original response directly for other types
        if (!contentType || !contentType.includes('text/event-stream') || !response.body) {
            return response;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        const displayName = this.displayName;
        const escapeControlCharsInJsonString = this.escapeControlCharsInJsonString.bind(this);
        const processSSELine = (line: string): string => {
            const normalizedLine = line.replace(/^data:([^\s])/g, 'data: $1');
            if (!normalizedLine.startsWith('data:')) {
                return normalizedLine;
            }

            const dataMatch = normalizedLine.match(/^data:\s?(.*)$/);
            if (!dataMatch) {
                return normalizedLine;
            }

            const jsonStr = dataMatch[1];
            if (!jsonStr || jsonStr === '[DONE]') {
                return normalizedLine;
            }

            let candidateJson = jsonStr;
            try {
                let obj: ParsedSSEChunk;
                try {
                    obj = JSON.parse(candidateJson) as ParsedSSEChunk;
                } catch (parseError) {
                    const escaped = escapeControlCharsInJsonString(candidateJson);
                    if (!escaped.changed) {
                        throw parseError;
                    }
                    candidateJson = escaped.text;
                    obj = JSON.parse(candidateJson) as ParsedSSEChunk;
                    Logger.debug(`${displayName} SSE event contains unescaped control characters, automatically fixed and continuing parsing`);
                }

                let objModified = false;

                //#region OpenAI Chat Completion compatibility handling
                if (obj && Array.isArray(obj.choices)) {
                    for (const ch of obj.choices) {
                        if (ch && ch.message && (!ch.delta || Object.keys(ch.delta).length === 0)) {
                            ch.delta = ch.message;
                            delete ch.message;
                            objModified = true;
                        }
                    }
                }

                if (obj.choices && obj.choices.length > 0) {
                    for (let choiceIndex = obj.choices.length - 1; choiceIndex >= 0; choiceIndex--) {
                        const choice = obj.choices[choiceIndex];
                        if (choice?.finish_reason) {
                            if (!choice.delta || Object.keys(choice.delta).length === 0) {
                                Logger.trace(
                                    `preprocessSSEResponse only has finish_reason (choice ${choiceIndex}), adding empty content to delta`
                                );
                                choice.delta = { role: 'assistant', content: '' };
                                objModified = true;
                            }
                            if (!choice.delta.role) {
                                choice.delta.role = 'assistant';
                                objModified = true;
                            }
                        }
                        if (choice?.delta && Object.keys(choice.delta).length === 0) {
                            if (choice?.finish_reason) {
                                continue;
                            }
                            Logger.trace(`preprocessSSEResponse removing invalid delta (choice ${choiceIndex})`);
                            obj.choices.splice(choiceIndex, 1);
                            objModified = true;
                        }
                    }

                    if (obj.choices.length === 1) {
                        for (const choice of obj.choices) {
                            if (choice.index == null || choice.index !== 0) {
                                choice.index = 0;
                                objModified = true;
                            }
                        }
                    }
                }
                //#endregion

                //#region OpenAI Response event compatibility handling
                if (obj.type === 'response.created' && obj.response?.object === 'response') {
                    if (!Array.isArray(obj.response.output)) {
                        obj.response.output = [];
                        objModified = true;
                    }
                } else if (
                    obj.type === 'response.output_item.added' &&
                    obj.item?.type === 'message' &&
                    !Array.isArray(obj.item.content)
                ) {
                    obj.item.content = [];
                    objModified = true;
                } else if (obj.type === 'response.content_part.added' && obj.output_index == null) {
                    obj.output_index = 0;
                    objModified = true;
                }
                //#endregion

                if (objModified || candidateJson !== jsonStr) {
                    return `data: ${JSON.stringify(obj)}`;
                }

                return normalizedLine;
            } catch (parseError) {
                Logger.trace(`JSON parsing failed: ${parseError}`);
                return normalizedLine;
            }
        };

        // Line buffer: used to accumulate incomplete SSE lines
        let lineBuffer = '';

        const transformedStream = new ReadableStream({
            start: async controller => {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            // At stream end, process remaining content in buffer
                            if (lineBuffer.trim().length > 0) {
                                Logger.trace(`Stream end, processing remaining buffer content: ${lineBuffer.length} characters`);
                                const remaining = processSSELine(lineBuffer);
                                controller.enqueue(encoder.encode(remaining));
                            }
                            controller.close();
                            break;
                        }

                        // Decode chunk
                        const chunk = decoder.decode(value, { stream: true });
                        // Append new content to buffer
                        lineBuffer += chunk;

                        // Split by line, keep last line (may be incomplete)
                        const lines = lineBuffer.split(/\n/);
                        // Keep last element (may be incomplete line)
                        const lastLine = lines.pop() || '';
                        lineBuffer = lastLine;

                        // Process complete lines
                        if (lines.length > 0) {
                            const processedChunk = `${lines.map(processSSELine).join('\n')}\n`;

                            // Logger.trace(`Preprocessed SSE chunk: ${processedChunk.length} characters`);
                            // Re-encode and pass valid content
                            controller.enqueue(encoder.encode(processedChunk));
                        }
                    }
                } catch (error) {
                    // Ensure errors can be correctly propagated
                    controller.error(error);
                } finally {
                    reader.releaseLock();
                }
            },
            cancel() {
                // When stream is cancelled, ensure reader is released
                reader.releaseLock();
            }
        });

        return new Response(transformedStream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });
    }

    /**
     * Handle chat completion request - Use OpenAI SDK streaming interface
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
        Logger.debug(`${model.name} Starting to process ${this.displayName} request`);
        // Clear event deduplication tracker for current request
        this.currentRequestProcessedEvents.clear();
        try {
            const client = await this.createOpenAIClient(modelConfig);
            Logger.debug(`${model.name} Sending ${messages.length} messages, using ${this.displayName}`);
            // Prefer model-specific request model name, fallback to model ID if not available
            const requestModel = modelConfig.model || modelConfig.id;
            const createParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
                model: requestModel,
                // capabilities are already included in modelConfig, prefer config for message conversion
                messages: this.convertMessagesToOpenAI(messages, modelConfig),
                max_tokens: ConfigManager.getMaxTokensForModel(model.maxOutputTokens),
                stream: true,
                stream_options: { include_usage: true }
            };

            // Add tool support (if any)
            if (options.tools && options.tools.length > 0 && modelConfig.capabilities?.toolCalling) {
                createParams.tools = this.convertToolsToOpenAI([...options.tools]);
                Logger.trace(`${model.name} Added ${options.tools.length} tools`);
            }

            // Merge extraBody parameters (if any)
            if (modelConfig.extraBody) {
                // Filter out non-modifiable core parameters
                const filteredExtraBody = OpenAIHandler.filterExtraBodyParams(modelConfig.extraBody);
                Object.assign(createParams, filteredExtraBody);
                if (Object.keys(filteredExtraBody).length > 0) {
                    Logger.trace(`${model.name} Merged extraBody parameters: ${JSON.stringify(filteredExtraBody)}`);
                }
            }

            // Set thinking mode and reasoning length based on model config
            const settings = options.modelConfiguration as ModelChatResponseOptions;
            const customParams = createParams as unknown as {
                enable_thinking?: boolean;
                thinking?: { type: 'enabled' | 'disabled' };
                reasoning_effort?: string;
            };
            // Determine thinking format: default to boolean format
            const thinkingFormat = modelConfig.thinkingFormat ?? 'boolean';
            if (settings) {
                if (settings.thinking) {
                    if (settings.thinking === 'enabled') {
                        if (thinkingFormat === 'object') {
                            customParams.thinking = { type: 'enabled' };
                        } else {
                            customParams.enable_thinking = true;
                        }
                    } else if (settings.thinking === 'disabled') {
                        if (thinkingFormat === 'object') {
                            customParams.thinking = { type: 'disabled' };
                        } else {
                            customParams.enable_thinking = false;
                        }
                    } else {
                        // auto/adaptive mode does not set specific value
                        if (thinkingFormat === 'object') {
                            customParams.thinking = undefined;
                        } else {
                            customParams.enable_thinking = undefined;
                        }
                    }
                }
                if (settings.reasoningEffort) {
                    if (settings.reasoningEffort === 'none') {
                        customParams.reasoning_effort = undefined;
                        if (modelConfig.thinkingFormat === 'object') {
                            customParams.thinking = { type: 'disabled' };
                        }
                    } else {
                        customParams.reasoning_effort = settings.reasoningEffort;
                        if (modelConfig.thinkingFormat === 'object' && settings.reasoningEffort !== 'minimal') {
                            customParams.thinking = { type: 'enabled' };
                        }
                    }
                }
            }
            // If in commit mode and model supports thinking, disable thinking mode
            const modelOpts = options.modelOptions as CommitChatModelOptions;
            if (modelOpts?.commit) {
                if (thinkingFormat === 'object') {
                    if (customParams.thinking) {
                        customParams.thinking = { type: 'disabled' };
                    }
                    // Also remove reasoning_effort to avoid conflict with thinking=disabled
                    customParams.reasoning_effort = undefined;
                } else {
                    if (customParams.enable_thinking) {
                        customParams.enable_thinking = false;
                    }
                }
                if (customParams.thinking === undefined && customParams.reasoning_effort) {
                    let effort: 'none' | 'minimal' | undefined;
                    if (modelConfig.reasoningEffort?.includes('none')) {
                        effort = 'none';
                    } else if (modelConfig.reasoningEffort?.includes('minimal')) {
                        effort = 'minimal';
                    }
                    // Only pass reasoning_effort when disabled option is first in model configuration, to avoid conflict with thinking
                    if (effort && modelConfig.reasoningEffort?.indexOf(effort) === 0) {
                        customParams.enable_thinking = undefined;
                        customParams.reasoning_effort = effort;
                    }
                }
            }

            Logger.info(`🚀 ${model.name} Sending ${this.displayName} request`);

            // Create unified stream reporter
            const reporter = new StreamReporter({
                modelName: model.name,
                modelId: model.id,
                provider: this.provider,
                sdkMode: 'openai',
                progress
            });

            // Use OpenAI SDK's event-driven streaming method, utilize built-in tool call handling
            // Convert vscode.CancellationToken to AbortSignal
            const abortController = new AbortController();
            const cancellationListener = token.onCancellationRequested(() => abortController.abort());
            let streamError: Error | null = null; // Used to capture stream errors
            // Save usage information from last chunk (if any), some providers return usage in each chunk
            let finalUsage: OpenAI.Completions.CompletionUsage | undefined = undefined;
            // Record stream processing start and end times
            let streamStartTime: number | undefined = undefined;
            let streamEndTime: number | undefined = undefined;

            try {
                const stream = client.chat.completions.stream(createParams, { signal: abortController.signal });
                // Utilize SDK's built-in event system to handle tool calls and content
                stream
                    .on('chunk', (chunk, _snapshot: unknown) => {
                        // Record time of first chunk as stream start time
                        if (streamStartTime === undefined) {
                            streamStartTime = Date.now();
                        }

                        // Process token usage statistics: only save to finalUsage, output uniformly at the end
                        if (chunk.usage) {
                            // Directly save SDK-returned usage object (type is CompletionUsage)
                            finalUsage = chunk.usage;
                        }

                        // Process thinking content (reasoning_content) and compatible old format: some models put final result in choice.message
                        // Chain-of-thought is reentrant: output when encountered; need to end current chain-of-thought (done) before first visible content output
                        if (chunk.choices && chunk.choices.length > 0) {
                            // Iterate all choices, process reasoning_content and message.content of each choice
                            for (const choice of chunk.choices) {
                                const extendedChoice = choice as ExtendedChoice;
                                const delta = extendedChoice.delta as ExtendedDelta | undefined;
                                const message = extendedChoice.message;

                                // Process tool calls - support accumulated processing of chunked data
                                if (delta?.tool_calls && delta.tool_calls.length > 0) {
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

                                // Compatible: prefer reasoning_content in delta, otherwise try reading from message
                                const reasoningContent = delta?.reasoning_content ?? message?.reasoning_content;
                                if (reasoningContent) {
                                    reporter.bufferThinking(reasoningContent);
                                }

                                // Check if there is delta.content (text content) in the same chunk
                                const deltaContent = delta?.content;
                                if (deltaContent && typeof deltaContent === 'string') {
                                    reporter.reportText(deltaContent);
                                }

                                // Additional compatibility: if server puts final text in message.content (old/hybrid format), treat as content delta
                                const messageContent = message?.content;
                                if (typeof messageContent === 'string' && messageContent.length > 0) {
                                    reporter.reportText(messageContent);
                                }
                            }
                        }
                    })
                    .on('error', (error: Error) => {
                        // Save error, and abort request
                        streamError = error;
                        abortController.abort();
                    });
                // Wait for stream processing to complete
                await stream.done();

                // Record stream end time
                streamEndTime = Date.now();

                // Stream ended, output all remaining content
                reporter.flushAll(null);

                // Check if there is stream error
                if (streamError) {
                    throw streamError;
                }

                // Calculate and record output speed
                const usageData = finalUsage as OpenAI.Completions.CompletionUsage | undefined;
                if (usageData && streamStartTime && streamEndTime) {
                    const duration = streamEndTime - streamStartTime;
                    const outputTokens = usageData.completion_tokens ?? 0;
                    const speed = duration > 0 ? ((outputTokens / duration) * 1000).toFixed(1) : 'N/A';
                    Logger.info(
                        `📊 ${model.name} OpenAI request completed, output=${outputTokens} tokens, elapsed=${duration}ms, speed=${speed} tokens/s`,
                        usageData
                    );
                } else {
                    Logger.info(`📊 ${model.name} OpenAI request completed`, finalUsage);
                }

                if (requestId) {
                    // === Token statistics: Update actual tokens ===
                    try {
                        const usagesManager = TokenUsagesManager.instance;
                        // Pass raw usage object directly, including stream timing information
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

                Logger.debug(`${model.name} ${this.displayName} SDK stream processing completed`);
            } catch (streamError) {
                if (
                    token.isCancellationRequested ||
                    streamError instanceof vscode.CancellationError ||
                    streamError instanceof OpenAI.APIUserAbortError ||
                    (streamError instanceof Error && streamError.name === 'AbortError')
                ) {
                    Logger.info(`${model.name} Request cancelled by user`);
                    throw new vscode.CancellationError();
                } else {
                    Logger.error(`${model.name} SDK stream processing error: ${streamError}`);
                    throw streamError;
                }
            } finally {
                cancellationListener.dispose();
            }

            Logger.debug(`✅ ${model.name} ${this.displayName} request completed`);
        } catch (error) {
            if (
                token.isCancellationRequested ||
                error instanceof vscode.CancellationError ||
                error instanceof OpenAI.APIUserAbortError ||
                (error instanceof Error && error.name === 'AbortError')
            ) {
                throw new vscode.CancellationError();
            }

            if (error instanceof Error) {
                if (error.cause instanceof Error) {
                    const errorMessage = error.cause.message || 'Unknown error';
                    Logger.error(`${model.name} ${this.displayName} request failed: ${errorMessage}`);
                    throw error.cause;
                } else {
                    let errorMessage = error.message || 'Unknown error';

                    // Try to extract detailed error information from OpenAI SDK's APIError
                    // APIError object has an error property containing original API error response
                    const apiError = error as APIErrorWithError;
                    if (apiError.error && typeof apiError.error === 'object') {
                        const errorDetail = apiError.error as APIErrorDetail;
                        if (errorDetail.message && typeof errorDetail.message === 'string') {
                            errorMessage = errorDetail.message;
                            Logger.debug(`${model.name} Extracted detailed error information from APIError.error: ${errorMessage}`);
                        }
                    }

                    // Try to extract detailed error information from error.cause
                    // APIConnectionError may contain original error in cause
                    if (error.cause instanceof Error) {
                        const causeMessage = error.cause.message || '';
                        if (causeMessage && causeMessage !== errorMessage) {
                            errorMessage = causeMessage;
                            Logger.debug(`${model.name} Extracted detailed error information from error.cause: ${errorMessage}`);
                            throw error.cause;
                        }
                    }

                    Logger.error(`${model.name} ${this.displayName} request failed: ${errorMessage}`);

                    // Check if statusCode error, if so ensure synchronous throw
                    if (
                        errorMessage.includes('502') ||
                        errorMessage.includes('Bad Gateway') ||
                        errorMessage.includes('500') ||
                        errorMessage.includes('Internal Server Error') ||
                        errorMessage.includes('503') ||
                        errorMessage.includes('Service Unavailable') ||
                        errorMessage.includes('504') ||
                        errorMessage.includes('Gateway Timeout')
                    ) {
                        // For server errors, throw original error directly to terminate conversation
                        throw new vscode.LanguageModelError(errorMessage);
                    }

                    // For normal errors, also need to re-throw
                    throw error;
                }
            }

            // Improved error handling, referencing official examples
            if (error instanceof vscode.CancellationError) {
                // Cancellation error does not need extra processing, directly re-throw
                throw error;
            } else if (error instanceof vscode.LanguageModelError) {
                Logger.debug(`LanguageModelError details: code=${error.code}, cause=${error.cause}`);
                // Use string comparison based on official examples' error handling pattern
                if (error.code === 'blocked') {
                    Logger.warn('Request blocked, may contain inappropriate content');
                } else if (error.code === 'noPermissions') {
                    Logger.warn('Insufficient permissions, please check API key and model access permissions');
                } else if (error.code === 'notFound') {
                    Logger.warn('Model not found or unavailable');
                } else if (error.code === 'quotaExceeded') {
                    Logger.warn('Quota exceeded, please check API usage limits');
                } else if (error.code === 'unknown') {
                    Logger.warn('Unknown language model error');
                }
                throw error;
            } else {
                // Other error types
                throw error;
            }
        }
    }

    /**
     * Message conversion referencing official implementation - Use OpenAI SDK standard mode
     * Support text, images and tool calls
     * Public method, can be reused by other Providers
     */
    convertMessagesToOpenAI(
        messages: readonly vscode.LanguageModelChatMessage[],
        modelConfig?: ModelConfig
    ): OpenAI.Chat.ChatCompletionMessageParam[] {
        const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];
        for (const message of messages) {
            const convertedMessage = this.convertSingleMessage(message, modelConfig);
            if (convertedMessage) {
                if (Array.isArray(convertedMessage)) {
                    result.push(...convertedMessage);
                } else {
                    result.push(convertedMessage);
                }
            }
        }
        return result;
    }

    /**
     * Convert single message - Reference OpenAI SDK official pattern
     */
    public convertSingleMessage(
        message: vscode.LanguageModelChatMessage,
        modelConfig?: ModelConfig
    ): OpenAI.Chat.ChatCompletionMessageParam | OpenAI.Chat.ChatCompletionMessageParam[] | null {
        switch (message.role) {
            case vscode.LanguageModelChatMessageRole.System:
                return this.convertSystemMessage(message);
            case vscode.LanguageModelChatMessageRole.User:
                return this.convertUserMessage(message, modelConfig);
            case vscode.LanguageModelChatMessageRole.Assistant:
                return this.convertAssistantMessage(message, modelConfig);
            default:
                Logger.warn(`Unknown message role: ${message.role}`);
                return null;
        }
    }

    /**
     * Convert system message - Reference official ChatCompletionSystemMessageParam
     */
    private convertSystemMessage(
        message: vscode.LanguageModelChatMessage
    ): OpenAI.Chat.ChatCompletionSystemMessageParam | null {
        const textContent = this.extractTextContent(message.content);
        if (!textContent) {
            return null;
        }
        return {
            role: 'system',
            content: textContent
        };
    }

    /**
     * Convert user message - Support multimodal and tool results
     */
    private convertUserMessage(
        message: vscode.LanguageModelChatMessage,
        modelConfig?: ModelConfig
    ): OpenAI.Chat.ChatCompletionMessageParam[] {
        const results: OpenAI.Chat.ChatCompletionMessageParam[] = [];
        // Process text and image content
        const userMessage = this.convertUserContentMessage(message, modelConfig);
        if (userMessage) {
            results.push(userMessage);
        }
        // Process tool results
        const toolMessages = this.convertToolResultMessages(message);
        results.push(...toolMessages);
        return results;
    }

    /**
     * Convert user content message (text + images)
     */
    private convertUserContentMessage(
        message: vscode.LanguageModelChatMessage,
        modelConfig?: ModelConfig
    ): OpenAI.Chat.ChatCompletionUserMessageParam | null {
        const textParts = message.content.filter(
            part => part instanceof vscode.LanguageModelTextPart
        ) as vscode.LanguageModelTextPart[];
        const imageParts: vscode.LanguageModelDataPart[] = [];
        // Collect images (if supported)
        if (modelConfig?.capabilities?.imageInput === true) {
            // Logger.debug('🖼️ Model supports image input, starting to collect image parts');
            for (const part of message.content) {
                if (part instanceof vscode.LanguageModelDataPart) {
                    // Logger.debug(`📷 Found data part: MIME=${part.mimeType}, size=${part.data.length}bytes`);
                    if (this.isImageMimeType(part.mimeType)) {
                        imageParts.push(part);
                        Logger.debug(`✅ Add image: MIME=${part.mimeType}, size=${part.data.length}bytes`);
                    } else {
                        // // Classify and process different types of data
                        // if (part.mimeType === 'cache_control') {
                        //     Logger.trace('⚠️ Ignore Claude cache identifier: cache_control');
                        // } else if (part.mimeType.startsWith('image/')) {
                        //     Logger.warn(`❌ Unsupported image MIME type: ${part.mimeType}`);
                        // } else {
                        //     Logger.trace(`📄 Skip non-image data: ${part.mimeType}`);
                        // }
                    }
                } else {
                    // Logger.trace(`📝 Non-data part: ${part.constructor.name}`);
                }
            }
        }
        // If no text and image content, return null
        if (textParts.length === 0 && imageParts.length === 0) {
            return null;
        }
        if (imageParts.length > 0) {
            // Multimodal message: text + images
            Logger.debug(`🖼️ Build multimodal message: ${textParts.length} text parts + ${imageParts.length} image parts`);
            const contentArray: OpenAI.Chat.ChatCompletionContentPart[] = [];
            if (textParts.length > 0) {
                const textContent = textParts.map(part => part.value).join('\n');
                contentArray.push({
                    type: 'text',
                    text: textContent
                });
                Logger.trace(`📝 Add text content: ${textContent.length} characters`);
            }
            for (const imagePart of imageParts) {
                const dataUrl = this.createDataUrl(imagePart);
                contentArray.push({
                    type: 'image_url',
                    image_url: { url: dataUrl }
                });
                Logger.trace(`📷 Add image URL: MIME=${imagePart.mimeType}, Base64 length=${dataUrl.length} characters`);
            }
            Logger.debug(`✅ Multimodal message build complete: ${contentArray.length} content parts`);
            return { role: 'user', content: contentArray };
        } else {
            // Plain text message
            return {
                role: 'user',
                content: textParts.map(part => part.value).join('\n')
            };
        }
    }

    /**
     * Convert tool result message - Use OpenAI SDK standard types
     */
    private convertToolResultMessages(
        message: vscode.LanguageModelChatMessage
    ): OpenAI.Chat.ChatCompletionToolMessageParam[] {
        const toolMessages: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];
        const seenCallIds = new Set<string>();

        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelToolResultPart) {
                if (seenCallIds.has(part.callId)) {
                    Logger.warn(`Skip duplicate tool_result callId: ${part.callId}`);
                    continue;
                }
                seenCallIds.add(part.callId);
                const toolContent = this.convertToolResultContent(part.content);
                // Use OpenAI SDK standard ChatCompletionToolMessageParam type
                const toolMessage: OpenAI.Chat.ChatCompletionToolMessageParam = {
                    role: 'tool',
                    content: toolContent,
                    tool_call_id: part.callId
                };
                toolMessages.push(toolMessage);
                // Logger.debug(`Add tool result: callId=${part.callId}, content length=${toolContent.length}`);
            }
        }

        return toolMessages;
    }

    /**
     * Convert assistant message - Process text and tool calls
     */
    private convertAssistantMessage(
        message: vscode.LanguageModelChatMessage,
        modelConfig?: ModelConfig
    ): OpenAI.Chat.ChatCompletionAssistantMessageParam | null {
        const textContent = this.extractTextContent(message.content);
        const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
        let thinkingContent: string | null = null;
        const reasoningReplayPolicy = getReasoningReplayPolicy({
            providerKey: this.provider,
            modelConfig: modelConfig
        });

        // Process tool calls and thinking content (deduplicate: keep only first for same callId)
        const seenCallIds = new Set<string>();
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelToolCallPart) {
                if (seenCallIds.has(part.callId)) {
                    Logger.warn(`Skip duplicate tool_call_id: ${part.callId} (${part.name})`);
                    continue;
                }
                seenCallIds.add(part.callId);
                toolCalls.push({
                    id: part.callId,
                    type: 'function',
                    function: {
                        name: part.name,
                        arguments: JSON.stringify(part.input)
                    }
                });
            }
        }

        // Extract thinking content from message (if exists), for compatibility with some gateway/model context passing.
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelThinkingPart) {
                // Process thinking content, may be string or string array
                if (Array.isArray(part.value)) {
                    thinkingContent = part.value.join('');
                } else {
                    thinkingContent = part.value;
                }
                Logger.trace(`Extracted thinking content: ${thinkingContent.length} characters`);
                break; // Take only first thinking content part
            }
        }

        // If ThinkingPart is stripped by VS Code, restore reasoning_content needed for compatible models from StatefulMarker
        if (!thinkingContent && reasoningReplayPolicy.restoreFromStatefulMarker) {
            const markerReasoning = getMarkerReasoningState(message.content);
            if (markerReasoning.completeThinking) {
                thinkingContent = markerReasoning.completeThinking;
                Logger.trace(`Restored reasoning_content from StatefulMarker: ${thinkingContent.length} characters`);
            } else if (
                shouldInjectReasoningPlaceholder(
                    reasoningReplayPolicy,
                    toolCalls.length > 0,
                    markerReasoning.hasToolCalls
                )
            ) {
                thinkingContent = ' '; // Fallback placeholder, avoid compatibility interface directly erroring due to missing fields
                Logger.trace('StatefulMarker thinking not found, using placeholder to fill reasoning_content');
            }
        }

        // If there is no text content, thinking content, and tool calls, return null
        if (!textContent && !thinkingContent && toolCalls.length === 0) {
            return null;
        }

        // Create extended assistant message supporting reasoning_content field
        const assistantMessage: ExtendedAssistantMessageParam = {
            role: 'assistant',
            content: textContent || null // Contains only normal text content, does not contain thinking content
        };

        // If there is thinking content, add to reasoning_content field
        if (thinkingContent) {
            assistantMessage.reasoning_content = thinkingContent;
            Logger.trace(`Add reasoning_content: ${thinkingContent.length} characters`);
        }

        if (toolCalls.length > 0) {
            assistantMessage.tool_calls = toolCalls;
            // Logger.debug(`Assistant message contains ${toolCalls.length} tool calls`);
        }

        return assistantMessage;
    }

    /**
     * Extract text content
     */
    private extractTextContent(
        content: readonly (
            | vscode.LanguageModelTextPart
            | vscode.LanguageModelDataPart
            | vscode.LanguageModelToolCallPart
            | vscode.LanguageModelToolResultPart
            | vscode.LanguageModelThinkingPart
        )[]
    ): string | null {
        const textParts = content
            .filter(part => part instanceof vscode.LanguageModelTextPart)
            .map(part => (part as vscode.LanguageModelTextPart).value);
        return textParts.length > 0 ? textParts.join('\n') : null;
    }

    /**
     * Convert tool result content
     */
    private convertToolResultContent(content: unknown): string {
        if (typeof content === 'string') {
            return content;
        }

        if (Array.isArray(content)) {
            return content
                .map(resultPart => {
                    if (resultPart instanceof vscode.LanguageModelTextPart) {
                        return resultPart.value;
                    }
                    return JSON.stringify(resultPart);
                })
                .join('\n');
        }

        return JSON.stringify(content);
    }

    /**
     * Tool conversion - ensure parameter format is correct
     * Public method, can be reused by other Providers
     */
    public convertToolsToOpenAI(tools: vscode.LanguageModelChatTool[]): OpenAI.Chat.ChatCompletionTool[] {
        return tools.map(tool => {
            const functionDef: OpenAI.Chat.ChatCompletionTool = {
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description || ''
                }
            };

            // Process parameter schema
            if (tool.inputSchema) {
                if (typeof tool.inputSchema === 'object' && tool.inputSchema !== null) {
                    functionDef.function.parameters = sanitizeToolSchemaForTarget(
                        tool.inputSchema as Record<string, unknown>,
                        'openai'
                    );
                } else {
                    // If not an object, provide default schema
                    functionDef.function.parameters = {
                        type: 'object',
                        properties: {},
                        required: []
                    };
                }
            } else {
                // Default schema
                functionDef.function.parameters = {
                    type: 'object',
                    properties: {},
                    required: []
                };
            }

            return functionDef;
        });
    }

    /**
     * Check if image MIME type
     */
    public isImageMimeType(mimeType: string): boolean {
        // Normalize MIME type
        const normalizedMime = mimeType.toLowerCase().trim();
        // Supported image types
        const supportedTypes = [
            'image/jpeg',
            'image/jpg',
            'image/png',
            'image/gif',
            'image/webp',
            'image/bmp',
            'image/svg+xml'
        ];
        const isImageCategory = normalizedMime.startsWith('image/');
        const isSupported = supportedTypes.includes(normalizedMime);
        // Debug logging
        if (isImageCategory && !isSupported) {
            Logger.warn(`🚫 Image type not in supported list: ${mimeType}, supported types: ${supportedTypes.join(', ')}`);
        } else if (!isImageCategory && normalizedMime !== 'cache_control') {
            // For cache_control (Claude cache identifier) do not log debug information, for other non-image types log at trace level
            // Logger.trace(`📄 Non-image data type: ${mimeType}`);
        }
        return isImageCategory && isSupported;
    }

    /**
     * Create data URL for image
     */
    public createDataUrl(dataPart: vscode.LanguageModelDataPart): string {
        try {
            const base64Data = Buffer.from(dataPart.data).toString('base64');
            const dataUrl = `data:${dataPart.mimeType};base64,${base64Data}`;
            Logger.debug(
                `🔗 Create image DataURL: MIME=${dataPart.mimeType}, original size=${dataPart.data.length}bytes, Base64 size=${base64Data.length}characters`
            );
            return dataUrl;
        } catch (error) {
            Logger.error(`❌ Failed to create image DataURL: ${error}`);
            throw error;
        }
    }

    /**
     * Filter immutable core parameters in extraBody
     * @param extraBody Original extraBody parameters
     * @returns Filtered parameters, with immutable core parameters removed
     */
    public static filterExtraBodyParams(extraBody: Record<string, unknown>): Record<string, unknown> {
        const coreParams = new Set([
            'model', // Model name
            'messages', // Message array
            'stream', // Streaming switch
            'stream_options', // Streaming options
            'tools' // Tool definitions
        ]);

        const filtered: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(extraBody)) {
            if (!coreParams.has(key)) {
                filtered[key] = value;
                if (value == null) {
                    filtered[key] = undefined;
                }
            }
        }

        return filtered;
    }
}

/**
 * Extract completeThinking from StatefulMarker of message content
 */
function getMarkerReasoningState(content: vscode.LanguageModelChatMessage['content']): {
    completeThinking?: string;
    hasToolCalls?: boolean;
} {
    for (const part of content) {
        if (
            part instanceof vscode.LanguageModelDataPart &&
            part.mimeType === CustomDataPartMimeTypes.StatefulMarker &&
            part.data instanceof Uint8Array
        ) {
            const marker = decodeStatefulMarker(part.data)?.marker;
            if (marker) {
                return {
                    completeThinking: marker.completeThinking,
                    hasToolCalls: marker.hasToolCalls
                };
            }
        }
    }
    return {};
}

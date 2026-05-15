/*---------------------------------------------------------------------------------------------
 *  OpenAI Responses API Handler
 *  Specifically handles message conversion and request processing for OpenAI Responses API
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import OpenAI, { ClientOptions } from 'openai';
import { TokenUsagesManager } from '../usages/usagesManager';
import { Logger, sanitizeToolSchemaForTarget } from '../utils';
import { ModelChatResponseOptions, ModelConfig } from '../types/sharedTypes';
import { OpenAIHandler } from './openaiHandler';
import { getStatefulMarkerAndIndex } from './statefulMarker';
import { StreamReporter } from './streamReporter';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';
import { CodexCliAuth } from '../cli/auth/codexCliAuth';
import type { GenericModelProvider } from '../providers/genericModelProvider';
import type { CommitChatModelOptions } from '../commit';

// Using OpenAI SDK Responses API types
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type ResponseInputMessageItem = OpenAI.Responses.ResponseInputMessageItem;
type ResponseInputText = OpenAI.Responses.ResponseInputText;
type ResponseInputImage = OpenAI.Responses.ResponseInputImage;
type ResponseReasoningItem = OpenAI.Responses.ResponseReasoningItem;
type ResponseFunctionToolCall = OpenAI.Responses.ResponseFunctionToolCall;
type ResponseFunctionToolCallOutputItem = OpenAI.Responses.ResponseFunctionToolCallOutputItem;
type FunctionTool = OpenAI.Responses.FunctionTool;

/**
 * OpenAI Responses API ThinkingPart metadata interface
 * Used to pass encrypted thinking content (encrypted_content) across multi-turn conversations
 */
interface OpenAIResponsesThinkingMetadata {
    /** Encrypted thinking content, returned by OpenAI Responses API when include=["reasoning.encrypted_content"] */
    redactedData?: string;
    /** Original id of reasoning item, used to relay back to API to rebuild reasoning input item */
    reasoningId?: string;
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
 * OpenAI Responses API Handler
 * Specifically handles message conversion and requests for Responses API
 */
export class OpenAIResponsesHandler {
    private handler: OpenAIHandler;
    constructor(
        private providerInstance: GenericModelProvider,
        handler: OpenAIHandler
    ) {
        this.handler = handler;
    }
    private get providerKey(): string {
        return this.providerInstance.provider;
    }
    private get displayName(): string {
        return this.providerInstance.providerConfig.displayName;
    }

    /**
     * Convert vscode messages to OpenAI Responses API format
     * Implemented referencing official Responses API specification
     * Note: Responses API does not support system messages, must pass via instructions parameter
     * @param messages vscode chat message array
     * @param modelConfig Model configuration
     * @returns Object containing system message content and other messages
     */
    public convertMessagesToOpenAIResponses(
        messages: readonly vscode.LanguageModelChatMessage[],
        modelConfig?: ModelConfig
    ): { systemMessage: string; messages: ResponseInputItem[] } {
        const out: ResponseInputItem[] = [];
        let systemMessage = '';

        for (const message of messages) {
            const role = this.mapRole(message.role);
            const textParts: string[] = [];
            const imageParts: vscode.LanguageModelDataPart[] = [];
            const toolCalls: Array<{ id: string; name: string; args: string }> = [];
            const toolResults: Array<{ callId: string; content: string }> = [];
            const thinkingParts: string[] = [];
            const encryptedReasonings: Array<{ encryptedContent: string; reasoningId?: string }> = []; // Collect encrypted thinking content

            // Extract various content types
            for (const part of message.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    textParts.push(part.value);
                } else if (
                    part instanceof vscode.LanguageModelDataPart &&
                    this.handler.isImageMimeType(part.mimeType)
                ) {
                    if (modelConfig?.capabilities?.imageInput === true) {
                        imageParts.push(part);
                    } else {
                        // When model does not support images, add placeholder
                        textParts.push('[Image]');
                    }
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    const id = part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                    let args = '{}';
                    try {
                        args = JSON.stringify(part.input ?? {});
                    } catch {
                        args = '{}';
                    }
                    toolCalls.push({ id, name: part.name, args });
                } else if (part instanceof vscode.LanguageModelToolResultPart) {
                    const callId = part.callId ?? '';
                    const content = this.collectToolResultText(part);
                    toolResults.push({ callId, content });
                } else if (part instanceof vscode.LanguageModelThinkingPart) {
                    // Check if contains encrypted thinking content (returned when include=["reasoning.encrypted_content"])
                    const metadata = (part as unknown as { metadata?: OpenAIResponsesThinkingMetadata }).metadata;
                    if (metadata?.redactedData) {
                        encryptedReasonings.push({
                            encryptedContent: metadata.redactedData,
                            reasoningId: metadata.reasoningId
                        });
                    } else {
                        const content = Array.isArray(part.value) ? part.value.join('') : part.value;
                        thinkingParts.push(content);
                    }
                }
            }

            const joinedText = textParts.join('').trim();
            const joinedThinking = thinkingParts.join('').trim();

            // Process assistant messages
            if (role === 'assistant') {
                // First push encrypted thinking content items (reasoning items with encrypted_content)
                // These need to be before assistant text messages
                for (const { encryptedContent, reasoningId } of encryptedReasonings) {
                    out.push({
                        type: 'reasoning' as const,
                        // Use saved original id (official implementation uses thinkingData.id)
                        id: reasoningId || `rsn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        summary: [],
                        encrypted_content: encryptedContent
                        // Note: reasoning input items do not accept status field, API will report Unknown parameter error
                    } as unknown as ResponseReasoningItem);
                }

                const assistantText = joinedText || joinedThinking;
                if (assistantText) {
                    // In Responses API, assistant messages use output_text type
                    // Note: In input array, assistant message content must use output_text
                    out.push({
                        type: 'message' as const,
                        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        role: 'assistant' as const,
                        status: 'completed' as const,
                        content: [{ type: 'output_text' as const, text: assistantText }]
                    } as unknown as ResponseInputMessageItem);
                }

                // Add tool calls
                for (const tc of toolCalls) {
                    // Skip tool calls with empty name
                    if (!tc.name || tc.name.trim() === '') {
                        Logger.warn(`${this.displayName} Responses API: Skip tool calls with empty name`);
                        continue;
                    }
                    out.push({
                        type: 'function_call' as const,
                        id: `fc_${tc.id}`,
                        call_id: tc.id,
                        name: tc.name,
                        arguments: tc.args,
                        status: 'completed' as const
                    } as unknown as ResponseFunctionToolCall);
                }
            }

            // Process tool results
            for (const tr of toolResults) {
                if (!tr.callId) {
                    continue;
                }
                out.push({
                    type: 'function_call_output' as const,
                    id: `fco_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    call_id: tr.callId,
                    output: tr.content || '',
                    status: 'completed' as const
                } as unknown as ResponseFunctionToolCallOutputItem);
            }

            // Process user messages
            if (role === 'user') {
                const contentArray: Array<ResponseInputText | ResponseInputImage> = [];
                if (joinedText) {
                    contentArray.push({ type: 'input_text' as const, text: joinedText });
                }
                for (const imagePart of imageParts) {
                    const dataUrl = this.handler.createDataUrl(imagePart);
                    contentArray.push({
                        type: 'input_image' as const,
                        image_url: dataUrl,
                        detail: 'auto' as const
                    });
                }
                if (contentArray.length > 0) {
                    out.push({
                        type: 'message' as const,
                        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        role: 'user' as const,
                        status: 'completed' as const,
                        content: contentArray
                    } as unknown as ResponseInputMessageItem);
                }
            }

            // Process system messages
            // Note: Responses API does not support using system messages in input
            // System messages must be passed via instructions parameter
            if (role === 'system' && joinedText) {
                systemMessage = joinedText;
            }
        }

        // According to Responses API specification, set status of last user message to incomplete
        // This indicates conversation is still ongoing, waiting for model response
        if (out.length > 0) {
            const lastItem = out[out.length - 1];
            if (lastItem && typeof lastItem === 'object' && 'type' in lastItem) {
                const item = lastItem as unknown as Record<string, unknown>;
                if (item.type === 'message' && item.role === 'user') {
                    item.status = 'incomplete';
                    Logger.trace(`${this.displayName} Responses API: Set last user message status to incomplete`);
                }
            }
        }

        return { systemMessage, messages: out };
    }

    /**
     * Map vscode role to standard role
     */
    private mapRole(role: number): 'user' | 'assistant' | 'system' {
        switch (role) {
            case vscode.LanguageModelChatMessageRole.User:
                return 'user';
            case vscode.LanguageModelChatMessageRole.Assistant:
                return 'assistant';
            case vscode.LanguageModelChatMessageRole.System:
                return 'system';
            default:
                return 'user';
        }
    }

    /**
     * Convert vscode tools to OpenAI Responses API format
     * Responses API tool format differs from ChatCompletion API
     * ChatCompletion: { type: 'function', function: { name, description, parameters } }
     * Responses API: { type: 'function', name, description, parameters }
     * @param tools vscode chat tool array
     * @returns FunctionTool array
     */
    private convertToolsToResponses(tools: readonly vscode.LanguageModelChatTool[]): FunctionTool[] {
        return tools.map(tool => {
            const functionTool: FunctionTool = {
                type: 'function',
                name: tool.name,
                description: tool.description || null,
                parameters: null,
                strict: false
            };

            // Process parameter schema
            if (tool.inputSchema) {
                if (typeof tool.inputSchema === 'object' && tool.inputSchema !== null) {
                    functionTool.parameters = sanitizeToolSchemaForTarget(
                        tool.inputSchema as Record<string, unknown>,
                        'openai'
                    );
                } else {
                    // If not object, provide default schema
                    functionTool.parameters = {
                        type: 'object',
                        properties: {},
                        required: []
                    };
                }
            } else {
                // Default schema
                functionTool.parameters = {
                    type: 'object',
                    properties: {},
                    required: []
                };
            }

            return functionTool;
        });
    }

    /**
     * Collect text content of tool results
     */
    public collectToolResultText(part: vscode.LanguageModelToolResultPart): string {
        if (!part.content || part.content.length === 0) {
            return '';
        }

        const texts: string[] = [];
        for (const item of part.content) {
            if (item instanceof vscode.LanguageModelTextPart) {
                texts.push(item.value);
            } else if (item instanceof vscode.LanguageModelDataPart && this.handler.isImageMimeType(item.mimeType)) {
                // Add placeholder for images in tool results
                texts.push('[Image]');
            } else if (item && typeof item === 'object') {
                // Try to convert to string
                try {
                    const str = JSON.stringify(item);
                    if (str && str !== '{}') {
                        texts.push(str);
                    }
                } catch {
                    // Ignore objects that cannot be serialized
                }
            }
        }
        return texts.join('\n');
    }

    /**
     * Filter non-modifiable core parameters from extraBody
     * @param extraBody Original extraBody parameters
     * @returns Filtered parameters, with non-modifiable core parameters removed
     */
    private filterExtraBodyParams(extraBody: Record<string, unknown>): Record<string, unknown> {
        const coreParams = new Set([
            'model', // Model name
            'input', // Input messages
            'stream', // Streaming switch
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

    /**
     * Handle Responses API request - Use OpenAI SDK streaming interface
     * This is the dedicated method for handling openai-responses mode
     */
    async handleResponsesRequest(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken,
        requestId?: string | null
    ): Promise<void> {
        Logger.debug(`${model.name} Starting to process ${this.displayName} Responses API request`);

        try {
            const client = await this.handler.createOpenAIClient(modelConfig);
            Logger.info(`🚀 ${model.name} Sending ${this.displayName} Responses API request`);

            // Create unified stream reporter
            const reporter = new StreamReporter({
                modelName: model.name,
                modelId: model.id,
                provider: this.providerKey,
                sdkMode: 'openai-responses',
                progress
            });

            const requestModel = modelConfig.model || modelConfig.id;

            // Convert vscode.CancellationToken to AbortSignal
            const abortController = new AbortController();
            const cancellationListener = token.onCancellationRequested(() => abortController.abort());
            let streamError: Error | null = null;
            let finalUsage: Record<string, unknown> | undefined = undefined;
            // Record stream processing start and end times
            let streamStartTime = Date.now();
            let streamEndTime: number | undefined = undefined;

            // Responses API specific: Track delta/done events by output item to avoid cross-item false deduplication causing subsequent text to be swallowed
            const textDeltaKeys = new Set<string>();
            const refusalDeltaKeys = new Set<string>();
            const reasoningTextDeltaKeys = new Set<string>();
            const reasoningSummaryDeltaKeys = new Set<string>();
            const reasoningSummaryItemIds = new Set<string>();

            const getContentEventKey = (itemId?: string, contentIndex?: number): string | undefined => {
                if (!itemId) {
                    return undefined;
                }
                return `${itemId}:${contentIndex ?? -1}`;
            };

            const getSummaryEventKey = (itemId?: string, summaryIndex?: number): string | undefined => {
                if (!itemId) {
                    return undefined;
                }
                return `${itemId}:summary:${summaryIndex ?? -1}`;
            };

            // Tool call buffer - Use index tracking, support accumulation
            const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
            const completedToolCallIndices = new Set<number>();
            const toolCallIdToIndex = new Map<string, number>();
            let nextToolCallIndex = 0;

            // Helper function to get tool call index
            const getToolCallIndex = (callId: string): number => {
                if (!toolCallIdToIndex.has(callId)) {
                    toolCallIdToIndex.set(callId, nextToolCallIndex++);
                }
                return toolCallIdToIndex.get(callId)!;
            };

            try {
                // Prepare request body
                // Convert messages to Responses API format
                const { systemMessage, messages: responsesMessages } = this.convertMessagesToOpenAIResponses(
                    messages,
                    modelConfig
                );

                // Prepare request body
                const requestBody: Record<string, unknown> = {
                    model: requestModel,
                    input: responsesMessages,
                    stream: true
                };

                const modelId = (modelConfig.model || modelConfig.id).toLowerCase();
                const isGptModel = modelId.includes('gpt');
                const isDoubaoOrVolcengine = modelId.includes('doubao') || modelConfig?.provider === 'volcengine';

                // Only automatically add include for GPT models with reasoning configured in extraBody
                // extraBody.include can override this value in subsequent Object.assign (including setting to null to disable)
                if (isGptModel && !isDoubaoOrVolcengine && modelConfig?.extraBody?.reasoning) {
                    requestBody.include = ['reasoning.encrypted_content'];
                }

                // Use statefulMarker to get session state
                const markerAndIndex = getStatefulMarkerAndIndex(model.id, 'openai-responses', messages);
                const statefulMarker = markerAndIndex?.statefulMarker;
                const sessionId = statefulMarker?.sessionId || crypto.randomUUID();
                const previousResponseId = statefulMarker?.responseId;
                let sessionExpireAt = statefulMarker?.expireAt;

                // Doubao/Volcengine previous_response_id support
                if (isDoubaoOrVolcengine) {
                    const extraBody: { caching?: { type?: string } } = modelConfig.extraBody || {};
                    if (extraBody?.caching?.type === 'enabled') {
                        if (previousResponseId) {
                            // Check if cache has expired and model matches
                            if (
                                sessionExpireAt &&
                                Date.now() < sessionExpireAt - 5 * 60 * 1000 &&
                                statefulMarker.modelId === model.id
                            ) {
                                requestBody.previous_response_id = previousResponseId;
                                Logger.debug(
                                    `🎯 ${model.name} Using Doubao cache previous_response_id: ${previousResponseId}`
                                );

                                // Truncate message array, only keep new messages after last match position
                                const markerIndex = markerAndIndex?.index ?? -1;
                                const originalMessages = messages as vscode.LanguageModelChatMessage[];
                                if (markerIndex >= 0 && markerIndex < originalMessages.length - 1) {
                                    // Truncate from markerIndex + 1, only send new messages
                                    const newMessages = originalMessages.slice(markerIndex + 1);
                                    // Re-convert messages
                                    const { messages: newResponsesMessages } = this.convertMessagesToOpenAIResponses(
                                        newMessages,
                                        modelConfig
                                    );
                                    requestBody.input = newResponsesMessages;
                                    Logger.debug(
                                        `🎯 ${model.name} Truncated messages from ${originalMessages.length} to ${newMessages.length} (skipped first ${markerIndex + 1} cached messages)`
                                    );
                                }
                            } else {
                                Logger.debug(`🎯 ${model.name} Doubao cache expired, setting new expire_at`);
                                sessionExpireAt = Date.now() + 1 * 3600 * 1000; // Expires in 1 hour
                                requestBody.expire_at = Math.floor(sessionExpireAt / 1000);
                            }
                        } else {
                            // Set expiration time on cache miss
                            sessionExpireAt = Date.now() + 1 * 3600 * 1000; // Expires in 1 hour
                            requestBody.expire_at = Math.floor(sessionExpireAt / 1000);
                        }
                    }
                }
                // GPT/Codex use sessionId as prompt_cache_key
                else {
                    requestBody.prompt_cache_key = sessionId;
                    Logger.debug(`🎯 ${model.name} Using prompt_cache_key: ${sessionId}`);
                }

                const { _options: clientOptions } = client as unknown as { _options: ClientOptions };
                const { defaultHeaders: optHeaders } = clientOptions as { defaultHeaders: Record<string, string> };
                optHeaders['conversation_id'] = optHeaders['session_id'] = sessionId;
                if (this.providerKey === 'codex') {
                    const codexAuth = CliAuthFactory.getInstance('codex') as CodexCliAuth;
                    const accountId = await codexAuth?.getAccountId();
                    if (accountId && accountId.trim()) {
                        optHeaders['chatgpt-account-id'] = accountId.trim();
                    }
                }

                Logger.info(`🎯 ${model.name} Using session_id: ${sessionId}`);

                if (systemMessage) {
                    // Add system message as instructions
                    // Responses API uses instructions parameter instead of system messages
                    if (modelConfig.useInstructions === true) {
                        requestBody.instructions = systemMessage;
                        Logger.debug(`${this.displayName} Responses API: Use instructions parameter to pass system messages`);
                    } else {
                        requestBody.instructions = undefined;
                        // Some forwarding directly uses Codex's instructions parameter, here specifically insert a user message at first position
                        responsesMessages.unshift({
                            type: 'message' as const,
                            role: 'user' as const,
                            content: [{ type: 'input_text' as const, text: systemMessage }]
                        });
                        Logger.debug(`${this.displayName} Responses API: Use user messages to pass system message instructions in input messages`);
                    }
                }

                // tools - Convert and add tool definitions
                if (options?.tools && options.tools.length > 0) {
                    if (!isDoubaoOrVolcengine || !requestBody.previous_response_id) {
                        const tools = this.convertToolsToResponses(options.tools);
                        if (tools.length > 0) {
                            requestBody.tools = tools;
                        }
                    }
                }

                // Process extra configuration parameters from extraBody
                if (modelConfig?.extraBody) {
                    // Filter out non-modifiable core parameters
                    const filteredExtraBody = this.filterExtraBodyParams(modelConfig.extraBody);
                    Object.assign(requestBody, filteredExtraBody);
                }

                // Set thinking mode and reasoning length based on model config
                const settings = options.modelConfiguration as ModelChatResponseOptions;
                const customParams = requestBody as unknown as {
                    thinking?: { type: string };
                    reasoning?: { effort: string };
                };
                if (settings) {
                    if (settings.thinking) {
                        const thinking: { type: string } = customParams.thinking || { type: 'disabled' };
                        thinking.type = settings.thinking;
                        customParams.thinking = thinking;
                    }
                    if (settings.reasoningEffort) {
                        const thinking: { type: string } = customParams.thinking || { type: 'enabled' };
                        thinking.type = 'enabled';
                        const reasoning = customParams.reasoning || { effort: 'medium' };
                        reasoning.effort = settings.reasoningEffort as string;
                        if (settings.reasoningEffort === 'minimal' || settings.reasoningEffort === 'none') {
                            thinking.type = 'disabled';
                        }
                        customParams.thinking = thinking;
                        customParams.reasoning = reasoning;
                        if (model.id.toLowerCase().includes('gpt')) {
                            customParams.thinking = undefined;
                        }
                    }
                }
                // If in commit mode and model supports thinking, disable thinking mode
                const modelOpts = options.modelOptions as CommitChatModelOptions;
                if (modelOpts?.commit) {
                    if (customParams.thinking) {
                        customParams.thinking.type = 'disabled';
                    }
                    if (customParams.reasoning) {
                        let effort: 'none' | 'minimal' | undefined;
                        if (modelConfig.reasoningEffort?.includes('none')) {
                            effort = 'none';
                        } else if (modelConfig.reasoningEffort?.includes('minimal')) {
                            effort = 'minimal';
                        }
                        if (effort) {
                            customParams.reasoning.effort = effort;
                        } else if (modelId.toLowerCase().includes('gpt')) {
                            customParams.reasoning.effort = 'none';
                        }
                    } else if (modelId.toLowerCase().includes('gpt')) {
                        customParams.reasoning = { effort: 'none' };
                    }
                }

                // Call Responses API streaming method
                const stream = client.responses.stream(requestBody, { signal: abortController.signal });

                // Use on(event) mode to handle stream events
                stream
                    .on('response.created', () => {
                        // Response created event - record stream start time
                        streamStartTime = Date.now();
                    })
                    .on('response.output_text.delta', event => {
                        if (token.isCancellationRequested) {
                            abortController.abort();
                            return;
                        }
                        const eventKey = getContentEventKey(event.item_id, event.content_index);
                        if (eventKey) {
                            textDeltaKeys.add(eventKey);
                        }
                        const delta = event.delta;
                        if (delta && typeof delta === 'string') {
                            reporter.reportText(delta);
                        }
                    })
                    .on('response.output_text.done', event => {
                        const eventKey = getContentEventKey(event.item_id, event.content_index);
                        // Some gateways only send final done event (no deltas); deduplication must be handled at output item/content part granularity
                        if (eventKey && textDeltaKeys.has(eventKey)) {
                            return;
                        }
                        const text = event.text || '';
                        if (text) {
                            reporter.reportText(text);
                        }
                    })
                    .on('response.refusal.delta', event => {
                        // Process refusal delta (treat as normal text)
                        if (token.isCancellationRequested) {
                            abortController.abort();
                            return;
                        }
                        const eventKey = getContentEventKey(event.item_id, event.content_index);
                        if (eventKey) {
                            refusalDeltaKeys.add(eventKey);
                        }
                        const delta = event.delta;
                        if (delta && typeof delta === 'string') {
                            reporter.reportText(delta);
                        }
                    })
                    .on('response.refusal.done', event => {
                        // Some gateways only send refusal.done, need fallback output at item/content granularity
                        if (token.isCancellationRequested) {
                            return;
                        }
                        const eventKey = getContentEventKey(event.item_id, event.content_index);
                        if (eventKey && refusalDeltaKeys.has(eventKey)) {
                            return;
                        }
                        const refusal = event.refusal || '';
                        if (refusal) {
                            reporter.reportText(refusal);
                        }
                    })
                    .on('response.reasoning_text.delta', event => {
                        // Process chain-of-thought text delta
                        if (token.isCancellationRequested) {
                            abortController.abort();
                            return;
                        }
                        const eventKey = getContentEventKey(event.item_id, event.content_index);
                        if (eventKey) {
                            reasoningTextDeltaKeys.add(eventKey);
                        }
                        const delta = event.delta;
                        if (delta && typeof delta === 'string') {
                            reporter.bufferThinking(delta);
                        }
                    })
                    .on('response.reasoning_text.done', event => {
                        // Process chain-of-thought text completion
                        if (token.isCancellationRequested) {
                            return;
                        }
                        const eventKey = getContentEventKey(event.item_id, event.content_index);
                        // Some gateways only send final done event (no delta)
                        if ((!eventKey || !reasoningTextDeltaKeys.has(eventKey)) && event.text) {
                            reporter.bufferThinking(event.text);
                        }
                        reporter.flushThinking('reasoning_text complete');
                        reporter.endThinkingChain();
                    })
                    .on('response.reasoning_summary_text.delta', event => {
                        // Process chain-of-thought summary delta (consistent with official implementation: record shown summary to prevent duplication)
                        const eventKey = getSummaryEventKey(event.item_id, event.summary_index);
                        if (eventKey) {
                            reasoningSummaryDeltaKeys.add(eventKey);
                        }
                        if (event.item_id) {
                            reasoningSummaryItemIds.add(event.item_id);
                        }
                        if (token.isCancellationRequested) {
                            abortController.abort();
                            return;
                        }
                        const delta = event.delta;
                        if (delta && typeof delta === 'string') {
                            reporter.bufferThinking(delta);
                        }
                    })
                    .on('response.reasoning_summary_text.done', event => {
                        // Process chain-of-thought summary completion
                        const eventKey = getSummaryEventKey(event.item_id, event.summary_index);
                        if (event.item_id) {
                            reasoningSummaryItemIds.add(event.item_id);
                        }
                        if (token.isCancellationRequested) {
                            return;
                        }
                        // Some gateways only send final done event (no delta)
                        if ((!eventKey || !reasoningSummaryDeltaKeys.has(eventKey)) && event.text) {
                            reporter.bufferThinking(event.text);
                        }
                        reporter.flushThinking('reasoning_summary complete');
                        reporter.endThinkingChain();
                    })
                    .on('response.reasoning_summary_part.done', event => {
                        // Reasoning summary part completion (aligned with official implementation)
                        // Official records summary appeared at this event to avoid output_item.done bringing summary text of same item again
                        if (event.item_id) {
                            reasoningSummaryItemIds.add(event.item_id);
                        }
                    })
                    .on('response.function_call_arguments.delta', () => {
                        // SDK will provide complete arguments in done event, no processing needed here
                        if (token.isCancellationRequested) {
                            return;
                        }
                    })
                    .on('response.function_call_arguments.done', event => {
                        if (token.isCancellationRequested) {
                            return;
                        }

                        const itemId = event.item_id;
                        const args = event.arguments || '';

                        if (!itemId) {
                            return;
                        }

                        const idx = getToolCallIndex(itemId);
                        if (completedToolCallIndices.has(idx)) {
                            return;
                        }

                        // Prioritize reusing call_id from added event; if gateway did not send added, fall back to item_id and use name from done event
                        const buf = toolCallBuffers.get(idx);
                        const name = buf?.name || event.name;
                        const callId = buf?.id || itemId;
                        if (!name) {
                            Logger.warn(`Tool call ${itemId} has no name`);
                            return;
                        }

                        // Use complete parameters from done event
                        toolCallBuffers.set(idx, { id: callId, name, args });

                        // Try to send tool call
                        try {
                            const input = JSON.parse(args || '{}');
                            reporter.reportToolCall(callId, name, input);
                            completedToolCallIndices.add(idx);
                        } catch (e) {
                            Logger.warn(`Failed to parse tool call parameters: ${args}`, e);
                        }
                    })
                    .on('response.output_item.added', event => {
                        // Process output item added event
                        if (token.isCancellationRequested) {
                            return;
                        }
                        const item = event.item;
                        // Official implementation: output_item.added only handles function_call, reasoning handled in output_item.done
                        if (item && item.type === 'function_call') {
                            const itemId = item.id;
                            if (!itemId) {
                                return;
                            }

                            // call_id may not exist, use itemId in this case
                            const callId = item.call_id || itemId;
                            const name = item.name || '';
                            const args = item.arguments || '';

                            // Use item.id as index (item_id in delta/done events corresponds here)
                            const idx = getToolCallIndex(itemId);
                            if (completedToolCallIndices.has(idx)) {
                                return;
                            }

                            // If call_id and item.id differ, also establish call_id mapping
                            if (item.call_id && item.call_id !== itemId) {
                                toolCallIdToIndex.set(item.call_id, idx);
                            }

                            // Initialize or update tool call buffer
                            // Note: At this point arguments may be empty, parameters will accumulate in subsequent delta/done events
                            const buf = toolCallBuffers.get(idx) || { id: callId, name: '', args: '' };
                            buf.id = callId;
                            if (name) {
                                buf.name = name;
                            }
                            // If parameters already exist (in some cases), use them
                            if (args) {
                                buf.args = args;
                            }
                            toolCallBuffers.set(idx, buf);

                            // Only send tool call when parameters are complete
                            // Otherwise wait for subsequent delta/done events
                            if (args && name) {
                                try {
                                    const input = JSON.parse(args);
                                    reporter.reportToolCall(callId, name, input);
                                    completedToolCallIndices.add(idx);
                                } catch (e) {
                                    Logger.warn(`Failed to parse tool call parameters: ${args}`, e);
                                }
                            }
                        }
                    })
                    .on('response.output_item.done', event => {
                        // Process output item done event (compatible with some gateways)
                        if (token.isCancellationRequested) {
                            return;
                        }
                        const item = event.item;
                        // Reasoning item completion: Aligned with official implementation, handle reasoning in output_item.done
                        // Official enters this branch for all reasoning items, output when encrypted content exists, no-op when no encrypted content
                        if (item && item.type === 'reasoning') {
                            const reasoningItem = item as unknown as ResponseReasoningItem;
                            if (reasoningItem.encrypted_content) {
                                // Only include when summary text has not been streamed
                                // (Referencing official implementation: pass undefined when hasReceivedReasoningSummary is true to avoid duplication)
                                const summaryText =
                                    reasoningItem.id && reasoningSummaryItemIds.has(reasoningItem.id) ?
                                        undefined
                                        : reasoningItem.summary?.map(s => s.text);
                                reporter.reportEncryptedThinking(
                                    reasoningItem.encrypted_content,
                                    reasoningItem.id,
                                    summaryText
                                );
                            }
                            // else: No encrypted content, no-op (consistent with official onProgress({ thinking: undefined }) behavior)
                        }
                        if (item && typeof item === 'object' && item.type === 'function_call') {
                            const itemObj = item as unknown as Record<string, unknown>;
                            const itemId = typeof itemObj.id === 'string' ? itemObj.id : '';
                            const callId = itemObj.call_id || itemObj.id;
                            const name = typeof itemObj.name === 'string' ? itemObj.name : '';
                            const args = typeof itemObj.arguments === 'string' ? itemObj.arguments : '';

                            if (!itemId || !callId || !name || !args) {
                                return;
                            }

                            const idx = getToolCallIndex(itemId);
                            if (completedToolCallIndices.has(idx)) {
                                return;
                            }

                            try {
                                const input = JSON.parse(args);
                                reporter.reportToolCall(callId as string, name, input);
                                completedToolCallIndices.add(idx);
                            } catch (e) {
                                Logger.warn(`Failed to parse tool call parameters: ${args}`, e);
                            }
                        }
                    })
                    .on('response.completed', event => {
                        streamEndTime = Date.now();

                        // Save usage information
                        if (event.response.usage) {
                            finalUsage = event.response.usage as unknown as Record<string, unknown>;
                        }

                        // Get response object
                        const response = event.response;
                        const responseId = response?.id as string | undefined;

                        // Process tool calls in complete response (fallback, ensure all tool calls are processed)
                        if (response && response.output) {
                            const output = response.output;
                            if (Array.isArray(output)) {
                                for (const item of output) {
                                    if (item.type === 'function_call' && item.id && item.name) {
                                        const callId = item.call_id || item.id;
                                        const idx = getToolCallIndex(item.id);
                                        if (completedToolCallIndices.has(idx)) {
                                            continue;
                                        }

                                        try {
                                            const input = JSON.parse(item.arguments || '{}');
                                            reporter.reportToolCall(callId, item.name, input);
                                            completedToolCallIndices.add(idx);
                                        } catch (e) {
                                            Logger.warn(`Failed to parse tool call parameters: ${item.arguments}`, e);
                                        }
                                    }
                                }
                            }
                        }

                        if (responseId) {
                            // Stream ended, output all remaining content and StatefulMarker
                            reporter.flushAll(null, {
                                sessionId,
                                responseId,
                                expireAt: sessionExpireAt
                            });
                            Logger.debug(
                                `💾 ${model.name} Pass StatefulMarker: sessionId=${sessionId}, responseId=${responseId}`
                            );
                        } else {
                            reporter.flushAll(null);
                        }
                    })
                    .on('error', error => {
                        // Save error, and abort request
                        if (error instanceof Error) {
                            streamError = error;
                        } else {
                            // ResponseErrorEvent is not Error type, needs conversion
                            const errorMsg =
                                'message' in error ? (error as { message: string }).message : String(error);
                            streamError = new Error(errorMsg);
                        }
                        abortController.abort();
                    });

                // Wait for stream processing to complete
                await stream.done();

                // Record stream end time
                streamEndTime ??= Date.now();

                // Check if there is stream error
                if (streamError) {
                    throw streamError;
                }

                // Report usage information
                Logger.info(`📊 ${model.name} Responses API request completed`, finalUsage);

                if (requestId) {
                    try {
                        // === Token statistics: Update actual tokens ===
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

                Logger.debug(`${model.name} ${this.displayName} Responses API stream processing completed`);
            } catch (error) {
                if (
                    token.isCancellationRequested ||
                    error instanceof vscode.CancellationError ||
                    error instanceof OpenAI.APIUserAbortError ||
                    (error instanceof Error && error.name === 'AbortError')
                ) {
                    Logger.info(`${model.name} Responses API request cancelled by user`);
                    throw new vscode.CancellationError();
                } else {
                    Logger.error(`${model.name} Responses API stream processing error: ${error}`);
                    streamError = error as Error;
                    throw error;
                }
            } finally {
                cancellationListener.dispose();
            }

            Logger.debug(`✅ ${model.name} ${this.displayName} Responses API request completed`);
        } catch (error) {
            if (error instanceof Error) {
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

                Logger.error(`${model.name} ${this.displayName} Responses API request failed: ${errorMessage}`);

                // Check if specific server error
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
                    throw new vscode.LanguageModelError(errorMessage);
                }

                throw error;
            }

            if (error instanceof vscode.CancellationError) {
                throw error;
            } else if (error instanceof vscode.LanguageModelError) {
                throw error;
            } else {
                throw error;
            }
        }
    }
}

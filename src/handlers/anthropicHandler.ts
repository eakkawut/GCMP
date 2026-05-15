/*---------------------------------------------------------------------------------------------
 *  Anthropic SDK Handler
 *  Handle model requests using Anthropic SDK
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { apiMessageToAnthropicMessage, convertToAnthropicTools } from './anthropicConverter';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/configManager';
import { VersionManager } from '../utils/versionManager';
import { TokenUsagesManager } from '../usages/usagesManager';
import type { ModelChatResponseOptions, ModelConfig, ProviderConfig } from '../types/sharedTypes';
import { OpenAIHandler } from './openaiHandler';
import { getStatefulMarkerAndIndex } from './statefulMarker';
import { StreamReporter } from './streamReporter';
import { MiniMaxVisionBridge } from './visionBridge/minimaxVisionBridge';
import type { GenericModelProvider } from '../providers/genericModelProvider';
import type { CommitChatModelOptions } from '../commit';

/**
 * Anthropic compatible handler class
 * Receives complete provider configuration, uses Anthropic SDK to handle streaming chat completion
 */
export class AnthropicHandler {
    constructor(private readonly providerInstance: GenericModelProvider) {
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

    private generateClaudeCodeStyleSessionKey(): string {
        // Claude Code style: user_<hash>_account__session_<uuid>
        // - user_<hash>: 64 hex (here using sha256(machineId) to generate stable value)
        // - session_<uuid>: generated once per new session, reused via cache subsequently
        const userHash = crypto.createHash('sha256').update(vscode.env.machineId).digest('hex');
        const sessionUuid = crypto.randomUUID();
        return `user_${userHash}_account__session_${sessionUuid}`;
    }

    private createAnthropicWebSearchTool(): Anthropic.Messages.WebSearchTool20250305 {
        return {
            name: 'web_search',
            type: 'web_search_20250305'
        };
    }

    private formatWebSearchToolResult(resultBlock: Anthropic.Messages.WebSearchToolResultBlock): string {
        if (!Array.isArray(resultBlock.content)) {
            return JSON.stringify(
                {
                    type: 'web_search_tool_result_error',
                    tool_use_id: resultBlock.tool_use_id,
                    error: resultBlock.content.error_code
                },
                null,
                2
            );
        }
        return JSON.stringify(
            {
                type: 'web_search_tool_result',
                tool_use_id: resultBlock.tool_use_id,
                content: resultBlock.content.map(result => ({
                    type: 'web_search_result',
                    url: result.url,
                    title: result.title,
                    page_age: result.page_age,
                    encrypted_content: result.encrypted_content
                }))
            },
            null,
            2
        );
    }
    private formatCitationDelta(citation: Anthropic.Messages.CitationsDelta['citation']): string | undefined {
        if (citation.type !== 'web_search_result_location') {
            return undefined;
        }
        return JSON.stringify(
            {
                type: 'web_search_result_location',
                url: citation.url,
                title: citation.title,
                cited_text: citation.cited_text,
                encrypted_index: citation.encrypted_index
            },
            null,
            2
        );
    }

    /**
     * Create Anthropic client
     * Create new client instance each time, consistent with OpenAIHandler
     */
    private async createAnthropicClient(modelConfig?: ModelConfig): Promise<Anthropic> {
        const providerKey = modelConfig?.provider || this.provider;
        const currentApiKey = await ApiKeyManager.getApiKey(providerKey);
        if (!currentApiKey) {
            throw new Error(`Missing ${this.displayName} API key`);
        }

        // Use model config's baseUrl or provider's default baseURL
        let baseUrl = modelConfig?.baseUrl || this.baseURL;
        if (providerKey === 'minimax-coding') {
            // Override baseUrl for MiniMax international site
            const endpoint = ConfigManager.getMinimaxEndpoint();
            if (baseUrl && endpoint === 'minimax.io') {
                baseUrl = baseUrl.replace('api.minimaxi.com', 'api.minimax.io');
            }
        }
        if (providerKey === 'zhipu') {
            // Override baseUrl for ZhipuAI international site
            const endpoint = ConfigManager.getZhipuEndpoint();
            if (baseUrl && endpoint === 'api.z.ai') {
                baseUrl = baseUrl.replace('open.bigmodel.cn', 'api.z.ai');
            }
        }
        if (providerKey === 'xiaomimimo-token') {
            // Switch endpoint for Xiaomi MiMo Token Plan
            const endpoint = ConfigManager.getXiaomimimoEndpoint();
            if (baseUrl && endpoint && endpoint !== 'cn') {
                baseUrl = baseUrl.replace('token-plan-cn', `token-plan-${endpoint}`);
            }
        }
        Logger.debug(`[${this.displayName}] Creating new Anthropic client (baseUrl: ${baseUrl})`);

        // Build default headers, including provider-level and model-level customHeader
        const defaultHeaders: Record<string, string> = {
            'User-Agent': VersionManager.getUserAgent(this.provider),
            // 'User-Agent': 'claude-cli/2.1.108 (external, cli)',
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
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

        const client = new Anthropic({
            apiKey: currentApiKey,
            baseURL: baseUrl,
            authToken: currentApiKey, // Resolve Minimax error: Please carry the API secret key in the 'Authorization' field of the request header
            defaultHeaders: defaultHeaders
        });

        Logger.trace(`${this.displayName} Anthropic compatible client has been created`);
        return client;
    }

    /**
     * Handle Anthropic SDK request
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
        // Convert vscode.CancellationToken to AbortSignal
        const abortController = new AbortController();
        const cancellationListener = token.onCancellationRequested(() => abortController.abort());

        try {
            const client = await this.createAnthropicClient(modelConfig);
            const { messages: anthropicMessages, system } = apiMessageToAnthropicMessage(modelConfig, messages);

            // Prepare tool definitions
            const tools: Anthropic.Messages.ToolUnion[] =
                options.tools ? convertToAnthropicTools([...options.tools]) : [];
            if (modelConfig.webSearchTool && !tools.some(tool => tool.name === 'web_search')) {
                tools.push(this.createAnthropicWebSearchTool());
            }

            // Use model field from model config, or model.id if not available
            const modelId = modelConfig.model || modelConfig.id;

            const createParams: Anthropic.MessageCreateParamsStreaming = {
                model: modelId,
                max_tokens: ConfigManager.getMaxTokensForModel(model.maxOutputTokens),
                messages: anthropicMessages,
                stream: true
            };

            // Minimax image bridge: add synthetic tool calls
            if (modelConfig?.provider === 'minimax-coding') {
                const realToolCount = tools.length;
                const existingToolNames = new Set(tools.map(tool => tool.name));
                const historicalTools = MiniMaxVisionBridge.collectHistoricalToolDefinitions(
                    messages,
                    existingToolNames
                );
                tools.push(...historicalTools);
                if (realToolCount === 0 && historicalTools.length > 0) {
                    createParams.tool_choice = { type: 'none' };
                    Logger.info(
                        `[${model.name}] Only historical tool calls exist, setting tool_choice=none to avoid synthetic tool re-triggering`
                    );
                }
            }

            // Anthropic compatible interface session cache: use local sessionKey to write metadata.user_id,
            // for gateway implementations of "client passes session" to achieve sticky sessions.
            const statefulMarker = getStatefulMarkerAndIndex(model.id, 'anthropic', messages);
            const sessionId = statefulMarker?.statefulMarker?.sessionId || this.generateClaudeCodeStyleSessionKey();
            createParams.metadata = { user_id: sessionId };

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
            if (settings?.thinking) {
                const thinking: { type: string } = createParams.thinking || { type: 'disabled' };
                thinking.type = settings.thinking;
                createParams.thinking = thinking as Anthropic.MessageCreateParamsStreaming['thinking'];
            } else if (settings?.reasoningEffort) {
                const thinking: { type: string } = createParams.thinking || { type: 'enabled' };
                thinking.type = 'enabled';
                const reasoning = createParams.output_config || { effort: 'medium' };
                reasoning.effort = settings.reasoningEffort as unknown as Anthropic.Messages.OutputConfig['effort'];
                if (settings.reasoningEffort === 'minimal') {
                    thinking.type = 'disabled';
                }
                createParams.thinking = thinking as Anthropic.MessageCreateParamsStreaming['thinking'];
                createParams.output_config = reasoning as Anthropic.MessageCreateParamsStreaming['output_config'];
                if (settings.reasoningEffort === 'none' || settings.reasoningEffort === 'minimal') {
                    thinking.type = 'disabled';
                    createParams.output_config = undefined;
                }
            }
            // If in commit mode and model supports thinking, disable thinking mode
            const modelOpts = options.modelOptions as CommitChatModelOptions;
            if (modelOpts?.commit && createParams.thinking) {
                createParams.thinking.type = 'disabled';
                // Also remove output_config to avoid conflict between thinking=disabled and reasoning_effort
                createParams.output_config = undefined;
            }

            // Add system message (if any)
            if (system.text) {
                createParams.system = [system];
            }
            // Add tools (if any)
            if (tools.length > 0) {
                createParams.tools = tools;
            }

            Logger.debug(
                `[${model.name}] Sending Anthropic API request with ${anthropicMessages.length} messages, using model: ${modelId}`
            );

            // const cacheCount = (JSON.stringify(createParams).match(/"cache_control"\s*:/g) || []).length;
            // Logger.warn(`[${model.name}] cache_control count: ${cacheCount}`);

            const stream = await client.messages.create(createParams, { signal: abortController.signal });

            // Create unified stream reporter
            const reporter = new StreamReporter({
                modelName: model.name,
                modelId: model.id,
                provider: this.provider,
                sdkMode: 'anthropic',
                progress,
                sessionId
            });

            // Replay MiniMax image bridge tool results (if applicable)
            if (modelConfig?.provider === 'minimax-coding') {
                MiniMaxVisionBridge.replayVisionBridge(messages, (callId, resultParts) =>
                    reporter.reportToolResult(callId, resultParts)
                );
            }

            // Use complete stream processing function
            const result = await this.handleAnthropicStream(stream, reporter, token);

            Logger.info(`[${model.name}] Anthropic request completed`, result?.usage);

            // === Token statistics: Update actual tokens ===
            if (requestId) {
                try {
                    const usagesManager = TokenUsagesManager.instance;
                    // Pass SDK Usage object directly, including stream timing information
                    await usagesManager.updateActualTokens({
                        requestId,
                        rawUsage: result?.usage || {},
                        status: 'completed',
                        streamStartTime: result?.streamStartTime,
                        streamEndTime: result?.streamEndTime
                    });
                } catch (err) {
                    Logger.warn('Failed to update token statistics:', err);
                }
            }
        } catch (error) {
            if (
                token.isCancellationRequested ||
                error instanceof Anthropic.APIUserAbortError ||
                (error instanceof Error && error.name === 'AbortError')
            ) {
                Logger.info(`[${model.name}] User cancelled the request`);
                throw new vscode.CancellationError();
            }

            Logger.error(`[${model.name}] Anthropic SDK error:`, error);

            // // Provide detailed error information
            // let errorMessage = `[${model.name}] Anthropic API call failed`;
            // if (error instanceof Error) {
            //     if (error.message.includes('401')) {
            //         errorMessage += ': API key invalid, please check configuration';
            //     } else if (error.message.includes('429')) {
            //         errorMessage += ': Request rate limit exceeded, please retry later';
            //     } else if (error.message.includes('500')) {
            //         errorMessage += ': Server error, please retry later';
            //     } else {
            //         errorMessage += `: ${error.message}`;
            //     }
            // }

            // progress.report(new vscode.LanguageModelTextPart(errorMessage));
            throw error;
        } finally {
            cancellationListener.dispose();
        }
    }

    /**
     * Handle Anthropic streaming response
     * Refer to official documentation: https://docs.anthropic.com/en/api/messages-streaming
     * Refer to official implementation: https://github.com/microsoft/vscode-copilot-chat/blob/main/src/extension/byok/vscode-node/anthropicProvider.ts
     */
    private async handleAnthropicStream(
        stream: AsyncIterable<Anthropic.Messages.MessageStreamEvent>,
        reporter: StreamReporter,
        token: vscode.CancellationToken
    ): Promise<{
        usage?: Anthropic.Messages.Usage;
        responseId?: string;
        streamStartTime?: number;
        streamEndTime?: number;
    }> {
        let pendingToolCall: { toolId?: string; name?: string; jsonInput?: string } | undefined;
        let pendingServerToolCall: { toolId?: string; name?: string; jsonInput?: string } | undefined;
        const completedServerToolCalls = new Map<string, { toolId?: string; name?: string; jsonInput?: string }>();
        let usage: Anthropic.Messages.Usage | undefined;
        let responseId: string | undefined;
        // Record stream processing start time (set in message_start event)
        let streamStartTime = Date.now();
        let streamEndTime: number | undefined = undefined;

        Logger.debug('Starting to process Anthropic streaming response');

        try {
            for await (const chunk of stream) {
                if (token.isCancellationRequested) {
                    Logger.debug('Stream processing cancelled');
                    reporter.flushAll(null);
                    break;
                }

                switch (chunk.type) {
                    case 'message_start':
                        // Message start - record stream start time
                        streamStartTime = Date.now();
                        // Collect initial usage statistics
                        if (chunk.message.usage) {
                            usage = chunk.message.usage;
                        }
                        // Get response message ID: message_start.message.id
                        if (!responseId && chunk.message.id) {
                            responseId = chunk.message.id;
                            reporter.setResponseId(responseId);
                            Logger.debug(`Received Anthropic message id (responseId): ${responseId}`);
                        }
                        break;

                    case 'content_block_start':
                        // Content block start
                        if (chunk.content_block.type === 'tool_use') {
                            pendingToolCall = {
                                toolId: chunk.content_block.id,
                                name: chunk.content_block.name,
                                jsonInput: ''
                            };
                        } else if (chunk.content_block.type === 'server_tool_use') {
                            pendingServerToolCall = {
                                toolId: chunk.content_block.id,
                                name: chunk.content_block.name,
                                jsonInput: JSON.stringify(chunk.content_block.input ?? {})
                            };
                        } else if (chunk.content_block.type === 'web_search_tool_result') {
                            const serverToolCall =
                                completedServerToolCalls.get(chunk.content_block.tool_use_id) ?? pendingServerToolCall;
                            if (!serverToolCall?.toolId) {
                                Logger.warn('Received web_search_tool_result but no corresponding server_tool_use');
                                break;
                            }

                            const searchResults = this.formatWebSearchToolResult(chunk.content_block);
                            // Logger.trace(
                            //     `[${reporter.getModelName()}] Received native web_search_tool_result: ${searchResults}`
                            // );
                            if (!Array.isArray(chunk.content_block.content)) {
                                Logger.warn(
                                    `[${reporter.getModelName()}] web_search_tool_result returned error: ${chunk.content_block.content.error_code}`
                                );
                                completedServerToolCalls.delete(chunk.content_block.tool_use_id);
                                if (pendingServerToolCall?.toolId === chunk.content_block.tool_use_id) {
                                    pendingServerToolCall = undefined;
                                }
                                break;
                            }

                            reporter.reportToolResult(serverToolCall.toolId, searchResults);
                            completedServerToolCalls.delete(chunk.content_block.tool_use_id);
                            if (pendingServerToolCall?.toolId === chunk.content_block.tool_use_id) {
                                pendingServerToolCall = undefined;
                            }
                        }
                        break;

                    case 'content_block_delta':
                        // Content block delta update
                        if (chunk.delta.type === 'text_delta') {
                            // Text content delta
                            reporter.reportText(chunk.delta.text);
                        } else if (chunk.delta.type === 'input_json_delta' && pendingToolCall) {
                            // Tool call parameter delta
                            pendingToolCall.jsonInput = (pendingToolCall.jsonInput || '') + chunk.delta.partial_json;

                            // Try to parse and report tool call immediately (if JSON is complete)
                            try {
                                const parsedJson = JSON.parse(pendingToolCall.jsonInput);
                                // JSON parsing successful, report tool call immediately
                                reporter.reportToolCall(pendingToolCall.toolId!, pendingToolCall.name!, parsedJson);
                                Logger.trace(`[${reporter.getModelName()}] Tool call completed: ${pendingToolCall.name}`);
                                pendingToolCall = undefined; // Clear pending tool call
                            } catch {
                                // JSON not yet complete, continue accumulating
                            }
                        } else if (chunk.delta.type === 'input_json_delta' && pendingServerToolCall) {
                            pendingServerToolCall.jsonInput =
                                (pendingServerToolCall.jsonInput || '') + chunk.delta.partial_json;
                        } else if (chunk.delta.type === 'thinking_delta') {
                            // Thinking content delta
                            const thinkingDelta = chunk.delta.thinking || '';
                            reporter.bufferThinking(thinkingDelta);
                        } else if (chunk.delta.type === 'citations_delta') {
                            if (!('citation' in chunk.delta)) {
                                break;
                            }

                            const citationContent = this.formatCitationDelta(chunk.delta.citation);
                            if (citationContent) {
                                // Logger.trace(
                                //     `[${reporter.getModelName()}] Received web_search citation: ${citationContent}`
                                // );
                                reporter.reportToolResult('citation', citationContent);
                            }
                        } else if (chunk.delta.type === 'signature_delta') {
                            // Accumulate signature
                            const signatureDelta = chunk.delta.signature || '';
                            reporter.bufferSignature(signatureDelta);
                        }
                        break;

                    case 'content_block_stop':
                        // Content block stop (fallback handling)
                        if (pendingToolCall) {
                            // If there are still unprocessed tool calls, try one last parse
                            try {
                                const jsonInput = pendingToolCall.jsonInput || '{}';
                                Logger.trace(
                                    `[${reporter.getModelName()}] content_block_stop fallback handling tool call (${pendingToolCall.name}): ${jsonInput}`
                                );

                                let parsedJson: Record<string, unknown>;
                                try {
                                    parsedJson = JSON.parse(jsonInput);
                                } catch {
                                    // JSON parsing failed, use empty object
                                    Logger.warn(`Tool call JSON incomplete, using empty object: ${jsonInput}`);
                                    parsedJson = {};
                                }

                                reporter.reportToolCall(pendingToolCall.toolId!, pendingToolCall.name!, parsedJson);
                            } catch (e) {
                                Logger.error(`Fallback handling tool call failed (${pendingToolCall.name}):`, e);
                            }
                            pendingToolCall = undefined;
                        } else if (pendingServerToolCall) {
                            const jsonInput = pendingServerToolCall.jsonInput || '{}';
                            Logger.trace(
                                `[${reporter.getModelName()}] server_tool_use completed (${pendingServerToolCall.name || 'web_search'}): ${jsonInput}`
                            );
                            if (pendingServerToolCall.toolId) {
                                completedServerToolCalls.set(pendingServerToolCall.toolId, pendingServerToolCall);
                            }
                            pendingServerToolCall = undefined;
                        } else {
                            // Output remaining thinking content and signature when thinking block ends
                            reporter.flushThinking('Thinking block completed');
                            reporter.flushSignature();
                        }
                        break;

                    case 'message_delta':
                        // Message delta - update usage statistics
                        if (chunk.usage) {
                            // Some Claude gateways only return usage in message_delta (usually accompanied by stop_reason).
                            // At this point message_start does not contain usage, so delayed initialization of usage is needed here.
                            if (!usage) {
                                usage = chunk.usage as unknown as Anthropic.Messages.Usage;
                            } else {
                                // Merge MessageDeltaUsage delta into current Usage
                                usage = {
                                    ...Object.assign(usage || {}, chunk.usage),
                                    input_tokens: chunk.usage.input_tokens ?? usage.input_tokens,
                                    output_tokens: chunk.usage.output_tokens ?? usage.output_tokens,
                                    cache_read_input_tokens:
                                        chunk.usage.cache_read_input_tokens ?? usage.cache_read_input_tokens,
                                    cache_creation_input_tokens:
                                        chunk.usage.cache_creation_input_tokens ?? usage.cache_creation_input_tokens
                                } as Anthropic.Messages.Usage;
                            }
                        }
                        break;

                    case 'message_stop': {
                        streamEndTime = Date.now();
                        if (responseId) {
                            // Message stop - pass StatefulMarker
                            reporter.flushAll(null, { sessionId: reporter.getSessionId(), responseId });
                        }
                        Logger.trace('Message stream completed');
                        break;
                    }

                    default:
                        // Unknown event type - handle gracefully per official recommendations
                        // May include ping events or new event types in the future
                        Logger.trace('Received other event type');
                        break;
                }
            }
        } catch (error) {
            Logger.error('Error while processing Anthropic stream:', error);
            throw error;
        }

        // Record stream processing end time
        streamEndTime ??= Date.now();

        if (usage) {
            const duration = streamEndTime - streamStartTime;
            const speed = duration > 0 ? ((usage.output_tokens / duration) * 1000).toFixed(1) : 'N/A';
            Logger.debug(
                `Stream processing completed - Final usage statistics: input=${usage.input_tokens}, output=${usage.output_tokens}, duration=${duration}ms, speed=${speed} tokens/s`
            );
        }
        return { usage, responseId, streamStartTime, streamEndTime };
    }
}

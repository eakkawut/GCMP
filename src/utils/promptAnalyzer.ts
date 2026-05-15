/*---------------------------------------------------------------------------------------------
 *  Prompt Analyzer - analyzePromptParts independent implementation
 *  Used for decomposing token usage of each prompt part
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    LanguageModelThinkingPart,
    LanguageModelTextPart,
    ProvideLanguageModelChatResponseOptions
} from 'vscode';
import { ModelConfig } from '../types/sharedTypes';
import { PromptPartTokens } from '../status/contextUsageStatusBar';
import { Logger } from './logger';
import { sanitizeToolSchemaForSdkMode } from './schemaSanitizer';
import { TokenCounter } from './tokenCounter';

/**
 * Prompt Analyzer
 * Used for detailed decomposition of token usage for each prompt part
 */
export class PromptAnalyzer {
    static readonly CONVERSATION_COMPRESSION_MARKER =
        'The following is a compressed version of the preceeding history in the current conversation';
    static readonly CONVERSATION_SUMMARY_TAG = '<conversation-summary>\n';
    static readonly ENVIRONMENT_WORKSPACE_TAG = '</environment_info>\n<workspace_info>';

    /**
     * Type guard: Check if LanguageModelTextPart
     * LanguageModelTextPart has value property
     */
    private static isLanguageModelTextPart(part: unknown): part is LanguageModelTextPart {
        return (
            typeof part === 'object' &&
            part !== null &&
            'value' in part &&
            typeof (part as LanguageModelTextPart).value === 'string'
        );
    }

    /**
     * Type guard: Detect if it's a DataPart containing binary data, specifically images
     * Structure is typically { mimeType: string, data: Uint8Array | ArrayBuffer | BufferJson | number[] }
     */
    private static isImageDataPart(part: unknown): part is { mimeType: string; data: unknown } {
        if (!part || typeof part !== 'object') {
            return false;
        }
        const obj = part as Record<string, unknown>;
        return typeof obj.mimeType === 'string' && obj.mimeType.toLowerCase().startsWith('image/') && 'data' in obj;
    }

    /**
     * Analyze token usage of each prompt part
     * @param providerKey Provider identifier, for log output
     * @param model Language model info
     * @param messages Message array
     * @param options Options (containing tool definitions)
     * @returns Decomposed token statistics
     */
    static async analyzePromptParts(
        providerKey: string,
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        modelConfig?: Pick<ModelConfig, 'sdkMode'>,
        options?: ProvideLanguageModelChatResponseOptions
    ): Promise<PromptPartTokens> {
        const promptParts: PromptPartTokens = {
            systemPrompt: 0,
            availableTools: 0,
            environment: 0,
            userAssistantMessage: 0,
            thinking: 0,
            autoCompressed: 0,
            context: 0
        };

        try {
            const tokenCounter = TokenCounter.getInstance();
            Logger.debug(`[${providerKey}] analyzePromptParts started, message count: ${messages.length}`);

            // ===== 1. Calculate system prompt =====
            // Based on official Anthropic SDK standard: system message + wrapper overhead
            let systemText = '';
            let systemMessageCount = 0;
            for (const message of messages) {
                const role = message.role;
                // Logger.debug(`[${providerKey}] Message role: ${role}`);
                // role is LanguageModelChatMessageRole enum: System=3, User=1, Assistant=2
                if (role === vscode.LanguageModelChatMessageRole.System) {
                    systemMessageCount++;
                    if (typeof message.content === 'string') {
                        systemText += message.content;
                    } else if (Array.isArray(message.content)) {
                        for (const part of message.content) {
                            const text = this.extractPartText(part as unknown);
                            if (text) {
                                systemText += text;
                            }
                        }
                    }
                }
            }
            Logger.debug(
                `[${providerKey}] Found ${systemMessageCount} system messages, systemText length: ${systemText.length}`
            );
            if (systemText) {
                const systemTokens = await tokenCounter.countTokens(model, systemText);
                Logger.debug(`[${providerKey}] systemTokens: ${systemTokens}`);
                // Official standard: system message wrapper overhead is approximately 28 tokens
                const systemOverhead = 28;
                promptParts.systemPrompt = systemTokens + systemOverhead;
            }

            // ===== 2. Calculate available tool descriptions =====
            // Based on official standard: base overhead + per-tool overhead + content tokens, then * 1.1
            if (options?.tools && Array.isArray(options.tools)) {
                let toolsTokens = 16; // Base overhead
                for (const tool of options.tools) {
                    toolsTokens += 8; // Base overhead per tool
                    if ('name' in tool && typeof tool.name === 'string') {
                        toolsTokens += await tokenCounter.countTokens(model, tool.name);
                    }
                    if ('description' in tool && typeof tool.description === 'string') {
                        toolsTokens += await tokenCounter.countTokens(model, tool.description);
                    }
                    // Calculate tool inputSchema (parameter definition)
                    if ('inputSchema' in tool && tool.inputSchema) {
                        const schemaJson = JSON.stringify(
                            sanitizeToolSchemaForSdkMode(tool.inputSchema, modelConfig?.sdkMode)
                        );
                        toolsTokens += await tokenCounter.countTokens(model, schemaJson);
                    }
                }
                // Official 1.1 safety factor (using Math.floor to be consistent with countMessagesTokens)
                promptParts.availableTools = Math.floor(toolsTokens * 1.1);
            }

            // ===== 3. Detect compressed history messages =====
            // Official implementation: when history is too long, compress history into special UserMessage
            // Check for "compressed version" or "conversation-summary" markers
            let compressedHistoryMessage: vscode.LanguageModelChatMessage | undefined;
            for (const message of messages) {
                const role = message.role;
                if (role === vscode.LanguageModelChatMessageRole.User) {
                    // Check if message content contains compressed history markers
                    let messageContent = '';
                    if (typeof message.content === 'string') {
                        messageContent = message.content;
                    } else if (Array.isArray(message.content)) {
                        for (const part of message.content) {
                            const text = this.extractPartText(part as unknown);
                            if (text) {
                                messageContent += text;
                            }
                        }
                    }
                    // Check if compressed history message (official marker)
                    if (
                        messageContent.includes(PromptAnalyzer.CONVERSATION_COMPRESSION_MARKER) ||
                        messageContent.includes(PromptAnalyzer.CONVERSATION_SUMMARY_TAG)
                    ) {
                        compressedHistoryMessage = message;
                        break;
                    }
                }
            }

            if (compressedHistoryMessage) {
                // Use complete message body to calculate tokens (including message format overhead)
                const compressedTokens = await tokenCounter.countTokens(
                    model,
                    compressedHistoryMessage as unknown as vscode.LanguageModelChatMessage
                );
                promptParts.autoCompressed = compressedTokens;
            }

            // ===== 3.5 Detect environment messages =====
            // Check for messages containing environment info (environment_info and workspace_info)
            let environmentMessage: vscode.LanguageModelChatMessage | undefined;
            for (const message of messages) {
                const role = message.role;
                if (role === vscode.LanguageModelChatMessageRole.User) {
                    // Check if message content contains environment info markers
                    let messageContent = '';
                    if (typeof message.content === 'string') {
                        messageContent = message.content;
                    } else if (Array.isArray(message.content)) {
                        for (const part of message.content) {
                            const text = this.extractPartText(part as unknown);
                            if (text) {
                                messageContent += text;
                            }
                        }
                    }
                    // Check if environment message (contains environment tags)
                    if (messageContent.includes(PromptAnalyzer.ENVIRONMENT_WORKSPACE_TAG)) {
                        environmentMessage = message;
                        break;
                    }
                }
            }

            if (environmentMessage) {
                // Use complete message body to calculate tokens (including message format overhead)
                const environmentTokens = await tokenCounter.countTokens(
                    model,
                    environmentMessage as unknown as vscode.LanguageModelChatMessage
                );
                promptParts.environment = environmentTokens;
                Logger.debug(`[${providerKey}] Detected environment message, tokens=${environmentTokens}`);
            }

            // ===== 4. Analyze messages: user, assistant, other roles merged into userAssistantMessage =====
            // Also split into history messages and current round messages

            // 4.1 Find the index of the last user role with type=text message
            let lastUserTextMessageIndex = -1;
            for (let i = messages.length - 1; i >= 0; i--) {
                const message = messages[i];
                const role = message.role;

                // Only check user role messages
                if (role === vscode.LanguageModelChatMessageRole.User) {
                    // Check if it's a text type message
                    let isTextMessage = false;

                    if (typeof message.content === 'string') {
                        // String content is text type
                        isTextMessage = true;
                    } else if (Array.isArray(message.content)) {
                        // Check if content array has text type parts
                        for (const part of message.content) {
                            // Skip thinking part
                            if (part instanceof LanguageModelThinkingPart) {
                                continue;
                            }
                            // Use type guard to check if LanguageModelTextPart
                            // LanguageModelTextPart has value property
                            if (PromptAnalyzer.isLanguageModelTextPart(part)) {
                                isTextMessage = true;
                                break;
                            }
                        }
                    }

                    if (isTextMessage) {
                        lastUserTextMessageIndex = i;
                        break;
                    }
                }
            }

            Logger.debug(`[${providerKey}] Last user text message index: ${lastUserTextMessageIndex}`);

            // 4.2 Iterate all messages, calculate history and current round tokens separately
            let processedMessageCount = 0;
            let skippedMessageCount = 0;
            let historyMessageCount = 0;
            let currentRoundMessageCount = 0;

            for (let i = 0; i < messages.length; i++) {
                const message = messages[i];
                const role = message.role;

                // Skip system messages (already processed in step 1)
                if (role === vscode.LanguageModelChatMessageRole.System) {
                    skippedMessageCount++;
                    continue;
                }

                // ===== Detect thinking part (LanguageModelThinkingPart) =====
                let currentMessageThinkingTokens = 0;
                if (Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (part instanceof LanguageModelThinkingPart) {
                            // thinking part itself contains thinking content, but we need to calculate its tokens
                            // Get text content of thinking part
                            const thinkingText = this.extractPartText(part as unknown);
                            if (thinkingText) {
                                const thinkingTokens = await tokenCounter.countTokens(model, thinkingText);
                                promptParts.thinking = (promptParts.thinking || 0) + thinkingTokens;
                                if (lastUserTextMessageIndex !== -1 && i >= lastUserTextMessageIndex) {
                                    currentMessageThinkingTokens += thinkingTokens;
                                }
                                // Logger.debug(
                                //     `[${providerKey}] Detected LanguageModelThinkingPart, tokens=${thinkingTokens}`
                                // );
                            }
                        }
                    }
                }

                // Skip compressed history messages (already processed in step 3)
                let messageContentForCheck = '';
                if (typeof message.content === 'string') {
                    messageContentForCheck = message.content;
                } else if (Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (part instanceof LanguageModelThinkingPart) {
                            continue;
                        }
                        const text = this.extractPartText(part as unknown);
                        if (text) {
                            messageContentForCheck += text;
                        }
                    }
                }
                if (
                    messageContentForCheck.includes(PromptAnalyzer.CONVERSATION_COMPRESSION_MARKER) ||
                    messageContentForCheck.includes(PromptAnalyzer.CONVERSATION_SUMMARY_TAG)
                ) {
                    // Logger.debug(`[${providerKey}] Skipping compressed history message, content length: ${messageContentForCheck.length}`);
                    skippedMessageCount++;
                    continue;
                }

                // Skip environment messages (already processed in step 3.5)
                if (messageContentForCheck.includes(PromptAnalyzer.ENVIRONMENT_WORKSPACE_TAG)) {
                    // Logger.debug(`[${providerKey}] Skipping environment message, content length: ${messageContentForCheck.length}`);
                    skippedMessageCount++;
                    continue;
                }
                // Current round image attachments: if message content contains image DataPart, accumulate their tokens separately
                // And deduct from currentRoundMessages (to ensure "current round messages" shows non-image part)
                let currentMessageImageTokens = 0;
                if (
                    lastUserTextMessageIndex !== -1 &&
                    i >= lastUserTextMessageIndex &&
                    Array.isArray(message.content)
                ) {
                    for (const part of message.content) {
                        if (PromptAnalyzer.isImageDataPart(part)) {
                            try {
                                currentMessageImageTokens += await tokenCounter.countMessageObjectTokens(
                                    part as unknown as Record<string, unknown>
                                );
                            } catch {
                                // ignore single-part failures; message-level counting already exists
                            }
                        }
                    }
                }

                // Calculate message tokens using same method as countMessagesTokens
                // This ensures calculation results are consistent
                const messageTokens = await tokenCounter.countTokens(
                    model,
                    message as unknown as string | vscode.LanguageModelChatMessage
                );

                // Logger.debug(`[${providerKey}] Processing message [${i}] role=${role}, tokens=${messageTokens}`);

                // Merge according to official standard: all non-system, non-compressed messages go into userAssistantMessage
                // Including: user, assistant, tool, function and all other conversation roles
                if (
                    role === vscode.LanguageModelChatMessageRole.User ||
                    role === vscode.LanguageModelChatMessageRole.Assistant
                ) {
                    promptParts.userAssistantMessage = (promptParts.userAssistantMessage || 0) + messageTokens;
                    processedMessageCount++;

                    // Determine if history or current round message based on message index
                    if (lastUserTextMessageIndex !== -1 && i >= lastUserTextMessageIndex) {
                        // Current round message
                        const currTextTokens = Math.max(
                            0,
                            messageTokens - currentMessageImageTokens - currentMessageThinkingTokens
                        );
                        promptParts.currentRoundMessages = (promptParts.currentRoundMessages || 0) + currTextTokens;
                        if (currentMessageImageTokens > 0) {
                            promptParts.currentRoundImages =
                                (promptParts.currentRoundImages || 0) + currentMessageImageTokens;
                        }
                        currentRoundMessageCount++;
                        // Logger.trace(
                        //     `[${providerKey}] Message [${i}] classified as current round message, cumulative tokens=${promptParts.currentRoundMessages}`
                        // );
                    } else {
                        // History message
                        promptParts.historyMessages = (promptParts.historyMessages || 0) + messageTokens;
                        historyMessageCount++;
                        // Logger.trace(
                        //     `[${providerKey}] Message [${i}] classified as history message, cumulative tokens=${promptParts.historyMessages}`
                        // );
                    }
                }
            }
            Logger.debug(
                `[${providerKey}] Message processing complete: processed ${processedMessageCount}, skipped ${skippedMessageCount}, history messages ${historyMessageCount}, current round messages ${currentRoundMessageCount}`
            );

            // ===== 5. Calculate total context usage =====
            // context = systemPrompt + availableTools + environment + userAssistantMessage + autoCompressed
            const contextTotal =
                (promptParts.systemPrompt || 0) +
                (promptParts.availableTools || 0) +
                (promptParts.environment || 0) +
                (promptParts.autoCompressed || 0) +
                (promptParts.userAssistantMessage || 0);
            promptParts.context = contextTotal;
            Logger.debug(
                `[${providerKey}] Token breakdown statistics:\n` +
                `  System prompt: ${promptParts.systemPrompt} tokens (including 28 wrapper overhead)\n` +
                `  Available tools: ${promptParts.availableTools} tokens (including 1.1x safety factor)\n` +
                `  Environment messages: ${promptParts.environment} tokens (environment_info and workspace_info)\n` +
                `  Auto compressed: ${promptParts.autoCompressed} tokens (compressed history message body)\n` +
                `  Conversation messages: ${promptParts.userAssistantMessage} tokens (user, assistant, and other conversation roles)\n` +
                `    - History messages: ${promptParts.historyMessages} tokens (all messages before current conversation round)\n` +
                `    - Thinking process: ${promptParts.thinking} tokens (LanguageModelThinkingPart)\n` +
                `    - Current round messages: ${promptParts.currentRoundMessages} tokens (from last user text message, excluding images and thinking)\n` +
                `    - Current round images: ${promptParts.currentRoundImages || 0} tokens (image attachments in current round messages)\n` +
                `  = Total usage: ${promptParts.context} tokens`
            );
            return promptParts;
        } catch (error) {
            Logger.warn(`[${providerKey}] Failed to analyze prompt parts:`, error);
            Logger.debug(
                `[${providerKey}] Current promptParts: systemPrompt=${promptParts.systemPrompt}, availableTools=${promptParts.availableTools}, environment=${promptParts.environment}, userAssistantMessage=${promptParts.userAssistantMessage}, autoCompressed=${promptParts.autoCompressed}, context=${promptParts.context}`
            );
            // Return zero-value structure to prevent status bar crash
            return promptParts;
        }
    }

    /**
     * Extract text content from message part
     * @param part Message part (can be string or object)
     * @returns Extracted text, or empty string if extraction fails
     */
    private static extractPartText(part: unknown): string {
        if (typeof part === 'string') {
            return part;
        }
        if (!part || typeof part !== 'object') {
            return '';
        }

        const partObj = part as Record<string, unknown>;
        // Handle standard TextPart / ThinkingPart
        // - TextPart: value: string
        // - ThinkingPart: value: string | string[]
        if ('value' in partObj) {
            const v = partObj.value;
            if (typeof v === 'string') {
                return v;
            }
            if (Array.isArray(v) && v.every(x => typeof x === 'string')) {
                return v.join('');
            }
        }
        // Handle markdown content
        if ('markdown' in partObj && typeof partObj.markdown === 'string') {
            return partObj.markdown;
        }
        // Handle text field
        if ('text' in partObj && typeof partObj.text === 'string') {
            return partObj.text;
        }
        // Handle data field (can be Buffer or other)
        if ('data' in partObj && partObj.data) {
            if (typeof partObj.data === 'string') {
                return partObj.data;
            }
            if (Buffer.isBuffer(partObj.data)) {
                try {
                    return partObj.data.toString('utf-8');
                } catch {
                    return '';
                }
            }
        }
        return '';
    }
}

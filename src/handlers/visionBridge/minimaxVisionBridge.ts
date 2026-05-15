/*---------------------------------------------------------------------------------------------
 *  MiniMax Image Bridge Handler
 *  When model does not support image input, use Vision API to convert images to text descriptions
 *  Note: When MiniMax models improve image support, this bridge module can be removed entirely
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CancellationToken, LanguageModelChatMessage } from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { ModelConfig } from '../../types/sharedTypes';
import { Logger, ApiKeyManager } from '../../utils';
import { MiniMaxVisionTool } from './minimaxVision';
import {
    buildVisionBridgeMessages as createVisionBridgeMessages,
    createVisionBridgeToolCallId,
    visionBridgeDefinitions
} from './visionBridge';

/**
 * Image bridge processing result
 */
export interface VisionBridgeResult {
    messages: Array<LanguageModelChatMessage>;
}

/**
 * Image bridge replay event (internal use)
 * Used to extract already-processed bridge results from message chain
 */
interface ReplayEvent {
    callId: string;
    name: string;
    input: Record<string, unknown>;
    resultParts: vscode.LanguageModelTextPart[];
}

/**
 * MiniMax Image Bridge Handler
 *
 * Converts images in user messages to text descriptions via MiniMax Vision API,
 * then injects them back into the conversation as tool_call message chain,
 * enabling models that don't support images to "understand" image content.
 *
 * After MiniMax models natively support image input, delete this file and its calls in provider.
 */
export class MiniMaxVisionBridge {
    private static readonly definition = visionBridgeDefinitions.minimax;
    private static readonly maxConcurrency = 3;
    private static readonly supportedImageTypes = ['image/jpeg', 'image/png', 'image/webp'];

    /**
     * Check if MIME type is supported by MiniMax Vision API
     * Only supports JPEG, PNG, WebP, does not support GIF
     */
    static isImageMimeType(mimeType: string): boolean {
        const normalized = mimeType.toLowerCase() === 'image/jpg' ? 'image/jpeg' : mimeType.toLowerCase();
        return MiniMaxVisionBridge.supportedImageTypes.includes(normalized);
    }

    private static previewText(text: string, maxLength = 120): string {
        const normalized = text.replace(/\s+/g, ' ').trim();
        if (normalized.length <= maxLength) {
            return normalized;
        }
        return `${normalized.slice(0, maxLength)}...`;
    }

    /**
     * Build image bridge message chain
     * Inject user question + image descriptions as user(question) -> assistant(tool_call) -> user(tool_result) three messages
     */
    static buildBridgeMessages(
        messages: Array<LanguageModelChatMessage>,
        lastUserMessageIndex: number,
        originalQuestion: string,
        imageDescriptions: string[]
    ): VisionBridgeResult {
        const callId = createVisionBridgeToolCallId(MiniMaxVisionBridge.definition.toolName);
        const questionText =
            originalQuestion || `Please summarize the main content of these ${imageDescriptions.length} image(s) based on the image recognition results.`;

        const bridgeResult = createVisionBridgeMessages({
            messages,
            lastUserMessageIndex,
            callId,
            toolName: MiniMaxVisionBridge.definition.toolName,
            questionText,
            imageDescriptions
        });

        const toolInput: Record<string, unknown> = {
            imageCount: imageDescriptions.length,
            question: questionText
        };
        const resultParts = bridgeResult.resultParts;
        const resultText = resultParts.map(part => part.value).join('\n');

        Logger.info(
            `MiniMax Image Bridge: Inject message chain user(question) -> assistant(tool_call=${MiniMaxVisionBridge.definition.toolName}) -> user(tool_result), callId=${callId}, imageCount=${imageDescriptions.length}, insertIndex=${lastUserMessageIndex}`
        );
        Logger.trace(`MiniMax Image Bridge: tool_input=${JSON.stringify(toolInput)}`);
        Logger.trace(`MiniMax Image Bridge: question preview=${MiniMaxVisionBridge.previewText(questionText)}`);
        Logger.trace(`MiniMax Image Bridge: tool_result preview=${MiniMaxVisionBridge.previewText(resultText, 240)}`);

        return {
            messages: bridgeResult.messages
        };
    }

    /**
     * Preprocess images in messages (image bridge functionality)
     * Use MiniMax Vision API to convert images to text descriptions before sending to model
     * Only process new messages of current turn (last user message), historical messages have been processed in previous turn
     *
     * @param messages Original message list
     * @param modelConfig Model configuration
     * @param providerKey Provider key corresponding to the model
     * @param token Cancel signal, stops image preprocessing when user cancels request
     * @returns Processed message list
     */
    static async preprocessImages(
        messages: Array<LanguageModelChatMessage>,
        modelConfig: ModelConfig,
        providerKey: string,
        token: CancellationToken
    ): Promise<VisionBridgeResult> {
        // Only enable image bridge for Coding Plan models
        if (providerKey !== 'minimax-coding') {
            return { messages };
        }

        // Check if MiniMax Vision API key is configured
        const hasApiKey = await ApiKeyManager.hasValidApiKey('minimax-coding');
        if (!hasApiKey) {
            Logger.debug('MiniMax image bridge: Coding Plan API key not configured, skipping image preprocessing');
            return { messages };
        }

        // Quick exit when user cancels
        if (token.isCancellationRequested) {
            Logger.debug('MiniMax image bridge: Request cancelled, skipping image preprocessing');
            return { messages };
        }

        const visionTool = new MiniMaxVisionTool();
        const abortController = new AbortController();
        token.onCancellationRequested(() => {
            abortController.abort();
        });

        // Find the last user message (new messages of current turn)
        let lastUserMessageIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === vscode.LanguageModelChatMessageRole.User) {
                lastUserMessageIndex = i;
                break;
            }
        }

        // Count number of images to process (includes all image/* types, ensures unsupported formats like GIF also enter bridge)
        let totalImages = 0;
        if (lastUserMessageIndex >= 0) {
            const lastUserMessage = messages[lastUserMessageIndex];
            for (const part of lastUserMessage.content) {
                if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
                    totalImages++;
                }
            }
        }

        if (totalImages === 0) {
            return { messages };
        }

        // Only process the last user message
        const lastUserMessage = messages[lastUserMessageIndex];

        // First extract user's original question (used as prompt for vision model)
        const originalTextParts: string[] = [];
        for (const part of lastUserMessage.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                originalTextParts.push(part.value);
            }
        }
        const originalQuestion = originalTextParts.join('\n').trim();

        // Then process image parts: call Vision concurrently, finally concatenate results in original order
        const imageParts: Array<{ imageNumber: number; part: vscode.LanguageModelDataPart }> = [];
        for (const part of lastUserMessage.content) {
            if (token.isCancellationRequested) {
                Logger.debug('MiniMax Image Bridge: Request cancelled, stopping image preprocessing');
                return { messages };
            }
            if (!(part instanceof vscode.LanguageModelDataPart) || !part.mimeType.startsWith('image/')) {
                continue;
            }
            if (!MiniMaxVisionBridge.isImageMimeType(part.mimeType)) {
                Logger.error(`Unsupported image format: ${part.mimeType}`);
                throw new Error(`Unsupported image format: ${part.mimeType}. MiniMax Vision only supports JPEG, PNG, WebP.`);
            }

            imageParts.push({
                imageNumber: imageParts.length + 1,
                part
            });
        }

        const maxConcurrency = Math.min(MiniMaxVisionBridge.maxConcurrency, imageParts.length);
        const queuedCount = imageParts.length - maxConcurrency;
        Logger.info(
            `Detected ${totalImages} image(s) to analyze, using ${maxConcurrency} concurrent processing${queuedCount > 0 ? `, ${queuedCount} more queued` : ''}`
        );

        const imageDescriptions = new Array<string>(imageParts.length);
        const batchStartTime = Date.now();
        let nextIndex = 0;
        let completedCount = 0;
        let successCount = 0;
        let failedCount = 0;

        try {
            const worker = async (workerId: number): Promise<void> => {
                while (nextIndex < imageParts.length) {
                    const currentIndex = nextIndex;
                    nextIndex += 1;

                    const { imageNumber, part } = imageParts[currentIndex];
                    const imageStartTime = Date.now();
                    Logger.info(
                        `Starting to analyze image (${imageNumber}/${totalImages}) [worker ${workerId}/${maxConcurrency}]: mimeType=${part.mimeType}, data size=${part.data.length} bytes`
                    );

                    // With image sequence number (total N) and user question, let vision model give structured, targeted description
                    const visionPrompt =
                        originalQuestion ?
                            `This is image ${imageNumber} of ${totalImages}. The user's question is: ${originalQuestion}\n\nPlease describe the content of this image in detail, striving for accuracy and completeness.`
                            : `This is image ${imageNumber} of ${totalImages}.\n\nPlease describe the content of this image in detail, striving for accuracy and completeness.`;

                    try {
                        const response = await visionTool.understandImage(
                            part.data,
                            part.mimeType,
                            visionPrompt,
                            abortController.signal
                        );
                        imageDescriptions[currentIndex] = response.content;
                        completedCount += 1;
                        successCount += 1;
                        Logger.info(
                            `Image ${imageNumber}/${totalImages} converted successfully (elapsed ${Date.now() - imageStartTime}ms, completed ${completedCount}/${totalImages})`
                        );
                    } catch (error) {
                        if (abortController.signal.aborted) {
                            throw error;
                        }
                        imageDescriptions[currentIndex] = '[Image analysis failed]';
                        completedCount += 1;
                        failedCount += 1;
                        Logger.error(
                            `Image ${imageNumber}/${totalImages} conversion failed (elapsed ${Date.now() - imageStartTime}ms, completed ${completedCount}/${totalImages})`,
                            error instanceof Error ? error : undefined
                        );
                    }
                }
            };

            await Promise.all(Array.from({ length: maxConcurrency }, (_, index) => worker(index + 1)));
        } catch (error) {
            if (abortController.signal.aborted) {
                Logger.debug('MiniMax Image Bridge: Request cancelled');
                return { messages };
            }
            throw error;
        }

        if (imageParts.length > 0) {
            Logger.info(
                `All ${imageParts.length} image(s) parsed completed (success ${successCount}, failed ${failedCount}, max concurrency ${maxConcurrency}, total elapsed ${Date.now() - batchStartTime}ms)`
            );
        }

        return MiniMaxVisionBridge.buildBridgeMessages(
            messages,
            lastUserMessageIndex,
            originalQuestion,
            imageDescriptions
        );
    }

    // ==================== Replay-related logic ====================
    // After MiniMax models support visual recognition, the following code can be deleted together

    /**
     * Extract image bridge replay event from message chain
     * Detect if message chain end matches user(question) -> assistant(tool_call) -> user(tool_result) pattern
     *
     * @param messages Message chain
     * @returns Replay event, returns null if pattern does not match
     */
    static extractReplayEvent(messages: readonly vscode.LanguageModelChatMessage[]): ReplayEvent | null {
        if (messages.length < 3) {
            return null;
        }

        const questionMessage = messages[messages.length - 3];
        const assistantMessage = messages[messages.length - 2];
        const toolResultMessage = messages[messages.length - 1];

        if (
            questionMessage.role !== vscode.LanguageModelChatMessageRole.User ||
            assistantMessage.role !== vscode.LanguageModelChatMessageRole.Assistant ||
            toolResultMessage.role !== vscode.LanguageModelChatMessageRole.User
        ) {
            return null;
        }

        const hasQuestionText = questionMessage.content.some(
            part => part instanceof vscode.LanguageModelTextPart && part.value.trim().length > 0
        );
        if (!hasQuestionText) {
            return null;
        }

        const toolCallPart = assistantMessage.content.find(
            part =>
                part instanceof vscode.LanguageModelToolCallPart &&
                part.name === MiniMaxVisionBridge.definition.toolName
        ) as vscode.LanguageModelToolCallPart | undefined;
        if (!toolCallPart) {
            return null;
        }

        const toolResultPart = toolResultMessage.content.find(
            part => part instanceof vscode.LanguageModelToolResultPart && part.callId === toolCallPart.callId
        ) as vscode.LanguageModelToolResultPart | undefined;
        if (!toolResultPart) {
            return null;
        }

        const resultParts = toolResultPart.content.map(part =>
            part instanceof vscode.LanguageModelTextPart ? part : new vscode.LanguageModelTextPart(JSON.stringify(part))
        );

        return {
            callId: toolCallPart.callId,
            name: toolCallPart.name,
            input: (toolCallPart.input as Record<string, unknown>) || {},
            resultParts
        };
    }

    /**
     * Replay image bridge tool results
     * Used to report already-processed bridge results at Anthropic SDK stream start
     *
     * @param messages Message chain
     * @param reportResult Callback function for reporting tool results
     * @returns Whether replay was successful
     */
    static replayVisionBridge(
        messages: readonly vscode.LanguageModelChatMessage[],
        reportResult: (callId: string, resultParts: vscode.LanguageModelTextPart[]) => void
    ): boolean {
        const replayEvent = MiniMaxVisionBridge.extractReplayEvent(messages);
        if (!replayEvent) {
            return false;
        }

        Logger.info(`MiniMax Image Bridge Replay: ${MiniMaxVisionBridge.definition.label} toolCallId: ${replayEvent.callId}`);
        reportResult(replayEvent.callId, replayEvent.resultParts);
        return true;
    }

    /**
     * Collect tool definitions from historical messages
     * Create synthetic tool definitions for tool calls that appeared in historical messages but are not in current tool list.
     * Anthropic API requirement: If message history contains tool_use / tool_result, corresponding tool definitions must appear in tools parameter.
     *
     * @param messages Message chain
     * @param existingToolNames Set of existing tool names
     * @returns Array of synthetic tool definitions
     */
    static collectHistoricalToolDefinitions(
        messages: readonly vscode.LanguageModelChatMessage[],
        existingToolNames: Set<string>
    ): Anthropic.Messages.Tool[] {
        const syntheticTools: Anthropic.Messages.Tool[] = [];

        for (const message of messages) {
            if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) {
                continue;
            }

            for (const part of message.content) {
                if (!(part instanceof vscode.LanguageModelToolCallPart)) {
                    continue;
                }
                if (existingToolNames.has(part.name)) {
                    continue;
                }

                existingToolNames.add(part.name);
                syntheticTools.push({
                    name: part.name,
                    description: `History-only synthetic tool call for ${part.name}`,
                    input_schema: {
                        type: 'object' as const,
                        properties: {},
                        required: []
                    }
                });
            }
        }

        return syntheticTools;
    }
}

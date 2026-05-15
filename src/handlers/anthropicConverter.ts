/*---------------------------------------------------------------------------------------------
 *  Anthropic Message Converter
 *
 *  Main Features:
 *  - Convert VS Code API message format to Anthropic API format
 *  - Support text, images, tool calls and tool results
 *  - Support thinking block conversion to maintain chain-of-thought continuity across multi-turn conversations
 *  - Support cache control and streaming response handling
 *  - Complete error handling and type safety
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { sanitizeToolSchemaForTarget } from '../utils';
import { getReasoningReplayPolicy, shouldInjectReasoningPlaceholder } from './reasoningReplayPolicy';
import { decodeStatefulMarker } from './statefulMarker';
import type {
    ContentBlockParam,
    ThinkingBlockParam,
    RedactedThinkingBlockParam,
    MessageParam,
    TextBlockParam,
    ImageBlockParam,
    ToolResultBlockParam
} from '@anthropic-ai/sdk/resources';
import { ModelConfig } from '../types/sharedTypes';
import { CacheType, CustomDataPartMimeTypes } from './types';

/**
 * Metadata interface for thinking parts
 */
interface ThinkingPartMetadata {
    signature?: string;
    data?: string;
    _completeThinking?: string;
}

/**
 * Type guard - Check if object has mimeType and data properties
 */
function isDataPart(part: unknown): part is vscode.LanguageModelDataPart2 {
    return typeof part === 'object' && part !== null && 'mimeType' in part && 'data' in part;
}

/**
 * Get metadata from thinking part
 */
function getThinkingMetadata(part: vscode.LanguageModelThinkingPart): ThinkingPartMetadata {
    return (part as unknown as { metadata?: ThinkingPartMetadata }).metadata ?? {};
}

function getStatefulMarkerThinking(content: vscode.LanguageModelChatMessage['content']) {
    for (const part of content) {
        if (
            isDataPart(part) &&
            part.mimeType === CustomDataPartMimeTypes.StatefulMarker &&
            part.data instanceof Uint8Array
        ) {
            const marker = decodeStatefulMarker(part.data)?.marker;
            if (marker?.completeThinking) {
                return marker;
            }
        }
    }

    return undefined;
}

function getCompleteThinkingFromStatefulMarker(
    content: vscode.LanguageModelChatMessage['content']
): { thinking?: string; signature: string; hasToolCalls?: boolean } | undefined {
    const marker = getStatefulMarkerThinking(content);
    if (!marker) {
        return undefined;
    }
    return {
        thinking: marker.completeThinking,
        signature: marker.completeSignature || '',
        hasToolCalls: marker.hasToolCalls
    };
}

/**
 * Check if content block supports cache control
 * thinking and redacted_thinking blocks do not support cache control
 */
function contentBlockSupportsCacheControl(
    block: ContentBlockParam
): block is Exclude<ContentBlockParam, ThinkingBlockParam | RedactedThinkingBlockParam> {
    return block.type !== 'thinking' && block.type !== 'redacted_thinking';
}

/**
 * Convert VS Code API message content to Anthropic format
 * Supports thinking content blocks to maintain chain-of-thought continuity across multi-turn conversations
 */
function apiMessageToAnthropicContent(
    message: vscode.LanguageModelChatMessage,
    modelConfig: ModelConfig
): ContentBlockParam[] {
    const content = message.content;
    const thinkingBlocks: ContentBlockParam[] = [];
    const otherBlocks: ContentBlockParam[] = [];

    // Model capability: when imageInput is not supported, must ignore all image/* data blocks.
    const allowImages = modelConfig.capabilities?.imageInput === true;

    for (const part of content) {
        // Thinking content (thinking) - used to maintain chain-of-thought continuity across multi-turn conversations
        if (part instanceof vscode.LanguageModelThinkingPart) {
            const metadata = getThinkingMetadata(part);

            // If it's encrypted thinking content (redacted_thinking)
            if (metadata.data) {
                thinkingBlocks.push({
                    type: 'redacted_thinking',
                    data: metadata.data
                } as RedactedThinkingBlockParam);
            } else {
                // mark: 2025/12/26 Official data transmission has issues, _completeThinking content may be incomplete
                // // Normal thinking content - prefer using _completeThinking (complete thinking content)
                // const thinkingBlock: ThinkingBlockParam = {
                //     type: 'thinking',
                //     thinking: metadata._completeThinking,
                //     signature: metadata.signature || ''
                // };
                // thinkingBlocks.push(thinkingBlock);

                let thinking = metadata?._completeThinking || ''; // use _completeThinking first
                if (typeof part.value === 'string' && part.value.trim() !== '') {
                    const partStr = part.value as string;
                    if (partStr.length > thinking.length) {
                        thinking = partStr;
                    }
                } else if (Array.isArray(part.value) && part.value.length > 0) {
                    const partStr = part.value.join('');
                    if (partStr.length > thinking.length) {
                        thinking = partStr;
                    }
                }

                const thinkingBlock: ThinkingBlockParam = {
                    type: 'thinking',
                    thinking: thinking || ' ', // Anthropic does not accept empty strings, use space
                    signature: metadata.signature || ''
                };
                thinkingBlocks.push(thinkingBlock);
            }
        }
        // Tool call
        else if (part instanceof vscode.LanguageModelToolCallPart) {
            otherBlocks.push({
                type: 'tool_use',
                id: part.callId,
                input: part.input,
                name: part.name
            });
        }
        // Cache control marker
        else if (
            isDataPart(part) &&
            part.mimeType === CustomDataPartMimeTypes.CacheControl &&
            String(part.data) === CacheType
        ) {
            const previousBlock = otherBlocks.at(-1);
            if (previousBlock && contentBlockSupportsCacheControl(previousBlock)) {
                (previousBlock as ContentBlockParam & { cache_control?: { type: string } }).cache_control = {
                    type: CacheType
                };
            } else {
                // Empty string is invalid, use space
                otherBlocks.push({
                    type: 'text',
                    text: ' ',
                    cache_control: { type: CacheType }
                } as ContentBlockParam);
            }
        }
        // Image data
        else if (isDataPart(part) && part.mimeType.startsWith('image/')) {
            // Skip StatefulMarker
            if (part.mimeType === CustomDataPartMimeTypes.StatefulMarker) {
                continue;
            }
            if (allowImages) {
                otherBlocks.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        data: Buffer.from(part.data as Uint8Array).toString('base64'),
                        media_type: part.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
                    }
                } as ImageBlockParam);
            } else {
                // When model does not support images, add placeholder
                otherBlocks.push({ type: 'text', text: '[Image]' } as TextBlockParam);
            }
        }
        // Tool result
        else if (
            part instanceof vscode.LanguageModelToolResultPart ||
            (part as unknown as { callId?: string }).callId !== undefined
        ) {
            // Support LanguageModelToolResultPart and LanguageModelToolResultPart2
            const toolPart = part as unknown as {
                callId: string;
                content: (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[];
            };
            const convertedContents: (TextBlockParam | ImageBlockParam)[] = [];

            for (const p of toolPart.content) {
                if (p instanceof vscode.LanguageModelTextPart) {
                    convertedContents.push({ type: 'text', text: p.value });
                    continue;
                }

                if (
                    isDataPart(p) &&
                    p.mimeType === CustomDataPartMimeTypes.CacheControl &&
                    String(p.data) === CacheType
                ) {
                    const previousBlock = convertedContents.at(-1);
                    if (previousBlock) {
                        previousBlock.cache_control = { type: CacheType };
                    } else {
                        // Empty string is invalid, use space
                        convertedContents.push({ type: 'text', text: ' ', cache_control: { type: CacheType } });
                    }
                    continue;
                }

                if (isDataPart(p) && p.mimeType.startsWith('image/')) {
                    if (!allowImages) {
                        // When model does not support images, add placeholder
                        convertedContents.push({ type: 'text', text: '[Image]' });
                        continue;
                    }
                    convertedContents.push({
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: p.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                            data: Buffer.from(p.data as Uint8Array).toString('base64')
                        }
                    });
                    continue;
                }
            }

            const block: ToolResultBlockParam = {
                type: 'tool_result',
                tool_use_id: toolPart.callId,
                content: convertedContents
            };
            otherBlocks.push(block);
        }
        // Text content
        else if (part instanceof vscode.LanguageModelTextPart) {
            // Anthropic throws error on empty strings, skip empty text parts
            if (part.value === '') {
                continue;
            }
            otherBlocks.push({
                type: 'text',
                text: part.value
            });
        }
    }

    if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
        const reasoningReplayPolicy = getReasoningReplayPolicy({
            providerKey: modelConfig.provider,
            modelConfig
        });
        // If VS Code stripped the ThinkingPart, recover from StatefulMarker for compatible models that need reasoning replay.
        if (thinkingBlocks.length === 0 && reasoningReplayPolicy.restoreFromStatefulMarker) {
            const markerThinking = getCompleteThinkingFromStatefulMarker(content);
            const hasToolCalls = otherBlocks.some(block => block.type === 'tool_use');
            if (
                markerThinking?.thinking ||
                shouldInjectReasoningPlaceholder(reasoningReplayPolicy, hasToolCalls, markerThinking?.hasToolCalls)
            ) {
                thinkingBlocks.push({
                    type: 'thinking',
                    thinking: markerThinking?.thinking || ' ',
                    signature: markerThinking?.signature || ''
                } as ThinkingBlockParam);
            }
        }
    }

    // Important: thinking blocks must be at the beginning (Anthropic API requirement)
    return [...thinkingBlocks, ...otherBlocks];
}

/**
 * Convert VS Code API message to Anthropic format
 */
export function apiMessageToAnthropicMessage(
    model: ModelConfig,
    messages: readonly vscode.LanguageModelChatMessage[]
): {
    messages: MessageParam[];
    system: TextBlockParam;
} {
    const unmergedMessages: MessageParam[] = [];
    const systemMessage: TextBlockParam = {
        type: 'text',
        text: ''
    };

    for (const message of messages) {
        if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
            unmergedMessages.push({
                role: 'assistant',
                content: apiMessageToAnthropicContent(message, model)
            });
        } else if (message.role === vscode.LanguageModelChatMessageRole.User) {
            unmergedMessages.push({
                role: 'user',
                content: apiMessageToAnthropicContent(message, model)
            });
        } else if (message.role === vscode.LanguageModelChatMessageRole.System) {
            systemMessage.text += message.content
                .map(p => {
                    if (p instanceof vscode.LanguageModelTextPart) {
                        return p.value;
                    } else if (
                        'data' in p &&
                        'mimeType' in p &&
                        p.mimeType === CustomDataPartMimeTypes.CacheControl &&
                        (p.data as Uint8Array).toString() === CacheType
                    ) {
                        (systemMessage as TextBlockParam & { cache_control?: { type: string } }).cache_control = {
                            type: CacheType
                        };
                    }
                    return '';
                })
                .join('');
        }
    }

    // Merge consecutive messages with the same role
    const mergedMessages: MessageParam[] = [];
    for (const message of unmergedMessages) {
        if (mergedMessages.length === 0 || mergedMessages[mergedMessages.length - 1].role !== message.role) {
            mergedMessages.push(message);
        } else {
            const prevMessage = mergedMessages[mergedMessages.length - 1];
            if (Array.isArray(prevMessage.content) && Array.isArray(message.content)) {
                (prevMessage.content as ContentBlockParam[]).push(...(message.content as ContentBlockParam[]));
            }
        }
    }

    // Unified logic for cleaning up cache_control
    // 1. Nested + within each block: move cache_control from nested to outer level, and keep only the last one within each block
    // 2. Global: keep only the last cache_control within blocks of each message (across messages when i>0, keep only one)
    let foundLastBlock = false;
    for (let i = mergedMessages.length - 1; i >= 0; i--) {
        const msg = mergedMessages[i];
        if (!Array.isArray(msg.content)) {
            continue;
        }
        const blocks = msg.content;

        // 1. Handle nested content, and keep only the last cache within each block
        for (const block of blocks) {
            if ('content' in block && Array.isArray(block.content)) {
                let foundInBlock = false;
                for (let k = block.content.length - 1; k >= 0; k--) {
                    const nested = block.content[k];
                    if ('cache_control' in nested && nested.cache_control) {
                        if (!foundInBlock) {
                            block.cache_control = nested.cache_control;
                            foundInBlock = true;
                        }
                        delete nested.cache_control;
                    }
                }
            }
        }

        // 2. Global: keep only the last cache_control within blocks of each message (across messages when i>0, keep only one)
        let foundInMessage = false;
        for (let k = blocks.length - 1; k >= 0; k--) {
            const block = blocks[k];
            if ('cache_control' in block && block.cache_control) {
                if (i === 0) {
                    // When i=0, keep only the last one within each message
                    if (foundInMessage) {
                        delete block.cache_control;
                    } else {
                        foundInMessage = true;
                    }
                } else {
                    // When i>0, keep only one across messages
                    if (foundLastBlock || foundInMessage) {
                        delete block.cache_control;
                    } else {
                        foundInMessage = true;
                        foundLastBlock = true;
                    }
                }
            }
        }
    }

    return { messages: mergedMessages, system: systemMessage };
}

/**
 * Convert tool definitions to Anthropic format
 */
export function convertToAnthropicTools(tools: readonly vscode.LanguageModelChatTool[]): Anthropic.Messages.Tool[] {
    return tools.map(tool => {
        const inputSchema = tool.inputSchema as Anthropic.Messages.Tool.InputSchema | undefined;

        if (!inputSchema) {
            return {
                name: tool.name,
                description: tool.description || '',
                input_schema: {
                    type: 'object' as const,
                    properties: {},
                    required: []
                }
            };
        }

        const sanitized = sanitizeToolSchemaForTarget(inputSchema, 'anthropic');
        return {
            name: tool.name,
            description: tool.description || '',
            input_schema: {
                type: 'object' as const,
                properties: sanitized.properties ?? {},
                required: sanitized.required ?? [],
                ...(sanitized.additionalProperties !== undefined && {
                    additionalProperties: sanitized.additionalProperties
                })
            }
        };
    });
}

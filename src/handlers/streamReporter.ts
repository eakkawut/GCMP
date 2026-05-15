/*---------------------------------------------------------------------------------------------
 *  Unified Streaming Response Reporter
 *  Provides unified progress.report strategy for all Handlers
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { Logger } from '../utils';
import { encodeStatefulMarker, StatefulMarkerContainer } from './statefulMarker';
import { toOptionalStatefulMarkerField } from './statefulMarkerCodec';
import { CustomDataPartMimeTypes } from './types';

/** Thinking content buffer threshold (character count) */
const THINKING_BUFFER_LENGTH = 20;
/** Text content buffer threshold (character count) */
const TEXT_BUFFER_LENGTH = 20;

/**
 * Tool call buffer structure
 */
interface ToolCallBuffer {
    id?: string;
    name?: string;
    arguments: string;
}

/**
 * StreamReporter configuration options
 */
export interface StreamReporterOptions {
    /** Model display name */
    modelName: string;
    /** Model ID */
    modelId: string;
    /** Provider name */
    provider: string;
    /** SDK mode */
    sdkMode: StatefulMarkerContainer['sdkMode'];
    /** Progress reporter */
    progress: vscode.Progress<vscode.LanguageModelResponsePart2>;
    /** Session ID (optional, auto-generated if not provided) */
    sessionId?: string;
}

export type StatefulMarkerPartial = Omit<StatefulMarkerContainer, 'extension' | 'provider' | 'modelId' | 'sdkMode'>;

/**
 * Unified streaming response reporter
 *
 * Strategy:
 * - text: Buffer and batch output LanguageModelTextPart after accumulating 20 characters
 * - thinking: Buffer and batch output LanguageModelThinkingPart after accumulating 20 characters
 * - tool_calls: Immediately output LanguageModelToolCallPart after completion detected in accumulateToolCall
 * - datapart: Output StatefulMarker DataPart at stream end
 */
export class StreamReporter {
    private readonly modelName: string;
    private readonly modelId: string;
    private readonly provider: string;
    private readonly sdkMode: StatefulMarkerContainer['sdkMode'];
    private readonly progress: vscode.Progress<vscode.LanguageModelResponsePart2>;

    // State tracking
    private hasReceivedContent = false;
    private hasThinkingContent = false;
    private hasReceivedTextDelta = false; // Flag indicating whether text delta has been received
    private hasReceivedThinkingDelta = false; // Flag indicating whether thinking delta has been received

    // Chain-of-thought state
    private currentThinkingId: string | null = null;
    private thinkingBuffer = '';
    private completeThinkingBuffer = '';

    // Text buffer state
    private textBuffer = '';

    // Tool call buffer
    private readonly toolCallsBuffer = new Map<number, ToolCallBuffer>();
    private hasToolCalls = false;

    // Session state
    private sessionId: string;
    private responseId: string | null = null;

    // Anthropic specific: signature buffer
    private signatureBuffer = '';
    // Signature accumulation buffer (independent of flush, used for StatefulMarker persistence)
    private completeSignatureBuffer = '';

    // Gemini specific: thought signature
    private thoughtSignature: string | null = null;

    constructor(options: StreamReporterOptions) {
        this.modelName = options.modelName;
        this.modelId = options.modelId;
        this.provider = options.provider;
        this.sdkMode = options.sdkMode;
        this.progress = options.progress;
        this.sessionId = options.sessionId || crypto.randomUUID();
    }

    /**
     * Set response ID (extracted from id field of first chunk)
     */
    setResponseId(id: string): void {
        if (!this.responseId) {
            this.responseId = id;
        }
    }

    /**
     * Report text content (output after accumulating to threshold, for delta events)
     */
    reportText(content: string): void {
        // Before outputting content, flush remaining thinking and end chain-of-thought
        this.flushThinking('Before outputting content');
        this.endThinkingChain();

        // Accumulate text content
        this.textBuffer += content;
        this.hasReceivedContent = true;
        this.hasReceivedTextDelta = true; // Flag indicating text delta has been received

        // Output when threshold is reached
        if (this.textBuffer.length >= TEXT_BUFFER_LENGTH) {
            this.progress.report(new vscode.LanguageModelTextPart(this.textBuffer));
            this.textBuffer = '';
        }
    }

    /**
     * Directly report complete tool call (for scenarios returning complete tool call)
     */
    reportToolCall(callId: string, name: string, args: Record<string, unknown> | object): void {
        // Before outputting tool call, flush remaining thinking and text, and end chain-of-thought
        this.flushThinking('Before outputting tool call');
        this.flushText('Before outputting tool call');
        this.endThinkingChain();

        // If thoughtSignature exists, output an empty ThinkingPart with signature (no ID)
        if (this.thoughtSignature) {
            this.progress.report(
                new vscode.LanguageModelThinkingPart('', undefined, {
                    signature: this.thoughtSignature
                })
            );
            this.thoughtSignature = null; // Clear the used signature
        }

        this.progress.report(new vscode.LanguageModelToolCallPart(callId, name, args));
        this.hasReceivedContent = true;
        this.hasToolCalls = true;

        Logger.info(`[${this.modelName}] Successfully processed tool call: ${name} toolCallId: ${callId}`);
    }

    /**
     * Directly report complete tool result (for native server tool scenarios)
     */
    reportToolResult(callId: string, content: string | vscode.LanguageModelTextPart[]): void {
        this.flushThinking('Before outputting tool result');
        this.flushText('Before outputting tool result');
        this.endThinkingChain();

        const parts = typeof content === 'string' ? [new vscode.LanguageModelTextPart(content)] : content;
        this.progress.report(new vscode.LanguageModelToolResultPart(callId, parts));
        this.hasReceivedContent = true;
    }

    /**
     * Buffer thinking content (output after accumulating to threshold, for delta events)
     */
    bufferThinking(content: string): void {
        // If no thinking id currently, generate one
        if (!this.currentThinkingId) {
            this.currentThinkingId = `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            Logger.trace(`[${this.modelName}] Created new thinking chain ID: ${this.currentThinkingId}`);
        }

        this.thinkingBuffer += content;
        this.completeThinkingBuffer += content;
        this.hasThinkingContent = true;
        this.hasReceivedThinkingDelta = true; // Flag indicating thinking delta has been received

        // Output when threshold is reached
        if (this.thinkingBuffer.length >= THINKING_BUFFER_LENGTH) {
            this.progress.report(new vscode.LanguageModelThinkingPart(this.thinkingBuffer, this.currentThinkingId));
            this.thinkingBuffer = '';
        }
    }

    /**
     * Buffer complete thinking content (for done events)
     * Only output if no delta event has been received (to avoid duplication)
     */
    bufferThinkingIfNotDelta(content: string): void {
        if (this.hasReceivedThinkingDelta) {
            return; // If delta has already been received, ignore done event
        }
        this.bufferThinking(content);
    }

    /**
     * Accumulate tool call data (with deduplication)
     * Report immediately when tool call completion is detected
     */
    accumulateToolCall(
        index: number,
        id: string | undefined,
        name: string | undefined,
        argsFragment: string | undefined
    ): void {
        // Skip null values, do not create invalid tool call buffer
        if (!id && !name && !argsFragment) {
            return;
        }

        // Get or create tool call buffer
        let bufferedTool = this.toolCallsBuffer.get(index);
        if (!bufferedTool) {
            // Before tool call starts, flush remaining thinking and text, and end chain-of-thought
            this.flushThinking('Tool call starting');
            this.flushText('Tool call starting');
            this.endThinkingChain();

            bufferedTool = { arguments: '' };
            this.toolCallsBuffer.set(index, bufferedTool);
            Logger.trace(`🔧 [${this.modelName}] Tool call started: ${name || 'unknown'} (index: ${index})`);
        }

        // Accumulate data
        if (id) {
            bufferedTool.id = id;
        }
        if (name) {
            bufferedTool.name = name;
        }
        if (argsFragment) {
            bufferedTool.arguments = this.deduplicateToolArgs(bufferedTool.arguments, argsFragment);
        }

        // Check if tool call is complete (has complete JSON)
        if (bufferedTool.name && bufferedTool.arguments) {
            try {
                // Try to parse arguments, if successful means tool call is complete
                const args = JSON.parse(bufferedTool.arguments);

                // Ensure previous thinking and signature have been output
                this.flushThinking('Before tool call completion');
                if (this.signatureBuffer) {
                    this.flushSignature();
                }

                // Use UUID to generate unique ID (if no id)
                const toolCallId = bufferedTool.id || crypto.randomUUID();

                // If thoughtSignature exists, output an empty ThinkingPart with signature
                if (this.thoughtSignature) {
                    this.progress.report(
                        new vscode.LanguageModelThinkingPart('', undefined, {
                            signature: this.thoughtSignature
                        })
                    );
                    this.thoughtSignature = null;
                }

                // Immediately report tool call
                this.progress.report(new vscode.LanguageModelToolCallPart(toolCallId, bufferedTool.name, args));
                this.hasReceivedContent = true;
                this.hasToolCalls = true;

                // Remove processed tool call from buffer
                this.toolCallsBuffer.delete(index);

                Logger.info(`[${this.modelName}] Successfully processed tool call: ${bufferedTool.name} toolCallId: ${toolCallId}`);
            } catch {
                // JSON parsing failed, tool call not yet complete, continue accumulating
                // Logger.trace(`[${this.modelName}] Tool call arguments not complete, continuing to accumulate: ${bufferedTool.name}`);
            }
        }
    }

    /**
     * Deduplicate tool call arguments (handle duplicate fragments from DeepSeek and other APIs)
     */
    private deduplicateToolArgs(existing: string, newArgs: string): string {
        // Only perform complete deduplication for fragments with length >= 2, to avoid single characters (like ", ,, }) being falsely matched as duplicates
        // For example, when accumulated to ...\" the trailing character is ", the passed single character " would be endsWith matched and discarded,
        // causing JSON string to miss closing quote, ultimately failing to parse
        if (newArgs.length >= 2 && existing.endsWith(newArgs)) {
            Logger.trace(`[${this.modelName}] Skipping duplicate tool call arguments: "${newArgs}"`);
            return existing;
        }
        // New data contains old data (complete duplicate + new), only take the new part
        if (existing.length > 0 && newArgs.startsWith(existing)) {
            return newArgs;
        }
        // Normal accumulation
        return existing + newArgs;
    }

    /**
     * Anthropic specific: Buffer signature content
     */
    bufferSignature(content: string): void {
        this.signatureBuffer += content;
        this.completeSignatureBuffer += content;
    }

    /**
     * Anthropic specific: Output complete signature and associate with current thinking
     */
    flushSignature(): void {
        if (this.signatureBuffer && this.currentThinkingId) {
            // Signature passed as metadata, not as text content
            this.progress.report(
                new vscode.LanguageModelThinkingPart('', this.currentThinkingId, {
                    signature: this.signatureBuffer
                })
            );
            Logger.trace(`[${this.modelName}] Output signature metadata: ${this.signatureBuffer.length} characters`);
        }
        this.signatureBuffer = '';
    }

    /**
     * Gemini specific: Set thought signature (for associating with tool call)
     */
    setThoughtSignature(signature: string): void {
        this.thoughtSignature = signature;
    }

    /**
     * Output remaining thinking content (public method)
     */
    flushThinking(_context: string): void {
        if (this.thinkingBuffer.length > 0 && this.currentThinkingId) {
            this.progress.report(new vscode.LanguageModelThinkingPart(this.thinkingBuffer, this.currentThinkingId));
            // Logger.trace(`[${this.modelName}] Reporting remaining thinking content at ${_context}: ${this.thinkingBuffer.length} characters`);
            // Clear buffer
            this.thinkingBuffer = '';
        }
        // Note: Do not reset currentThinkingId here, maintain thinking chain continuity
    }

    /**
     * Output remaining text content (public method)
     */
    flushText(_context: string): void {
        if (this.textBuffer.length > 0) {
            this.progress.report(new vscode.LanguageModelTextPart(this.textBuffer));
            // Logger.trace(`[${this.modelName}] Reporting remaining text content at ${_context}: ${this.textBuffer.length} characters`);
            // Clear buffer
            this.textBuffer = '';
        }
    }

    /**
     * OpenAI Responses API specific: Output encrypted thinking content
     * Also serves as placeholder displayed to user, and stores encryptedContent in metadata for next turn relay
     * @param encryptedContent Encrypted content (encrypted_content)
     * @param reasoningId Original id of reasoning item, official implementation must retain this id for relay (extractThinkingData)
     * @param summaryText Summary text, only pass when not streamed to avoid duplication (default displays as placeholder)
     */
    reportEncryptedThinking(encryptedContent: string, reasoningId?: string, summaryText?: string[]): void {
        if (!encryptedContent) {
            return;
        }
        // Ensure to end previous chain-of-thought first
        this.flushThinking('encrypted thinking');
        this.endThinkingChain();
        // Placeholder text + redactedData + reasoningId metadata merged into one ThinkingPart
        // id uses undefined (not added to streaming chain), reasoningId only stored in metadata for reconstruction
        const text = summaryText?.join('\n') || '';
        this.progress.report(
            new vscode.LanguageModelThinkingPart(text, undefined, {
                redactedData: encryptedContent,
                reasoningId: reasoningId
            })
        );
        this.hasThinkingContent = true;
    }

    /**
     * End current chain-of-thought (output empty ThinkingPart)
     * Public method, allows manually ending chain-of-thought in Responses API scenarios
     */
    endThinkingChain(): void {
        if (this.currentThinkingId) {
            this.progress.report(new vscode.LanguageModelThinkingPart('', this.currentThinkingId));
            Logger.trace(`[${this.modelName}] Ending thinking chain: ${this.currentThinkingId}`);
            this.currentThinkingId = null;
        }
    }

    /**
     * Output all tool calls (fallback method, for handling incomplete tool calls at stream end)
     * Under normal circumstances, tool calls are reported immediately when completed in accumulateToolCall
     */
    private flushToolCalls(): boolean {
        let toolProcessed = false;
        for (const [toolIndex, bufferedTool] of this.toolCallsBuffer.entries()) {
            if (bufferedTool.name && bufferedTool.arguments) {
                try {
                    const args = JSON.parse(bufferedTool.arguments);
                    // Use UUID to generate unique ID, avoid duplication during parallel calls
                    const toolCallId = bufferedTool.id || crypto.randomUUID();

                    this.progress.report(new vscode.LanguageModelToolCallPart(toolCallId, bufferedTool.name, args));
                    this.hasToolCalls = true;

                    Logger.info(`[${this.modelName}] Successfully processed tool call: ${bufferedTool.name} toolCallId: ${toolCallId}`);
                    toolProcessed = true;
                } catch (error) {
                    Logger.error(`[${this.modelName}] Failed to parse tool call arguments: ${bufferedTool.name} error: ${error}`);
                }
            } else {
                Logger.warn(
                    `[${this.modelName}] Incomplete tool call [${toolIndex}]: name=${bufferedTool.name}, args_length=${bufferedTool.arguments.length}`
                );
            }
        }
        return toolProcessed;
    }

    /**
     * Report StatefulMarker DataPart
     */
    private reportStatefulMarker(statefulMarkerData?: StatefulMarkerPartial): void {
        const completeThinking = toOptionalStatefulMarkerField(this.completeThinkingBuffer);
        const completeSignature = toOptionalStatefulMarkerField(this.completeSignatureBuffer);
        const marker = encodeStatefulMarker(this.modelId, {
            ...Object.assign(
                {
                    sessionId: this.sessionId,
                    responseId: this.responseId
                },
                statefulMarkerData
            ),
            completeThinking,
            completeSignature,
            hasToolCalls: this.hasToolCalls,
            provider: this.provider,
            modelId: this.modelId,
            sdkMode: this.sdkMode
        });
        this.progress.report(new vscode.LanguageModelDataPart(marker, CustomDataPartMimeTypes.StatefulMarker));
    }

    /**
     * Complete stream processing, output all remaining content
     * @param finishReason Finish reason
     * @param customStatefulData Custom StatefulMarker data (optional, for Responses API and other special scenarios)
     * @returns Whether content was output
     */
    flushAll(finishReason: string | null, customStatefulData?: StatefulMarkerPartial): boolean {
        if (finishReason) {
            Logger.debug(`[${this.modelName}] Stream ended, reason: ${finishReason}`);
        }

        // 1. Output remaining thinking content (except for length)
        if (finishReason !== 'length') {
            this.flushThinking('Before stream end');
        }

        // 2. Output remaining signature (Anthropic specific, follows thinking content)
        if (this.signatureBuffer) {
            this.flushSignature();
        }

        // 3. End chain-of-thought (before tool calls)
        this.endThinkingChain();

        // 4. Output remaining text content
        this.flushText('Before stream end');

        // 5. Handle incomplete tool calls (if any)
        if (this.toolCallsBuffer.size > 0) {
            Logger.warn(`[${this.modelName}] Still have ${this.toolCallsBuffer.size} incomplete tool calls at stream end`);
            this.flushToolCalls();
        }

        // 6. Handle \n placeholder (only add when no content at all)
        if (this.hasThinkingContent && !this.hasReceivedContent) {
            this.progress.report(new vscode.LanguageModelTextPart('\n'));
            Logger.warn(`[${this.modelName}] Message stream ended with only thinking content and no text content, added \\n placeholder as output`);
        }

        // 7. Report StatefulMarker
        this.reportStatefulMarker(customStatefulData);

        return this.hasReceivedContent;
    }

    /**
     * Get whether content has been received
     */
    get hasContent(): boolean {
        return this.hasReceivedContent;
    }

    /**
     * Get session ID
     */
    getSessionId(): string {
        return this.sessionId;
    }

    /**
     * Get response ID
     */
    getResponseId(): string | null {
        return this.responseId;
    }

    /**
     * Get model name
     */
    getModelName(): string {
        return this.modelName;
    }
}

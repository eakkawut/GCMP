/*---------------------------------------------------------------------------------------------
 *  Gemini Converter
 *  Convert VS Code LLM interface structures to Gemini HTTP (GenerateContent) request structures
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { GeminiContent, GeminiPart, GeminiTool } from './geminiType';
import { sanitizeToolSchemaForTarget } from '../utils';

function getThinkingSignature(part: vscode.LanguageModelThinkingPart): string {
    const meta = (part as unknown as { metadata?: { signature?: unknown } }).metadata;
    const sig = meta && typeof meta.signature === 'string' ? meta.signature : '';
    return sig || '';
}

/**
 * Convert VS Code's tools (LanguageModelChatTool) to Gemini `tools.functionDeclarations`.
 *
 * Key points:
 * - VS Code tool's `inputSchema` is JSON Schema, needs to be converted to Gemini Schema (type with uppercase enums).
 * - For tools missing schema, provide a minimal usable OBJECT schema to avoid gateway rejecting requests.
 */
export function convertToolsToGemini(tools?: readonly vscode.LanguageModelChatTool[]): GeminiTool[] {
    // Purpose: Convert tool schema (JSON Schema) provided by VS Code to Gemini functionDeclarations.
    if (!tools || tools.length === 0) {
        return [];
    }

    return [
        {
            functionDeclarations: tools.map(t => {
                if (!t.inputSchema || typeof t.inputSchema !== 'object') {
                    return {
                        name: t.name,
                        description: t.description,
                        parameters: {
                            type: 'OBJECT',
                            properties: {},
                            required: []
                        }
                    };
                }
                return {
                    name: t.name,
                    description: t.description,
                    parameters: sanitizeToolSchemaForTarget(t.inputSchema as Record<string, unknown>, 'gemini')
                };
            })
        }
    ];
}

export function convertMessagesToGemini(messages: readonly vscode.LanguageModelChatMessage[]): {
    contents: GeminiContent[];
    systemInstruction: string;
} {
    // Purpose: Convert VS Code's chat message list to Gemini's contents + systemInstruction.
    // Key point: Gemini's tool response needs to be a separate user turn with order aligned to functionCall.
    const contents: GeminiContent[] = [];
    let systemInstruction = '';

    const toolNameByCallId = new Map<string, string>();

    const collectText = (m: vscode.LanguageModelChatMessage): string => {
        // Purpose: Summarize text/(optional) thinking in a message into plain text.
        const parts: string[] = [];
        for (const p of m.content ?? []) {
            if (p instanceof vscode.LanguageModelTextPart) {
                parts.push(p.value);
            } else if (p instanceof vscode.LanguageModelThinkingPart) {
                const v = Array.isArray(p.value) ? p.value.join('') : p.value;
                if (v) {
                    parts.push(v);
                }
            }
        }
        return parts.join('');
    };

    const extract = (m: vscode.LanguageModelChatMessage) => {
        // Purpose: Split message content into text / images / toolCalls / toolResults for subsequent assembly.
        const textParts: string[] = [];
        const imageParts: vscode.LanguageModelDataPart[] = [];
        const thinkingParts: Array<{ text: string; signature?: string }> = [];
        const toolCalls: Array<{ callId: string; name: string; args: Record<string, unknown> }> = [];
        const toolResults: Array<{ callId: string; outputText: string }> = [];

        for (const part of m.content ?? []) {
            if (part instanceof vscode.LanguageModelTextPart) {
                textParts.push(part.value);
            } else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
                imageParts.push(part);
            } else if (part instanceof vscode.LanguageModelThinkingPart) {
                const v = Array.isArray(part.value) ? part.value.join('') : part.value;
                const signature = getThinkingSignature(part) || undefined;
                thinkingParts.push({ text: v || '', signature });
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                // Key note: Gemini functionResponse requires name, so callId -> name mapping is needed subsequently.
                const callId = part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const args =
                    part.input && typeof part.input === 'object' ? (part.input as Record<string, unknown>) : {};
                toolCalls.push({ callId, name: part.name, args });
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                const callId = part.callId ?? '';
                const outputText = collectToolResultText(part);
                toolResults.push({ callId, outputText });
            }
        }

        return {
            text: textParts.join(''),
            imageParts,
            thinkingParts,
            toolCalls,
            toolResults
        };
    };

    const isToolResultOnly = (extracted: ReturnType<typeof extract>): boolean => {
        // Purpose: Identify messages "containing only tool result" for merging into a single user turn.
        return Boolean(
            extracted.toolResults.length > 0 &&
            !extracted.text &&
            extracted.imageParts.length === 0 &&
            extracted.toolCalls.length === 0
        );
    };

    const toolResultToFunctionResponsePart = (callId: string, outputText: string): GeminiPart | null => {
        // Purpose: Convert VS Code tool result to Gemini functionResponse part.
        // Key note: Try to parse output as JSON object first; fall back to `{ output: string }` on failure.
        if (!callId) {
            return null;
        }
        const name = toolNameByCallId.get(callId);
        if (!name) {
            return null;
        }
        const parsed = tryParseJSONObject(outputText);
        const responseValue: Record<string, unknown> = parsed.ok ? parsed.value : { output: outputText };
        return { functionResponse: { name, response: responseValue } };
    };

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        const role = mapRole(m.role);
        const extracted = extract(m);

        // Purpose: Aggregate system messages into systemInstruction (concatenate multiple system messages).
        if (role === 'system') {
            const sysText = collectText(m).trim();
            if (sysText) {
                systemInstruction = systemInstruction ? `${systemInstruction}\n${sysText}` : sysText;
            }
            continue;
        }

        // Purpose: Merge consecutive tool results into a single user turn (Gemini requirement).
        if (isToolResultOnly(extracted)) {
            // Key note: Gemini tool response must be as user role, submitting multiple functionResponse at once.
            const respParts: GeminiPart[] = [];
            let j = i;
            while (j < messages.length) {
                const ex2 = extract(messages[j]);
                if (!isToolResultOnly(ex2)) {
                    break;
                }
                for (const tr of ex2.toolResults) {
                    const part = toolResultToFunctionResponsePart(tr.callId, tr.outputText);
                    if (part) {
                        respParts.push(part);
                    }
                }
                j++;
            }
            if (respParts.length > 0) {
                contents.push({ role: 'user', parts: respParts });
            }
            i = j - 1;
            continue;
        }

        // Purpose: Convert regular user messages (text + images) to Gemini user contents.
        if (role === 'user') {
            // Key note: Here text and images are merged into one user turn to ensure semantic consistency.
            const parts: GeminiPart[] = [];
            const t = extracted.text.trim();
            if (t) {
                parts.push({ text: t });
            }
            for (const img of extracted.imageParts) {
                const data = Buffer.from(img.data).toString('base64');
                parts.push({ inlineData: { mimeType: img.mimeType, data } });
            }
            if (parts.length > 0) {
                contents.push({ role: 'user', parts });
            }
            continue;
        }

        // Purpose: Convert assistant messages to Gemini model contents, and convert tool calls to functionCall.
        const parts: GeminiPart[] = [];

        let lastThinkingSignature: string | undefined;
        for (const tp of extracted.thinkingParts) {
            // Preserve signature for subsequent functionCall association
            lastThinkingSignature = tp.signature;
            const t = (tp.text || '').trim();
            if (t) {
                parts.push({
                    thought: true,
                    text: t,
                    thoughtSignature: tp.signature,
                    thought_signature: tp.signature
                });
            }
        }

        const assistantText = extracted.text.trim();
        if (assistantText) {
            parts.push({ text: assistantText });
        }

        const callOrder: Array<{ callId: string; name: string }> = [];
        for (const tc of extracted.toolCalls) {
            toolNameByCallId.set(tc.callId, tc.name);
            callOrder.push({ callId: tc.callId, name: tc.name });

            // Gemini CLI/some gateways require functionCall with thought signature.
            // Prefer using the most recent thinking signature from the same assistant message
            parts.push({
                functionCall: { name: tc.name, args: tc.args },
                thoughtSignature: lastThinkingSignature,
                thought_signature: lastThinkingSignature
            });
        }

        if (parts.length > 0) {
            contents.push({ role: 'model', parts });
        }

        // Purpose: Ensure tool response as a single user turn, with order consistent with preceding functionCall.
        if (callOrder.length > 0) {
            // Key note: Reorder tool response by callOrder to avoid gateway rejection due to order inconsistency.
            const responsesByCallId = new Map<string, GeminiPart>();
            let j = i + 1;
            while (j < messages.length) {
                const ex2 = extract(messages[j]);
                if (!isToolResultOnly(ex2)) {
                    break;
                }
                for (const tr of ex2.toolResults) {
                    const part = toolResultToFunctionResponsePart(tr.callId, tr.outputText);
                    if (part) {
                        responsesByCallId.set(tr.callId, part);
                    }
                }
                j++;
            }
            if (responsesByCallId.size > 0) {
                const respParts: GeminiPart[] = [];
                for (const c of callOrder) {
                    const rp = responsesByCallId.get(c.callId);
                    if (rp) {
                        respParts.push(rp);
                    }
                }
                if (respParts.length > 0) {
                    contents.push({ role: 'user', parts: respParts });
                    i = j - 1;
                }
            }
        }
    }

    return { contents, systemInstruction };
}

/**
 * Convert VS Code's role enum to semantic role.
 * Note: Gemini contents' role actually uses 'user' | 'model'; 'assistant' is retained here for upper-level mapping.
 */
function mapRole(role: number): 'user' | 'assistant' | 'system' {
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

/** Only process image DataPart (mimeType starting with image/) */
function isImageMimeType(mimeType: string | undefined): boolean {
    if (!mimeType) {
        return false;
    }
    return mimeType.startsWith('image/');
}

/**
 * Summarize tool result content into string.
 * Key point: content may contain TextPart and other structures, use JSON.stringify as much as possible to preserve information.
 */
function collectToolResultText(part: vscode.LanguageModelToolResultPart): string {
    if (!part.content || part.content.length === 0) {
        return '';
    }
    const texts: string[] = [];
    for (const item of part.content) {
        if (item instanceof vscode.LanguageModelTextPart) {
            texts.push(item.value);
        } else if (item && typeof item === 'object') {
            try {
                texts.push(JSON.stringify(item));
            } catch {
                texts.push(String(item));
            }
        }
    }
    return texts.join('');
}

/**
 * Try to parse string into JSON object (only accept object, not array).
 * Purpose: Construct structured response for Gemini functionResponse.
 */
function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
    const v = (text || '').trim();
    if (!v) {
        return { ok: false };
    }
    if (!v.startsWith('{') && !v.startsWith('[')) {
        return { ok: false };
    }
    try {
        const parsed = JSON.parse(v);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { ok: true, value: parsed as Record<string, unknown> };
        }
        return { ok: false };
    } catch {
        return { ok: false };
    }
}

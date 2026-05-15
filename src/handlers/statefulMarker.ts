/*---------------------------------------------------------------------------------------------
 *  Stateful Marker Handler in Model Messages
 *  Reference: Microsoft vscode-copilot-chat src/platform/endpoint/common/statefulMarkerContainer.tsx
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CustomDataPartMimeTypes } from './types';
import { decodeStatefulMarkerPayload, encodeStatefulMarkerPayload } from './statefulMarkerCodec';

export interface IStatefulMarkerContainer {
    type: typeof CustomDataPartMimeTypes.StatefulMarker;
    value: StatefulMarkerWithModel;
}

const StatefulMarkerExtension = 'guokoko.ccmp';
type StatefulMarkerExtension = 'guokoko.ccmp';
export interface StatefulMarkerContainer {
    extension: StatefulMarkerExtension;
    provider: string;
    modelId: string;
    sdkMode: 'openai' | 'openai-responses' | 'anthropic' | 'gemini';
    /** Session ID, identifies session context */
    sessionId: string;
    /** Response ID, model's response identifier */
    responseId: string;
    /** Record expiration time, in milliseconds (for Doubao/Volcengine only) */
    expireAt?: number;
    /** Complete thinking content that needs to be stably relayed across turns */
    completeThinking?: string;
    /** Complete signature content that needs to be stably relayed across turns (accumulated from signature_delta) */
    completeSignature?: string;
    /** Whether tool calls occurred in the current assistant turn */
    hasToolCalls?: boolean;
}

export interface StatefulMarkerWithModel {
    /** This value is unreliable and does not represent the actually used model ID */
    modelId: string;
    /** The marker actually passed and saved */
    marker: StatefulMarkerContainer;
}

export function encodeStatefulMarker(modelId: string, marker: Omit<StatefulMarkerContainer, 'extension'>): Uint8Array {
    // MARK: copilot internally always automatically handles modelId, whatever modelId is passed here will be reset
    //       We only need to ensure the marker data is passed through

    return encodeStatefulMarkerPayload(modelId, { ...marker, extension: StatefulMarkerExtension });
}

export function decodeStatefulMarker(data: Uint8Array): StatefulMarkerWithModel | undefined {
    // MARK: The modelId obtained here is always the value reset by copilot internally
    return decodeStatefulMarkerPayload<StatefulMarkerContainer>(data);
}

/** Get stateful markers from messages, from most to least recent */
export function* getAllStatefulMarkersAndIndicies(messages: readonly vscode.LanguageModelChatMessage[]) {
    for (let idx = messages.length - 1; idx >= 0; idx--) {
        const message = messages[idx];
        if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
            for (const part of message.content) {
                if (
                    part instanceof vscode.LanguageModelDataPart &&
                    part.mimeType === CustomDataPartMimeTypes.StatefulMarker
                ) {
                    const statefulMarker = decodeStatefulMarker(part.data);
                    if (statefulMarker) {
                        yield { statefulMarker: statefulMarker, index: idx };
                    }
                }
            }
        }
    }
    return undefined;
}

export function getStatefulMarkerAndIndex(
    modelId: string,
    sdkType: StatefulMarkerContainer['sdkMode'],
    messages: readonly vscode.LanguageModelChatMessage[]
): { statefulMarker: StatefulMarkerContainer; index: number } | undefined {
    for (const statefulMarker of getAllStatefulMarkersAndIndicies(messages)) {
        const marker = statefulMarker.statefulMarker?.marker;
        if (marker?.extension === StatefulMarkerExtension && marker?.sessionId) {
            if (marker?.sdkMode === sdkType && marker?.modelId === modelId) {
                return { statefulMarker: marker, index: statefulMarker.index };
            }
        }
    }
    return undefined;
}

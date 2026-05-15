/*---------------------------------------------------------------------------------------------
 *  This file contains classes implemented for creating FIM / NES required parameters, but are empty implementations with no actual usage.
 *  These classes are only used to satisfy the VS Code chat-lib library interface requirements, allowing the extension to initialize properly.
 *
 *  Empty implementations included:
 *  - AuthenticationService: Authentication service implementation, no actual verification logic
 *  - TelemetrySender: Telemetry sender implementation, does not send any data
 *  - EndpointProvider: Official example parameter passing, currently has no specific purpose, kept for now
 *
 *  Reference: Test examples in getInlineCompletions.spec.ts and nesProvider.spec.ts
 *--------------------------------------------------------------------------------------------*/

import type { AuthenticationGetSessionOptions, AuthenticationSession, ChatRequest, LanguageModelChat } from 'vscode';
import { IAuthenticationService, IEndpointProvider, ITelemetrySender } from '@vscode/chat-lib';
import { ICopilotTokenManager } from '@vscode/chat-lib/dist/src/_internal/platform/authentication/common/copilotTokenManager';
import {
    CopilotToken,
    createTestExtendedTokenInfo
} from '@vscode/chat-lib/dist/src/_internal/platform/authentication/common/copilotToken';
import { Emitter, Event } from '@vscode/chat-lib/dist/src/_internal/util/vs/base/common/event';
import { Disposable } from '@vscode/chat-lib/dist/src/_internal/util/vs/base/common/lifecycle';
import {
    ChatEndpointFamily,
    EmbeddingsEndpointFamily,
    ICompletionModelInformation
} from '@vscode/chat-lib/dist/src/_internal/platform/endpoint/common/endpointProvider';
import {
    IChatEndpoint,
    IEmbeddingsEndpoint
} from '@vscode/chat-lib/dist/src/_internal/platform/networking/common/networking';

/**
 * Simple authentication service implementation with no actual verification logic
 *
 * This is an empty implementation used only to satisfy NES interface requirements.
 * Not used in actual projects, only passed to chat-lib to meet official interface requirements.
 * All methods return default or empty values and perform no actual authentication operations.
 */
export class AuthenticationService extends Disposable implements IAuthenticationService, ICopilotTokenManager {
    readonly _serviceBrand: undefined;
    readonly isMinimalMode = true; // Flag for non-official mode, do not request GHToken
    readonly anyGitHubSession = undefined;
    readonly permissiveGitHubSession = undefined;
    readonly copilotToken = new CopilotToken(
        createTestExtendedTokenInfo({
            token: `ccmp-token-${Math.ceil(Math.random() * 100)}`,
            username: 'ccmpuser',
            copilot_plan: 'individual'
        })
    );
    speculativeDecodingEndpointToken: string | undefined;

    private readonly _onDidCopilotTokenRefresh = this._register(new Emitter<void>());
    readonly onDidCopilotTokenRefresh: Event<void> = this._onDidCopilotTokenRefresh.event;

    private readonly _onDidAuthenticationChange = this._register(new Emitter<void>());
    readonly onDidAuthenticationChange: Event<void> = this._onDidAuthenticationChange.event;

    private readonly _onDidAccessTokenChange = this._register(new Emitter<void>());
    readonly onDidAccessTokenChange: Event<void> = this._onDidAccessTokenChange.event;

    private readonly _onDidAdoAuthenticationChange = this._register(new Emitter<void>());
    readonly onDidAdoAuthenticationChange: Event<void> = this._onDidAdoAuthenticationChange.event;

    async getAnyGitHubSession(_options?: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
        return undefined;
    }

    async getPermissiveGitHubSession(
        _options: AuthenticationGetSessionOptions
    ): Promise<AuthenticationSession | undefined> {
        return undefined;
    }

    async getGitHubSession(
        _kind: 'permissive' | 'any',
        _options?: AuthenticationGetSessionOptions
    ): Promise<AuthenticationSession> {
        throw new Error('Method not implemented.');
    }

    async getCopilotToken(_force?: boolean): Promise<CopilotToken> {
        return this.copilotToken;
    }

    resetCopilotToken(_httpError?: number): void {
        this._onDidCopilotTokenRefresh.fire();
    }

    async getAdoAccessTokenBase64(_options?: AuthenticationGetSessionOptions): Promise<string | undefined> {
        return undefined;
    }
}

/**
 * Telemetry Sender Implementation
 *
 * This is an empty implementation used only to satisfy NES interface requirements.
 * All telemetry events are ignored and no data is sent to external services.
 * This ensures user privacy and data security while meeting VS Code extension interface requirements.
 */
export class TelemetrySender implements ITelemetrySender {
    sendTelemetryEvent(
        _eventName: string,
        _properties?: Record<string, string | undefined>,
        _measurements?: Record<string, number | undefined>
    ): void {
        return;
    }
}

/**
 * Endpoint Provider Implementation
 */
export class EndpointProvider extends Disposable implements IEndpointProvider {
    readonly _serviceBrand: undefined;

    private readonly _onDidModelsRefresh = this._register(new Emitter<void>());
    readonly onDidModelsRefresh: Event<void> = this._onDidModelsRefresh.event;

    async getAllCompletionModels(_forceRefresh?: boolean): Promise<ICompletionModelInformation[]> {
        return [];
    }

    async getAllChatEndpoints(): Promise<IChatEndpoint[]> {
        return [];
    }

    async getChatEndpoint(
        _requestOrFamily: LanguageModelChat | ChatRequest | ChatEndpointFamily
    ): Promise<IChatEndpoint> {
        throw new Error('Method not implemented.');
    }

    async getEmbeddingsEndpoint(_family?: EmbeddingsEndpointFamily): Promise<IEmbeddingsEndpoint> {
        throw new Error('Method not implemented.');
    }
}

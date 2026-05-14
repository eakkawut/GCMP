/*---------------------------------------------------------------------------------------------
 *  OpenAI Codex CLI Authentication Implementation
 *  Based on OpenAI Codex OAuth 2.0 flow (ChatGPT Plus/Pro account)
 *  Login/authorization is completed by the user in the Codex CLI terminal; here only credential reading and refresh_token refresh are implemented
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { BaseCliAuth } from './baseCliAuth';
import { Logger } from '../../utils/logger';
import type { CliAuthConfig, OAuthCredentials } from '../type';

/**
 * Codex OAuth Credentials Extension Interface
 * Contains ChatGPT account ID (used in API request header ChatGPT-Account-Id)
 */
interface CodexOAuthCredentials extends OAuthCredentials {
    /** ChatGPT account ID */
    account_id?: string;
}

/** OpenAI Codex OAuth Client ID */
const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** OpenAI OAuth Token Endpoint */
const OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';

/**
 * OpenAI Codex CLI Authentication Class
 */
export class CodexCliAuth extends BaseCliAuth {
    constructor() {
        const config: CliAuthConfig = {
            name: 'Codex',
            clientId: OPENAI_CODEX_CLIENT_ID,
            tokenUrl: OPENAI_CODEX_TOKEN_URL,
            credentialPathPattern: '~/.codex/auth.json',
            cliCommand: 'codex'
        };
        super(config);
    }

    /**
     * Save credentials to file (maintaining Codex CLI official nested format)
     */
    protected saveCredentials(credentials: {
        access_token?: string;
        refresh_token?: string;
        id_token?: string;
        account_id?: string;
    }): void {
        const credentialPath = this.resolvePath(this.config.credentialPathPattern);

        // Read existing credential file
        let existingData: {
            OPENAI_API_KEY?: string;
            tokens?: {
                id_token?: string;
                account_id?: string;
            };
            last_refresh?: string;
        } = {};

        if (fs.existsSync(credentialPath)) {
            try {
                const content = fs.readFileSync(credentialPath, 'utf-8');
                existingData = JSON.parse(content);
            } catch {
                // ignore
            }
        }

        // Build tokens object
        const tokensUpdate: Record<string, unknown> = {};
        if (credentials.access_token) {
            tokensUpdate.access_token = credentials.access_token;
        }
        if (credentials.refresh_token) {
            tokensUpdate.refresh_token = credentials.refresh_token;
        }
        if (credentials.id_token) {
            tokensUpdate.id_token = credentials.id_token;
        }
        if (credentials.account_id) {
            tokensUpdate.account_id = credentials.account_id;
        }

        // Merge tokens (preserve existing other fields)
        const mergedTokens = {
            ...existingData.tokens,
            ...tokensUpdate
        };

        // Build final data
        const mergedData = {
            ...existingData,
            tokens: mergedTokens,
            last_refresh: new Date().toISOString()
        };

        // Ensure directory exists
        const dir = path.dirname(credentialPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(credentialPath, JSON.stringify(mergedData, null, 2));
    }

    /**
     * Codex access_token validity is approximately 10 days.
     * Refresh 1 hour in advance to avoid boundary issues.
     */
    async ensureAuthenticated(): Promise<OAuthCredentials | null> {
        let credentials = await this.loadCredentials();
        if (!credentials) {
            return null;
        }

        // Codex: Refresh 1 hour in advance to avoid boundary issues
        const expiryBufferMs = 60 * 60 * 1000;
        const isExpired =
            typeof credentials.expiry_date === 'number' ? credentials.expiry_date < Date.now() + expiryBufferMs : false;

        if (isExpired && credentials.refresh_token) {
            try {
                credentials = await this.refreshAccessToken(credentials);
                Logger.info(`[${this.config.name}] Token refreshed`);
            } catch (error) {
                Logger.error(`[${this.config.name}] Token refresh failed:`, error);
                return null;
            }
        }

        return credentials;
    }

    /**
     * Refresh Codex CLI Access Token (OAuth 2.0 refresh_token)
     */
    protected async refreshAccessToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        if (!credentials.refresh_token) {
            throw new Error('Codex CLI OAuth credentials missing refresh_token, unable to refresh token');
        }

        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: credentials.refresh_token,
            client_id: this.config.clientId
        });

        const tokenRes = await fetch(this.config.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });

        // Read text first for both success and failure to print more user-friendly error messages
        const rawText = await tokenRes.text();

        /** OAuth Token Response */
        interface TokenResponse {
            access_token?: string;
            expires_in?: number;
            refresh_token?: string;
            token_type?: string;
            id_token?: string;
            error?: {
                type: string;
                code: string;
                param?: string;
                message: string;
            };
        }

        let responseData: TokenResponse = {};
        try {
            responseData = JSON.parse(rawText) as TokenResponse;
        } catch {
            // ignore
        }

        if (!tokenRes.ok) {
            const errorMsg = responseData.error?.message || rawText || 'unknown error';
            throw new Error(`Codex CLI token refresh failed (${tokenRes.status}): ${errorMsg}`);
        }

        const accessToken = responseData.access_token || '';
        const expiresIn = responseData.expires_in ?? 0;
        const refreshToken = responseData.refresh_token || credentials.refresh_token;

        if (!accessToken) {
            throw new Error('Codex CLI OAuth refresh response missing access_token');
        }

        // Under normal circumstances, OpenAI always returns expires_in; when missing, retain original expiry_date (to avoid immediate refresh loop)
        const expiryDate =
            expiresIn > 0 ? Date.now() + expiresIn * 1000 : credentials.expiry_date || Date.now() + 23 * 60 * 60 * 1000;

        const newCredentials: OAuthCredentials = {
            access_token: accessToken,
            refresh_token: refreshToken,
            expiry_date: expiryDate
        };

        // Extract account_id from id_token (if exists)
        const accountId = this.extractAccountIdFromIdToken(responseData.id_token);

        // Save refreshed credentials
        this.saveCredentials({
            access_token: accessToken,
            refresh_token: refreshToken,
            id_token: responseData.id_token,
            account_id: accountId
        });

        Logger.info('[Codex] Token refresh successful');
        return newCredentials;
    }

    /**
     * Get ChatGPT Account ID
     * Used in API request header ChatGPT-Account-Id
     */
    async getAccountId(): Promise<string | null> {
        const credentials = (await this.loadCredentials()) as CodexOAuthCredentials | null;
        return credentials?.account_id ?? null;
    }

    /**
     * Additional processing after loading credentials
     * Codex CLI's auth.json stores token information in the tokens object
     */
    protected async afterLoadCredentials(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        // Check if it's Codex CLI's nested format
        const rawData = credentials as unknown as {
            tokens?: {
                access_token?: string;
                refresh_token?: string;
                id_token?: string;
                account_id?: string;
            };
            last_refresh?: string;
        };

        // If tokens object exists, extract fields from it
        if (rawData.tokens) {
            const tokens = rawData.tokens;
            const result: CodexOAuthCredentials = {
                access_token: tokens.access_token || '',
                refresh_token: tokens.refresh_token || '',
                expiry_date: 0,
                account_id: tokens.account_id
            };

            // Try to parse expiry date from access_token (JWT)
            if (tokens.access_token) {
                const expFromToken = this.extractExpFromIdToken(tokens.access_token);
                if (expFromToken) {
                    result.expiry_date = expFromToken;
                }
            }

            // If expiry date not parsed from JWT, try to infer from last_refresh
            if (!result.expiry_date && rawData.last_refresh) {
                const lastRefresh = new Date(rawData.last_refresh).getTime();
                if (!isNaN(lastRefresh)) {
                    // Codex access_token valid for approximately 10 days, infer from last_refresh (1 hour buffer)
                    result.expiry_date = lastRefresh + 23 * 60 * 60 * 1000;
                }
            }

            Logger.debug(`[${this.config.name}] Loaded credentials from tokens object, account_id: ${result.account_id}`);
            return result;
        }

        return credentials;
    }

    /**
     * Extract expiry date from id_token (JWT)
     */
    private extractExpFromIdToken(idToken: string): number | undefined {
        try {
            const parts = idToken.split('.');
            if (parts.length !== 3) {
                return undefined;
            }
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: number };
            if (typeof payload.exp === 'number') {
                return payload.exp * 1000; // Convert to milliseconds
            }
        } catch {
            // ignore
        }
        return undefined;
    }

    /**
     * Extract ChatGPT account_id from id_token (JWT)
     */
    private extractAccountIdFromIdToken(idToken: unknown): string | undefined {
        if (typeof idToken !== 'string' || !idToken) {
            return undefined;
        }
        try {
            const parts = idToken.split('.');
            if (parts.length !== 3) {
                return undefined;
            }
            // Decode JWT payload (second part)
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
                chatgpt_account_id?: string;
                'https://api.openai.com/auth'?: {
                    chatgpt_account_id?: string;
                    chatgpt_plan_type?: string;
                };
                organizations?: Array<{ id: string }>;
            };
            // Prioritize chatgpt_account_id under https://api.openai.com/auth namespace
            const authData = payload['https://api.openai.com/auth'];
            if (typeof authData?.chatgpt_account_id === 'string' && authData.chatgpt_account_id) {
                return authData.chatgpt_account_id;
            }
            // Compatible with chatgpt_account_id directly at top level
            if (typeof payload.chatgpt_account_id === 'string' && payload.chatgpt_account_id) {
                return payload.chatgpt_account_id;
            }
            if (Array.isArray(payload.organizations) && payload.organizations.length > 0) {
                const firstOrg = payload.organizations[0];
                if (typeof firstOrg?.id === 'string' && firstOrg.id) {
                    return firstOrg.id;
                }
            }
        } catch {
            Logger.debug('[Codex] Failed to parse id_token');
        }
        return undefined;
    }
}

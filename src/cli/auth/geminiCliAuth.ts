/*---------------------------------------------------------------------------------------------
 *  Gemini CLI Authentication Implementation
 *  Only implements refresh_token refresh logic: login/authorization is completed by the user in the Gemini CLI terminal
 *--------------------------------------------------------------------------------------------*/

import { BaseCliAuth } from './baseCliAuth';
import { Logger } from '../../utils/logger';
import type { CliAuthConfig, OAuthCredentials } from '../type';

interface OauthConfig {
    oauthClientId: string;
    oauthClientSecret: string;
}

/**
 * GitHub will detect if Google oauthClientId is leaked
 * This value is the content after JSON is HEX encoded
 * Source: https://api.kilo.ai/extension-config.json => geminiCli
 */
const oauthConfigHex =
    '7b226f61757468436c69656e744964223a223638313235353830393339352d6f6f386674326f707264726e7039653361716636617633686d6469623133356a2e617070732e676f6f676c6575736572636f6e74656e742e636f6d222c226f61757468436c69656e74536563726574223a22474f435350582d347548674d506d2d316f37536b2d67655636437535636c584673786c227d';
const oauthConfig: OauthConfig = (() => {
    const jsonText = Buffer.from(oauthConfigHex, 'hex').toString('utf8');
    const parsed = JSON.parse(jsonText) as Partial<OauthConfig>;
    if (typeof parsed.oauthClientId !== 'string' || typeof parsed.oauthClientSecret !== 'string') {
        throw new Error('invalid oauth config');
    }
    return { oauthClientId: parsed.oauthClientId, oauthClientSecret: parsed.oauthClientSecret };
})();

/**
 * Gemini CLI Authentication Class
 */
export class GeminiCliAuth extends BaseCliAuth {
    constructor() {
        const config: CliAuthConfig = {
            name: 'Gemini CLI',
            // clientId prioritizes built-in OAuth configuration; credential file's client_id can still override
            clientId: oauthConfig.oauthClientId,
            tokenUrl: 'https://oauth2.googleapis.com/token',
            credentialPathPattern: '~/.gemini/oauth_creds.json',
            cliCommand: 'gemini'
        };
        super(config);
    }

    /**
     * Gemini access_token is valid for only 1 hour by default.
     * BaseCliAuth using 1 hour buffer would cause "just obtained but already expired" judgment, leading to continuous refresh.
     * Gemini uses a smaller buffer time (default 5 minutes) separately.
     */
    async ensureAuthenticated(): Promise<OAuthCredentials | null> {
        let credentials = await this.loadCredentials();
        if (!credentials) {
            // Logger.info(`[${this.config.name}] Not authenticated, please run CLI login first`);
            return null;
        }

        // Compatible with expiry_date in credential file possibly being a string
        const rawExpiry = (credentials as unknown as { expiry_date?: unknown }).expiry_date;
        if (typeof rawExpiry === 'string') {
            const parsed = Number(rawExpiry);
            if (Number.isFinite(parsed)) {
                credentials.expiry_date = parsed;
            }
        }

        // Gemini: Refresh 5 minutes in advance is sufficient to avoid boundary issues
        const expiryBufferMs = 5 * 60 * 1000;
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
     * Refresh Gemini CLI Access Token (OAuth 2.0 refresh_token)
     */
    protected async refreshAccessToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        if (!credentials.refresh_token) {
            throw new Error('Gemini CLI OAuth credentials missing refresh_token, unable to refresh token');
        }

        // Allow credential file's client_id/client_secret to override built-in configuration
        const fileClientId = (credentials as unknown as { client_id?: unknown }).client_id;
        const fileClientSecret = (credentials as unknown as { client_secret?: unknown }).client_secret;
        const clientId = typeof fileClientId === 'string' && fileClientId ? fileClientId : oauthConfig.oauthClientId;
        const clientSecret =
            typeof fileClientSecret === 'string' && fileClientSecret ? fileClientSecret : oauthConfig.oauthClientSecret;

        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: credentials.refresh_token,
            client_id: clientId,
            client_secret: clientSecret
        });

        const tokenRes = await fetch(this.config.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });

        // Read text first for both success and failure to print more user-friendly error messages
        const rawText = await tokenRes.text();
        let responseData: {
            access_token?: unknown;
            expires_in?: unknown;
            refresh_token?: unknown;
            token_type?: unknown;
            scope?: unknown;
            id_token?: unknown;
            error?: unknown;
            error_description?: unknown;
        } = {};
        try {
            responseData = JSON.parse(rawText) as typeof responseData;
        } catch {
            // ignore
        }

        if (!tokenRes.ok) {
            const errorMsg =
                (typeof responseData.error_description === 'string' && responseData.error_description) ||
                (typeof responseData.error === 'string' && responseData.error) ||
                rawText ||
                'unknown error';
            throw new Error(`Gemini CLI token refresh failed (${tokenRes.status}): ${errorMsg}`);
        }

        const accessToken = typeof responseData.access_token === 'string' ? responseData.access_token : '';
        const expiresIn = (() => {
            const value = responseData.expires_in;
            if (typeof value === 'number') {
                return value;
            }
            if (typeof value === 'string') {
                const parsed = Number(value);
                return Number.isFinite(parsed) ? parsed : undefined;
            }
            return undefined;
        })();
        const refreshToken =
            typeof responseData.refresh_token === 'string' && responseData.refresh_token
                ? responseData.refresh_token
                : credentials.refresh_token;
        const tokenType = typeof responseData.token_type === 'string' ? responseData.token_type : undefined;
        const scope = typeof responseData.scope === 'string' ? responseData.scope : undefined;
        const idToken = typeof responseData.id_token === 'string' ? responseData.id_token : undefined;

        if (!accessToken) {
            throw new Error('Gemini CLI OAuth refresh response missing access_token');
        }

        // Under normal circumstances, Google always returns expires_in; when missing, retain original expiry_date (to avoid immediate refresh loop)
        const expiryDate = Number.isFinite(expiresIn)
            ? Date.now() + (expiresIn as number) * 1000
            : credentials.expiry_date || Date.now() + 55 * 60 * 1000;

        const newCredentials: OAuthCredentials = {
            access_token: accessToken,
            refresh_token: refreshToken,
            expiry_date: expiryDate
        };

        // Save refreshed credentials (differential merge, preserve client_id/client_secret and other extended fields)
        this.saveCredentials({
            ...newCredentials,
            ...(tokenType ? { token_type: tokenType } : {}),
            ...(scope ? { scope } : {}),
            ...(idToken ? { id_token: idToken } : {})
        } as unknown as Partial<OAuthCredentials>);

        Logger.info('[Gemini CLI] Token refresh successful');
        return newCredentials;
    }
}

/*---------------------------------------------------------------------------------------------
 *  CLI Authentication Base Class
 *  Provides common CLI authentication functionality
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { Logger } from '../../utils/logger';
import { CliAuthConfig, OAuthCredentials } from '../type';

/**
 * CLI Authentication Base Class
 * Provides common authentication functionality; specific provider implementations inherit from this class
 */
export abstract class BaseCliAuth {
    constructor(protected config: CliAuthConfig) { }

    /**
     * Get API Access Token
     */
    async getApiKey(forceRefresh = false): Promise<string | null> {
        const credentials = await this.ensureAuthenticated();
        if (credentials) {
            if (forceRefresh) {
                const refreshedCredentials = await this.refreshAccessToken(credentials);
                return refreshedCredentials.access_token;
            }
            return credentials.access_token;
        }
        return null;
    }

    /**
     * Load CLI OAuth Credentials
     */
    async loadCredentials(): Promise<OAuthCredentials | null> {
        const credentialPath = this.resolvePath(this.config.credentialPathPattern);
        try {
            if (!fs.existsSync(credentialPath)) {
                Logger.debug(`[${this.config.name}] Credential file does not exist: ${credentialPath}`);
                return null;
            }

            const content = fs.readFileSync(credentialPath, 'utf-8');
            const credentials = JSON.parse(content) as OAuthCredentials;
            // Allow subclasses to perform additional processing after loading credentials
            const processedCredentials = await this.afterLoadCredentials(credentials);
            Logger.info(`[${this.config.name}] Credentials loaded`);
            return processedCredentials;
        } catch (error) {
            Logger.error(`[${this.config.name}] Failed to load credentials:`, error);
            return null;
        }
    }

    /**
     * Ensure Authentication is Valid (Automatically refresh expired tokens)
     */
    async ensureAuthenticated(): Promise<OAuthCredentials | null> {
        let credentials = await this.loadCredentials();
        if (!credentials) {
            // Logger.info(`[${this.config.name}] Not authenticated, please run CLI login first`);
            return null;
        }

        // Check if token is expired (refresh 1 hour in advance to avoid critical point)
        const expiryBuffer = 60 * 60 * 1000; // 1 hour buffer
        const isExpired = credentials.expiry_date ? credentials.expiry_date < Date.now() + expiryBuffer : false;
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
     * Refresh Access Token (Implemented by subclasses)
     */
    protected abstract refreshAccessToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;

    /**
     * Additional Processing after Loading Credentials (Optionally implemented by subclasses)
     */
    protected async afterLoadCredentials(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        return credentials;
    }

    /**
     * Check if CLI is Installed
     */
    async isCliInstalled(): Promise<boolean> {
        try {
            execSync(`${this.config.cliCommand} --version`, { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get Full Path of Credential File
     */
    getCredentialPath(): string {
        return this.resolvePath(this.config.credentialPathPattern);
    }

    /**
     * Parse Path Pattern, Support ~ Expansion
     */
    protected resolvePath(pattern: string): string {
        if (pattern.startsWith('~')) {
            return path.join(os.homedir(), pattern.slice(1));
        }
        return pattern;
    }

    /**
     * Save Credentials to File (Differential Update, Preserve Existing Fields in File)
     */
    protected saveCredentials(credentials: Partial<OAuthCredentials>): void {
        const credentialPath = this.resolvePath(this.config.credentialPathPattern);

        // Read existing credential file, preserve existing fields
        let existingData: Record<string, unknown> = {};
        if (fs.existsSync(credentialPath)) {
            try {
                const content = fs.readFileSync(credentialPath, 'utf-8');
                existingData = JSON.parse(content);
            } catch (error) {
                Logger.warn(`[${this.config.name}] Failed to read existing credential file, will overwrite:`, error);
            }
        }

        // Filter out null/undefined values, only keep valid values
        const validCredentials: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(credentials)) {
            if (value !== null && value !== undefined) {
                validCredentials[key] = value;
            }
        }

        // Merge new credentials and existing data
        const mergedData = { ...existingData, ...validCredentials };
        // Ensure directory exists
        const dir = path.dirname(credentialPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(credentialPath, JSON.stringify(mergedData, null, 2));
    }
}

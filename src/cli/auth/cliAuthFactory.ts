/*---------------------------------------------------------------------------------------------
 *  CLI Authentication Factory
 *  Manages authentication instances for different CLI providers
 *--------------------------------------------------------------------------------------------*/

import { BaseCliAuth } from './baseCliAuth';
import { GeminiCliAuth } from './geminiCliAuth';
import { CodexCliAuth } from './codexCliAuth';
import { Logger } from '../../utils/logger';
import { OAuthCredentials } from '../type';

/**
 * CLI Authentication Factory
 * Singleton pattern, manages authentication instances for all CLI providers
 */
export class CliAuthFactory {
    private static instances = new Map<string, BaseCliAuth>();

    /**
     * Get Authentication Instance for Specified CLI Type
     */
    static getInstance(cliType: string): BaseCliAuth | null {
        // If instance already exists, return directly
        if (this.instances.has(cliType)) {
            return this.instances.get(cliType)!;
        }
        // Create new instance
        let instance: BaseCliAuth | null = null;
        switch (cliType) {
            case 'gemini':
                instance = new GeminiCliAuth();
                break;
            case 'codex':
                instance = new CodexCliAuth();
                break;
            default:
                Logger.warn(`[CliAuthFactory] Unknown CLI type: ${cliType}`);
                return null;
        }
        if (instance) {
            this.instances.set(cliType, instance);
        }
        return instance;
    }

    /**
     * Load CLI OAuth Credentials
     */
    static async loadCredentials(cliType: string): Promise<OAuthCredentials | null> {
        const instance = this.getInstance(cliType);
        if (!instance) {
            return null;
        }
        return await instance.loadCredentials();
    }

    /**
     * Ensure Authentication is Valid (Automatically refresh expired tokens)
     */
    static async ensureAuthenticated(cliType: string): Promise<OAuthCredentials | null> {
        const instance = this.getInstance(cliType);
        if (!instance) {
            return null;
        }
        return await instance.ensureAuthenticated();
    }

    /**
     * Check if CLI is Installed
     */
    static async isCliInstalled(cliType: string): Promise<boolean> {
        const instance = this.getInstance(cliType);
        if (!instance) {
            return false;
        }
        return await instance.isCliInstalled();
    }

    /**
     * Get Credential File Path
     */
    static getCredentialPath(cliType: string): string | null {
        const instance = this.getInstance(cliType);
        return instance ? instance.getCredentialPath() : null;
    }

    /**
     * Get List of Supported CLI Types
     */
    static getSupportedCliTypes(): Array<{ id: string; name: string }> {
        return [
            { id: 'codex', name: 'Codex CLI' },
            { id: 'gemini', name: 'Gemini CLI' }
        ];
    }
}

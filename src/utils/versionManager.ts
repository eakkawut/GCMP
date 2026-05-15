/*---------------------------------------------------------------------------------------------
 *  Version Management Utility
 *  Provides unified version number retrieval methods
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Version Manager
 */
export class VersionManager {
    private static _version: string | null = null;

    /**
     * Get extension version number
     */
    static getVersion(): string {
        if (this._version === null) {
            const extension = vscode.extensions.getExtension('guokoko.ccmp');
            this._version = extension?.packageJSON?.version || '0.4.0';
        }
        return this._version!;
    }

    /**
     * Get user agent string
     */
    static getUserAgent(component: string): string {
        return `CCMP-${component}/${this.getVersion()}`;
    }

    /**
     * Get client information
     */
    static getClientInfo(): { name: string; version: string } {
        return {
            name: 'CCMP',
            version: this.getVersion()
        };
    }

    /**
     * Reset cache (mainly for testing)
     */
    static resetCache(): void {
        this._version = null;
    }
}

/*---------------------------------------------------------------------------------------------
 *  CLI Authentication Type Definitions
 *  Defines interfaces and types for CLI authentication
 *--------------------------------------------------------------------------------------------*/

/**
 * OAuth credentials interface
 */
export interface OAuthCredentials {
    access_token: string;
    refresh_token: string;
    expiry_date: number;
}

/**
 * CLI authentication configuration
 */
export interface CliAuthConfig {
    /** Provider name */
    name: string;
    /** OAuth client ID */
    clientId: string;
    /** OAuth client secret (used for refresh_token refresh) */
    clientSecret?: string;
    /** OAuth token endpoint */
    tokenUrl: string;
    /** Credential file path pattern */
    credentialPathPattern: string;
    /** CLI command name */
    cliCommand: string;
}

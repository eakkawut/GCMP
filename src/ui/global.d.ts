/**
 * VSCode WebView API global interface
 */

interface VsCodeApi {
    postMessage(message: { command: string;[key: string]: unknown }): void;
}

/**
 * Extend Window interface, add VSCode WebView API
 */
declare global {
    interface Window {
        vscode: VsCodeApi;
    }
}

export { };

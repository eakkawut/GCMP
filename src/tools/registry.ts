/*---------------------------------------------------------------------------------------------
 *  Tool Registry
 *  Manages registration and lifecycle of all tools
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';
import { ZhipuSearchTool } from './zhipuSearch';
import { MiniMaxSearchTool } from './minimaxSearch';
import { KimiSearchTool } from './kimiSearch';
import { DashscopeSearchTool } from './dashscopeSearch';

// Global tool instance management
let zhipuSearchTool: ZhipuSearchTool | undefined;
let minimaxSearchTool: MiniMaxSearchTool | undefined;
let kimiSearchTool: KimiSearchTool | undefined;
let dashscopeSearchTool: DashscopeSearchTool | undefined;

/**
 * Register all tools
 */
export function registerAllTools(context: vscode.ExtensionContext): void {
    try {
        // Register ZhipuAI web search tool
        zhipuSearchTool = new ZhipuSearchTool();
        const zhipuToolDisposable = vscode.lm.registerTool('ccmp_zhipuWebSearch', {
            invoke: zhipuSearchTool.invoke.bind(zhipuSearchTool)
        });
        context.subscriptions.push(zhipuToolDisposable);

        // Register MiniMax web search tool
        minimaxSearchTool = new MiniMaxSearchTool();
        const minimaxToolDisposable = vscode.lm.registerTool('ccmp_minimaxWebSearch', {
            invoke: minimaxSearchTool.invoke.bind(minimaxSearchTool)
        });
        context.subscriptions.push(minimaxToolDisposable);

        // Register Kimi web search tool
        kimiSearchTool = new KimiSearchTool();
        const kimiToolDisposable = vscode.lm.registerTool('ccmp_kimiWebSearch', {
            invoke: kimiSearchTool.invoke.bind(kimiSearchTool)
        });
        context.subscriptions.push(kimiToolDisposable);

        // Register Alibaba Cloud DashScope web search tool
        dashscopeSearchTool = new DashscopeSearchTool();
        const dashscopeToolDisposable = vscode.lm.registerTool('ccmp_dashscopeWebSearch', {
            invoke: dashscopeSearchTool.invoke.bind(dashscopeSearchTool)
        });
        context.subscriptions.push(dashscopeToolDisposable);

        // Add cleanup logic to context
        context.subscriptions.push({
            dispose: async () => {
                await cleanupAllTools();
            }
        });

        Logger.debug('ZhipuAI web search tool registered: ccmp_zhipuWebSearch');
        Logger.debug('MiniMax web search tool registered: ccmp_minimaxWebSearch');
        Logger.debug('Kimi web search tool registered: ccmp_kimiWebSearch');
        Logger.debug('Alibaba Cloud DashScope web search tool registered: ccmp_dashscopeWebSearch');
    } catch (error) {
        Logger.error('Tool registration failed', error instanceof Error ? error : undefined);
        throw error;
    }
}

/**
 * Clean up all tool resources
 */
export async function cleanupAllTools(): Promise<void> {
    try {
        if (zhipuSearchTool) {
            await zhipuSearchTool.cleanup();
            zhipuSearchTool = undefined;
            Logger.info('✅ ZhipuAI web search tool resources cleaned up');
        }

        if (minimaxSearchTool) {
            await minimaxSearchTool.cleanup();
            minimaxSearchTool = undefined;
            Logger.info('✅ MiniMax web search tool resources cleaned up');
        }

        if (kimiSearchTool) {
            await kimiSearchTool.cleanup();
            kimiSearchTool = undefined;
            Logger.info('✅ Kimi web search tool resources cleaned up');
        }

        if (dashscopeSearchTool) {
            await dashscopeSearchTool.cleanup();
            dashscopeSearchTool = undefined;
            Logger.info('✅ Alibaba Cloud DashScope web search tool resources cleaned up');
        }
    } catch (error) {
        Logger.error('❌ Tool cleanup failed', error instanceof Error ? error : undefined);
    }
}

// Compounding Engineering Extension for VS Code
// Provides specialized AI agents and workflow prompts as global chat participants

import * as vscode from 'vscode';
import * as path from 'path';
import { loadAllAgents, loadAllPrompts } from './src/agentParser';
import { createChatHandler, createFollowupProvider } from './src/chatHandlers';
import { AgentConfig } from './src/types';

// Global storage for all loaded agents and participants
let allAgents = new Map<string, AgentConfig>();
let allPrompts = new Map<string, AgentConfig>();
const registeredParticipants: string[] = [];
let outputChannel: vscode.OutputChannel | undefined;

/**
 * Extension activation
 * @param context - Extension context
 */
export function activate(context: vscode.ExtensionContext): void {
    // Create output channel for structured logging
    outputChannel = vscode.window.createOutputChannel('Compounding Engineering');
    context.subscriptions.push(outputChannel);

    outputChannel.appendLine('Compounding Engineering extension is activating...');

    try {
        // Determine paths to agent and prompt directories
        const extensionPath = context.extensionPath;
        const agentsDir = path.join(extensionPath, '.github', 'agents');
        const promptsDir = path.join(extensionPath, '.github', 'prompts');

        // Load all agents and prompts
        outputChannel.appendLine(`Loading agents from: ${agentsDir}`);
        allAgents = loadAllAgents(agentsDir, outputChannel);
        outputChannel.appendLine(`Loaded ${allAgents.size} agents`);

        outputChannel.appendLine(`Loading prompts from: ${promptsDir}`);
        allPrompts = loadAllPrompts(promptsDir, outputChannel);
        outputChannel.appendLine(`Loaded ${allPrompts.size} prompts`);

        // Register all agents as chat participants
        registerAgents(context, allAgents);

        // Register all prompts as chat participants
        registerPrompts(context, allPrompts, allAgents);

        // Show welcome message
        const totalParticipants = allAgents.size + allPrompts.size;
        vscode.window.showInformationMessage(
            `✨ Compounding Engineering activated! ${totalParticipants} agents and prompts are now available in chat. Use @ to mention agents and / for commands.`
        );

        outputChannel.appendLine('Compounding Engineering extension activated successfully!');
        outputChannel.appendLine(`Registered ${registeredParticipants.length} chat participants`);

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : '';
        outputChannel.appendLine(`ERROR: Failed to activate extension: ${errorMessage}`);
        if (errorStack) {
            outputChannel.appendLine(errorStack);
        }
        vscode.window.showErrorMessage(
            `Failed to activate Compounding Engineering: ${errorMessage}`
        );
    }
}

/**
 * Register chat participants from a collection of configs
 * @param context - Extension context
 * @param participants - Map of participant configs
 * @param iconName - VS Code ThemeIcon name
 * @param typeName - Type name for logging (e.g., "agent" or "prompt")
 * @param allAgents - All agents for handoff support
 */
function registerChatParticipants(
    context: vscode.ExtensionContext,
    participants: Map<string, AgentConfig>,
    iconName: string,
    typeName: string,
    allAgents: Map<string, AgentConfig>
): void {
    if (!outputChannel) {
        return;
    }

    for (const [id, config] of participants.entries()) {
        try {
            const participantId = `compounding-engineering.${id}`;

            // Create chat participant
            const participant = vscode.chat.createChatParticipant(
                participantId,
                createChatHandler(config, participantId, allAgents, undefined, 0, outputChannel)
            );

            // Set icon
            participant.iconPath = new vscode.ThemeIcon(iconName);

            // Set follow-up provider
            participant.followupProvider = createFollowupProvider(config);

            // Register for disposal
            context.subscriptions.push(participant);
            registeredParticipants.push(participantId);

            outputChannel.appendLine(`✓ Registered ${typeName}: @${id}`);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            outputChannel.appendLine(`ERROR: Failed to register ${typeName} ${id}: ${errorMessage}`);
        }
    }
}

/**
 * Register all agents as chat participants
 * @param context - Extension context
 * @param agents - Map of agent configs
 */
function registerAgents(context: vscode.ExtensionContext, agents: Map<string, AgentConfig>): void {
    registerChatParticipants(context, agents, 'robot', 'agent', agents);
}

/**
 * Register all prompts as chat participants
 * @param context - Extension context
 * @param prompts - Map of prompt configs
 * @param agents - For handoff support
 */
function registerPrompts(
    context: vscode.ExtensionContext,
    prompts: Map<string, AgentConfig>,
    agents: Map<string, AgentConfig>
): void {
    registerChatParticipants(context, prompts, 'layers', 'prompt', agents);
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
    if (outputChannel) {
        outputChannel.appendLine('Compounding Engineering extension is deactivating...');
        outputChannel.dispose();
    }
    registeredParticipants.length = 0;
    allAgents.clear();
    allPrompts.clear();
}

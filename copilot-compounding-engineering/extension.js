// Compounding Engineering Extension for VS Code
// Provides specialized AI agents and workflow prompts as global chat participants

const vscode = require('vscode');
const path = require('path');
const { loadAllAgents, loadAllPrompts } = require('./src/agentParser');
const { createChatHandler, createFollowupProvider } = require('./src/chatHandlers');

// Global storage for all loaded agents and participants
let allAgents = new Map();
let allPrompts = new Map();
let registeredParticipants = [];

/**
 * Extension activation
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('Compounding Engineering extension is activating...');

    try {
        // Determine paths to agent and prompt directories
        const extensionPath = context.extensionPath;
        const agentsDir = path.join(extensionPath, '.github', 'agents');
        const promptsDir = path.join(extensionPath, '.github', 'prompts');

        // Load all agents and prompts
        console.log(`Loading agents from: ${agentsDir}`);
        allAgents = loadAllAgents(agentsDir);
        console.log(`Loaded ${allAgents.size} agents`);

        console.log(`Loading prompts from: ${promptsDir}`);
        allPrompts = loadAllPrompts(promptsDir);
        console.log(`Loaded ${allPrompts.size} prompts`);

        // Register all agents as chat participants
        registerAgents(context, allAgents);

        // Register all prompts as chat participants
        registerPrompts(context, allPrompts, allAgents);

        // Show welcome message
        const totalParticipants = allAgents.size + allPrompts.size;
        vscode.window.showInformationMessage(
            `✨ Compounding Engineering activated! ${totalParticipants} agents and prompts are now available in chat. Use @ to mention agents and / for commands.`
        );

        console.log(`Compounding Engineering extension activated successfully!`);
        console.log(`Registered ${registeredParticipants.length} chat participants`);

    } catch (error) {
        console.error('Error activating Compounding Engineering extension:', error);
        vscode.window.showErrorMessage(
            `Failed to activate Compounding Engineering: ${error.message}`
        );
    }
}

/**
 * Register all agents as chat participants
 * @param {vscode.ExtensionContext} context
 * @param {Map<string, Object>} agents
 */
function registerAgents(context, agents) {
    for (const [agentId, config] of agents.entries()) {
        try {
            const participantId = `compounding-engineering.${agentId}`;

            // Create chat participant
            const participant = vscode.chat.createChatParticipant(
                participantId,
                createChatHandler(config, participantId, agents)
            );

            // Set icon (use a default icon for now)
            participant.iconPath = new vscode.ThemeIcon('robot');

            // Set follow-up provider
            participant.followupProvider = createFollowupProvider(config);

            // Register for disposal
            context.subscriptions.push(participant);
            registeredParticipants.push(participantId);

            console.log(`✓ Registered agent: @${agentId}`);

        } catch (error) {
            console.error(`Failed to register agent ${agentId}:`, error);
        }
    }
}

/**
 * Register all prompts as chat participants
 * @param {vscode.ExtensionContext} context
 * @param {Map<string, Object>} prompts
 * @param {Map<string, Object>} agents - For handoff support
 */
function registerPrompts(context, prompts, agents) {
    for (const [promptId, config] of prompts.entries()) {
        try {
            const participantId = `compounding-engineering.${promptId}`;

            // Create chat participant
            const participant = vscode.chat.createChatParticipant(
                participantId,
                createChatHandler(config, participantId, agents)
            );

            // Set icon (use a different icon for prompts/workflows)
            participant.iconPath = new vscode.ThemeIcon('layers');

            // Set follow-up provider
            participant.followupProvider = createFollowupProvider(config);

            // Register for disposal
            context.subscriptions.push(participant);
            registeredParticipants.push(participantId);

            console.log(`✓ Registered prompt: @${promptId}`);

        } catch (error) {
            console.error(`Failed to register prompt ${promptId}:`, error);
        }
    }
}

/**
 * Extension deactivation
 */
function deactivate() {
    console.log('Compounding Engineering extension is deactivating...');
    registeredParticipants = [];
    allAgents.clear();
    allPrompts.clear();
}

module.exports = {
    activate,
    deactivate
};

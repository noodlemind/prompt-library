const vscode = require('vscode');

/**
 * Create a chat handler for an agent or prompt
 * @param {Object} config - Agent/prompt configuration from parser
 * @param {string} participantId - Full participant ID (e.g., "compounding-engineering.architecture-strategist")
 * @param {Map} allAgents - Map of all loaded agents for handoff support
 * @returns {Function} Chat request handler function
 */
function createChatHandler(config, participantId, allAgents = new Map()) {
    return async (request, context, stream, token) => {
        try {
            // Show that the agent is processing
            stream.progress(`${config.name} is analyzing...`);

            // Build the system prompt from agent instructions
            const systemPrompt = buildSystemPrompt(config, context);

            // Get user's message
            const userMessage = request.prompt;

            // Handle commands if this is a prompt with commands
            const commandName = request.command;
            let finalPrompt = userMessage;

            if (commandName) {
                stream.markdown(`*Running ${config.name} with command: ${commandName}*\n\n`);
            }

            // Select language model - respect user's choice from chat dropdown
            // User can select Auto, GPT-4, Claude, etc. - we honor their selection
            const models = await vscode.lm.selectChatModels({
                vendor: 'copilot'
                // No family specified - uses whatever model user selected in chat UI
            });

            if (models.length === 0) {
                stream.markdown('⚠️ No language model available. Please ensure GitHub Copilot is active.');
                return;
            }

            const model = models[0];

            // Build messages array
            const messages = [
                vscode.LanguageModelChatMessage.User(systemPrompt),
                vscode.LanguageModelChatMessage.User(finalPrompt)
            ];

            // Add context from the editor if available
            if (context.activeEditorSelection) {
                const selection = context.activeEditorSelection;
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    const selectedText = editor.document.getText(selection);
                    if (selectedText) {
                        messages.push(
                            vscode.LanguageModelChatMessage.User(
                                `Here is the selected code:\n\`\`\`${editor.document.languageId}\n${selectedText}\n\`\`\``
                            )
                        );
                    }
                }
            }

            // Send request to language model with streaming
            const chatResponse = await model.sendRequest(messages, {}, token);

            // Stream the response
            for await (const fragment of chatResponse.text) {
                stream.markdown(fragment);
            }

            // Handle handoffs if configured (for prompts)
            if (config.handoffs && config.handoffs.length > 0) {
                stream.markdown('\n\n---\n\n');
                stream.markdown('**Additional Analysis from Specialized Agents:**\n\n');

                for (const handoff of config.handoffs) {
                    if (handoff.send === false) {
                        // This is an optional handoff - show as a button
                        stream.button({
                            command: 'workbench.action.chat.open',
                            arguments: [`@${handoff.agent} ${handoff.prompt}`],
                            title: handoff.label || `Consult ${handoff.agent}`
                        });
                    } else {
                        // Auto-execute handoff
                        stream.markdown(`\n\n### ${handoff.label || handoff.agent}\n\n`);
                        const agentConfig = allAgents.get(handoff.agent);

                        if (agentConfig) {
                            // Create a sub-request to the other agent
                            const subHandler = createChatHandler(agentConfig, handoff.agent, allAgents);
                            const subRequest = {
                                prompt: handoff.prompt || userMessage,
                                command: undefined
                            };

                            await subHandler(subRequest, context, stream, token);
                        } else {
                            stream.markdown(`*Agent @${handoff.agent} not found*\n`);
                        }
                    }
                }
            }

        } catch (error) {
            console.error(`Error in chat handler for ${participantId}:`, error);

            if (error.message.includes('rate limit')) {
                stream.markdown('⚠️ Rate limit reached. Please try again in a moment.');
            } else if (error.message.includes('model')) {
                stream.markdown('⚠️ Language model unavailable. Please check your GitHub Copilot subscription.');
            } else {
                stream.markdown(`⚠️ An error occurred: ${error.message}`);
            }
        }
    };
}

/**
 * Build system prompt from agent configuration and context
 * @param {Object} config - Agent/prompt configuration
 * @param {Object} context - VS Code chat context
 * @returns {string} System prompt for the language model
 */
function buildSystemPrompt(config, context) {
    let prompt = `You are ${config.name}, an AI assistant specialized in the following:\n\n`;
    prompt += `${config.description}\n\n`;
    prompt += `## Your Role and Instructions\n\n`;
    prompt += config.instructions;

    // Note: Tools like 'search', 'githubRepo', 'fetch' are automatically available in agent mode
    // VS Code provides built-in tools for workspace search, file operations, terminal commands, etc.
    // The language model can use these tools automatically without manual registration

    // Add workspace context
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        prompt += `\n\n## Workspace Context\n\n`;
        prompt += `Current workspace: ${vscode.workspace.workspaceFolders[0].uri.fsPath}\n`;
    }

    return prompt;
}

/**
 * Create a follow-up provider for a chat participant
 * @param {Object} config - Agent/prompt configuration
 * @returns {Function} Follow-up provider function
 */
function createFollowupProvider(config) {
    return (result, context, token) => {
        const followups = [];

        // Add default follow-ups
        followups.push({
            prompt: 'Can you explain this in more detail?',
            label: '📖 Explain in detail',
            command: undefined
        });

        followups.push({
            prompt: 'What are the potential risks or issues?',
            label: '⚠️ Identify risks',
            command: undefined
        });

        // Add handoff suggestions if configured
        if (config.handoffs && config.handoffs.length > 0) {
            for (const handoff of config.handoffs.slice(0, 3)) {
                followups.push({
                    prompt: `@${handoff.agent} ${handoff.prompt}`,
                    label: handoff.label || `Consult ${handoff.agent}`,
                    command: undefined
                });
            }
        }

        return followups;
    };
}

module.exports = {
    createChatHandler,
    createFollowupProvider
};

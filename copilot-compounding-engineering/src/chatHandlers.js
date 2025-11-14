const vscode = require('vscode');

/**
 * Create a chat handler for an agent or prompt
 * @param {Object} config - Agent/prompt configuration from parser
 * @param {string} participantId - Full participant ID (e.g., "compounding-engineering.architecture-strategist")
 * @param {Map} allAgents - Map of all loaded agents for handoff support
 * @param {Set} visitedAgents - Set of agent IDs already visited in this call chain (for cycle detection)
 * @param {number} depth - Current recursion depth (for depth limiting)
 * @returns {Function} Chat request handler function
 */
function createChatHandler(config, participantId, allAgents = new Map(), visitedAgents = new Set(), depth = 0) {
    // Maximum recursion depth to prevent infinite loops
    const MAX_DEPTH = 5;

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

            // Use the model from the request - this is the model the user selected in chat UI
            // VS Code provides the selected model directly on the request object
            if (!request.model) {
                stream.markdown('⚠️ No language model available. Please ensure GitHub Copilot is active.');
                return;
            }

            const model = request.model;

            // Build messages array with conversation history
            const messages = [];

            // Add conversation history for context continuity
            if (context.history && context.history.length > 0) {
                for (const item of context.history) {
                    if (item instanceof vscode.ChatResponseTurn) {
                        // Extract markdown content from previous assistant responses
                        const content = item.response
                            .filter(r => r instanceof vscode.ChatResponseMarkdownPart)
                            .map(r => r.value.value)
                            .join('\n');

                        if (content) {
                            messages.push(vscode.LanguageModelChatMessage.Assistant(content));
                        }
                    } else if (item instanceof vscode.ChatRequestTurn) {
                        // Add previous user requests
                        messages.push(vscode.LanguageModelChatMessage.User(item.prompt));
                    }
                }
            }

            // Add system prompt
            messages.push(vscode.LanguageModelChatMessage.User(systemPrompt));

            // Add current user prompt
            messages.push(vscode.LanguageModelChatMessage.User(finalPrompt));

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

            // Check token limit before sending request
            const estimatedTokens = messages.reduce((sum, m) => {
                const content = typeof m.content === 'string'
                    ? m.content
                    : m.content.map(p => p.value || '').join('');
                return sum + Math.ceil(content.length / 4);
            }, 0);

            if (estimatedTokens > model.maxInputTokens) {
                stream.markdown(
                    `⚠️ Request is too large (${estimatedTokens} tokens). ` +
                    `Maximum is ${model.maxInputTokens} tokens. Please start a new conversation or reduce the amount of context.`
                );
                return;
            }

            // Send request to language model with streaming
            const chatResponse = await model.sendRequest(messages, {}, token);

            // Stream the response
            for await (const fragment of chatResponse.text) {
                stream.markdown(fragment);
            }

            // Handle handoffs if configured (for prompts)
            if (config.handoffs && config.handoffs.length > 0) {
                // Check depth limit before processing handoffs
                if (depth >= MAX_DEPTH) {
                    stream.markdown('\n\n⚠️ *Maximum handoff depth reached. Skipping additional agent consultations.*\n');
                    return;
                }

                stream.markdown('\n\n---\n\n');
                stream.markdown('**Additional Analysis from Specialized Agents:**\n\n');

                for (const handoff of config.handoffs) {
                    if (handoff.send === false) {
                        // This is an optional handoff - show as a button
                        // Use safe default for prompt
                        const handoffPrompt = handoff.prompt || 'Please continue the analysis using the context above.';
                        stream.button({
                            command: 'workbench.action.chat.open',
                            arguments: [`@${handoff.agent} ${handoffPrompt}`],
                            title: handoff.label || `Consult ${handoff.agent}`
                        });
                    } else {
                        // Auto-execute handoff - check for cycles first
                        const agentId = handoff.agent;

                        // Cycle detection: skip if we've already visited this agent
                        if (visitedAgents.has(agentId)) {
                            stream.markdown(`\n\n⚠️ *Skipping @${agentId} to prevent circular handoff*\n`);
                            continue;
                        }

                        stream.markdown(`\n\n### ${handoff.label || agentId}\n\n`);
                        const agentConfig = allAgents.get(agentId);

                        if (agentConfig) {
                            // Create new visited set with current agent added
                            const newVisited = new Set(visitedAgents);
                            newVisited.add(participantId);

                            // Create a sub-request to the other agent with cycle protection
                            const subHandler = createChatHandler(
                                agentConfig,
                                agentId,
                                allAgents,
                                newVisited,
                                depth + 1
                            );

                            // Use safe default for prompt
                            const handoffPrompt = handoff.prompt || userMessage || 'Please continue the analysis using the context above.';
                            const subRequest = {
                                prompt: handoffPrompt,
                                command: undefined,
                                model: request.model
                            };

                            await subHandler(subRequest, context, stream, token);
                        } else {
                            stream.markdown(`*Agent @${agentId} not found*\n`);
                        }
                    }
                }
            }

        } catch (error) {
            // Error details are already sent to the user via stream.markdown below
            // No need for additional logging here as it would be redundant

            // Handle LanguageModelError specifically
            if (error instanceof vscode.LanguageModelError) {
                let errorMessage = 'An error occurred while processing your request.';

                switch (error.code) {
                    case vscode.LanguageModelError.NotFound:
                        errorMessage = 'Language model not found. Please ensure GitHub Copilot is installed.';
                        break;
                    case vscode.LanguageModelError.NoPermissions:
                        errorMessage = 'You need to grant permission to use the language model. Please check your GitHub Copilot settings.';
                        break;
                    case vscode.LanguageModelError.Blocked:
                        errorMessage = 'Request was blocked by content filters. Please try rephrasing your question.';
                        break;
                    default:
                        errorMessage = `Language model error: ${error.message}`;
                }

                stream.markdown(`⚠️ ${errorMessage}`);
            } else if (error.message.includes('rate limit')) {
                stream.markdown('⚠️ Rate limit reached. Please wait a moment and try again.');
            } else if (error.message.includes('model')) {
                stream.markdown('⚠️ Language model unavailable. Please check your GitHub Copilot subscription.');
            } else if (token.isCancellationRequested) {
                stream.markdown('Request cancelled.');
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
                // Use safe default for prompt
                const handoffPrompt = handoff.prompt || 'Please continue the analysis using the context above.';
                followups.push({
                    prompt: `@${handoff.agent} ${handoffPrompt}`,
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

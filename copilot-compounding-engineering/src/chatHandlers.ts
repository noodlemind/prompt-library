import * as vscode from 'vscode';
import { AgentConfig } from './types';

/**
 * Create a chat handler for an agent or prompt
 * @param config - Agent/prompt configuration from parser
 * @param participantId - Full participant ID (e.g., "compounding-engineering.architecture-strategist")
 * @param allAgents - Map of all loaded agents for handoff support
 * @param visitedAgents - Set of agent IDs already visited in this call chain (for cycle detection)
 * @param depth - Current recursion depth (for depth limiting)
 * @param outputChannel - Output channel for structured logging
 * @returns Chat request handler function
 */
export function createChatHandler(
    config: AgentConfig,
    participantId: string,
    allAgents: Map<string, AgentConfig> = new Map(),
    visitedAgents: Set<string> = new Set(),
    depth: number = 0,
    outputChannel?: vscode.OutputChannel
): vscode.ChatRequestHandler {
    // Maximum recursion depth to prevent infinite loops
    const MAX_DEPTH = 5;

    return async (request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> => {
        try {
            // Show that the agent is processing
            stream.progress(`${config.name} is analyzing...`);

            // Build the system prompt from agent instructions
            const systemPrompt = buildSystemPrompt(config, context);

            // Get user's message
            const userMessage = request.prompt;

            // Handle commands if this is a prompt with commands
            const commandName = request.command;
            const finalPrompt = userMessage;

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
            const messages: vscode.LanguageModelChatMessage[] = [];

            // Add conversation history for context continuity
            // Limit history to prevent memory issues and token overflow
            const MAX_HISTORY_TURNS = 20;
            if (context.history && context.history.length > 0) {
                const recentHistory = context.history.slice(-MAX_HISTORY_TURNS);

                for (const item of recentHistory) {
                    if (item instanceof vscode.ChatResponseTurn) {
                        // Extract content from all response part types
                        const content = item.response.map(r => {
                            if (r instanceof vscode.ChatResponseMarkdownPart) {
                                return r.value.value;
                            } else if (r instanceof vscode.ChatResponseFileTree) {
                                return '[File tree displayed]';
                            } else if (r instanceof vscode.ChatResponseAnchorPart) {
                                return `[Reference: ${r.value?.title || 'link'}]`;
                            } else if (r instanceof vscode.ChatResponseCommandButtonPart) {
                                return `[Button: ${r.value?.title || 'action'}]`;
                            }
                            return '';
                        }).filter(Boolean).join('\n');

                        // Always include assistant turn to maintain alternating sequence
                        messages.push(vscode.LanguageModelChatMessage.Assistant(
                            content || '[No text response]'
                        ));
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
            // Use more conservative estimation: char count / 3 with 15% buffer
            const estimatedTokens = messages.reduce((sum, m) => {
                const content = typeof m.content === 'string'
                    ? m.content
                    : m.content.map(p => p.value || '').join('');
                // More conservative estimation for better accuracy
                return sum + Math.ceil(content.length / 3);
            }, 0);

            // Add 15% safety margin to prevent near-limit failures
            const maxAllowedTokens = Math.floor(model.maxInputTokens * 0.85);
            const utilizationPercent = (estimatedTokens / model.maxInputTokens) * 100;

            // Warn at 80% capacity
            if (utilizationPercent > 80 && utilizationPercent <= 100) {
                stream.markdown(
                    `⚠️ *Context is ${utilizationPercent.toFixed(0)}% full. ` +
                    'Consider starting a new conversation soon to avoid hitting limits.*\n\n'
                );
            }

            if (estimatedTokens > maxAllowedTokens) {
                stream.markdown(
                    `⚠️ Request is too large (estimated ${estimatedTokens} tokens). ` +
                    `Maximum is ${maxAllowedTokens} tokens. Please start a new conversation or reduce the amount of context.`
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
                            // Extract agent ID consistently for cycle detection
                            // participantId format: "compounding-engineering.agent-name"
                            const currentAgentId = participantId.replace('compounding-engineering.', '');

                            // Create new visited set with current agent added
                            const newVisited = new Set(visitedAgents);
                            newVisited.add(currentAgentId);

                            // Create a sub-request to the other agent with cycle protection
                            const subHandler = createChatHandler(
                                agentConfig,
                                `compounding-engineering.${agentId}`,
                                allAgents,
                                newVisited,
                                depth + 1,
                                outputChannel
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
            // Log detailed error information to output channel for debugging
            const logLines = [
                `[Compounding Engineering Error] ${config.name} (${participantId})`,
                `• Type: ${error?.constructor?.name || 'Unknown'}`,
                `• Message: ${error?.message || 'No message provided'}`
            ];

            if (error && 'code' in error) {
                logLines.push(`• Code: ${error.code}`);
            }

            if (error && 'cause' in error && error.cause) {
                const cause = error.cause;
                let causeText;
                if (typeof cause === 'string') {
                    causeText = cause;
                } else if (typeof cause === 'object') {
                    try {
                        causeText = JSON.stringify(cause);
                    } catch (jsonError) {
                        causeText = `[Unserializable cause: ${jsonError.message}]`;
                    }
                }

                if (causeText) {
                    logLines.push(`• Cause: ${causeText}`);
                }
            }

            if (error?.stack) {
                logLines.push(error.stack);
            }

            if (outputChannel) {
                for (const line of logLines) {
                    outputChannel.appendLine(line);
                }
            } else {
                console.error(logLines.join('\n'));
            }

            // Handle LanguageModelError specifically
            if (error instanceof vscode.LanguageModelError) {
                let normalizedCode = typeof error.code === 'string' ? error.code.toLowerCase() : '';

                const extractCauseCode = cause => {
                    if (!cause) {
                        return '';
                    }

                    if (typeof cause === 'string') {
                        return cause.toLowerCase();
                    }

                    if (typeof cause === 'object') {
                        if (typeof cause.code === 'string') {
                            return cause.code.toLowerCase();
                        }

                        if (typeof cause.reason === 'string') {
                            return cause.reason.toLowerCase();
                        }
                    }

                    return '';
                };

                if (!normalizedCode) {
                    normalizedCode = extractCauseCode(error.cause);
                }

                let errorMessage = 'A language model error occurred. Please try again shortly.';

                switch (normalizedCode) {
                    case 'off_topic':
                    case 'content_filter':
                    case 'content_filter_blocked':
                    case 'blocked':
                        errorMessage = 'Request was blocked by content filters. Please try rephrasing your prompt.';
                        break;
                    case 'no_permissions':
                    case 'forbidden':
                        errorMessage = 'You do not have permission to use this language model. Please check your GitHub Copilot settings.';
                        break;
                    case 'quota_exceeded':
                    case 'rate_limited':
                    case 'rate_limit_exceeded':
                        errorMessage = 'Request exceeded usage limits. Please wait a moment and try again.';
                        break;
                    case 'model_not_found':
                    case 'not_found':
                        errorMessage = 'The requested language model is unavailable. Please ensure GitHub Copilot is installed and active.';
                        break;
                    default:
                        if (normalizedCode) {
                            errorMessage = `Language model error (${normalizedCode}). Please try again.`;
                        }
                        break;
                }

                stream.markdown(`⚠️ ${errorMessage}`);
            } else if (token.isCancellationRequested) {
                stream.markdown('Request cancelled.');
            } else {
                // Generic error message without exposing internal details
                stream.markdown('⚠️ An unexpected error occurred. Please check the Output panel (View > Output > Compounding Engineering) for details.');
            }
        }
    };
}

/**
 * Build system prompt from agent configuration and context
 * @param config - Agent/prompt configuration
 * @param _context - VS Code chat context (unused but kept for interface compatibility)
 * @returns System prompt for the language model
 */
function buildSystemPrompt(config: AgentConfig, _context: vscode.ChatContext): string {
    let prompt = `You are ${config.name}, an AI assistant specialized in the following:\n\n`;
    prompt += `${config.description}\n\n`;
    prompt += '## Your Role and Instructions\n\n';
    prompt += config.instructions;

    // Note: Tools like 'search', 'githubRepo', 'fetch' are automatically available in agent mode
    // VS Code provides built-in tools for workspace search, file operations, terminal commands, etc.
    // The language model can use these tools automatically without manual registration

    // Add workspace context
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        prompt += '\n\n## Workspace Context\n\n';
        prompt += `Current workspace: ${vscode.workspace.workspaceFolders[0].uri.fsPath}\n`;
    }

    return prompt;
}

/**
 * Create a follow-up provider for a chat participant
 * @param config - Agent/prompt configuration
 * @returns Follow-up provider function
 */
export function createFollowupProvider(config: AgentConfig): vscode.ChatFollowupProvider {
    return (_result: vscode.ChatResult, _context: vscode.ChatContext, _token: vscode.CancellationToken): vscode.ChatFollowup[] => {
        const followups: vscode.ChatFollowup[] = [];

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

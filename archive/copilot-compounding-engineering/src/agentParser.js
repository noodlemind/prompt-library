const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

/**
 * Parse a markdown file with YAML frontmatter
 * @param {string} filePath - Path to the .agent.md or .prompt.md file
 * @param {Object} outputChannel - VS Code output channel for logging
 * @returns {Object} Parsed agent/prompt configuration with metadata and instructions
 */
function parseAgentFile(filePath, outputChannel) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');

        // Extract YAML frontmatter between --- delimiters
        const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);

        if (!frontmatterMatch) {
            if (outputChannel) {
                outputChannel.appendLine(`ERROR: No frontmatter found in ${filePath}`);
            }
            return null;
        }

        const [, frontmatterStr, markdownContent] = frontmatterMatch;

        // Parse YAML frontmatter with safety options
        const metadata = yaml.parse(frontmatterStr, {
            strict: true,
            uniqueKeys: true,
            maxAliasCount: 10
        });

        // Validate metadata structure
        if (!metadata || typeof metadata !== 'object') {
            if (outputChannel) {
                outputChannel.appendLine(`ERROR: Invalid YAML in ${filePath}: expected object`);
            }
            return null;
        }

        // Validate required fields
        if (!metadata.name || typeof metadata.name !== 'string') {
            if (outputChannel) {
                outputChannel.appendLine(`ERROR: Missing or invalid 'name' field in ${filePath}`);
            }
            return null;
        }

        if (!metadata.description || typeof metadata.description !== 'string') {
            if (outputChannel) {
                outputChannel.appendLine(`ERROR: Missing or invalid 'description' field in ${filePath}`);
            }
            return null;
        }

        // Validate and filter handoffs
        const handoffs = Array.isArray(metadata.handoffs)
            ? metadata.handoffs.filter(h => {
                if (!h || typeof h !== 'object') {
                    if (outputChannel) {
                        outputChannel.appendLine(`WARNING: Invalid handoff in ${filePath}: not an object`);
                    }
                    return false;
                }
                if (typeof h.agent !== 'string' || !h.agent) {
                    if (outputChannel) {
                        outputChannel.appendLine(`WARNING: Invalid handoff in ${filePath}: missing or invalid 'agent' field`);
                    }
                    return false;
                }
                return true;
            })
            : [];

        // Validate tools array
        const tools = Array.isArray(metadata.tools)
            ? metadata.tools.filter(t => typeof t === 'string')
            : [];

        // Return combined object with validated data
        return {
            name: metadata.name,
            description: metadata.description,
            tools: tools,
            model: typeof metadata.model === 'string' ? metadata.model : 'Claude Sonnet 4',
            handoffs: handoffs,
            instructions: markdownContent.trim(),
            filePath
        };
    } catch (error) {
        if (outputChannel) {
            outputChannel.appendLine(`ERROR: Failed to parse agent file ${filePath}: ${error.message}`);
        }
        return null;
    }
}

/**
 * Load all agent files from a directory
 * @param {string} agentsDir - Path to the agents directory
 * @param {Object} outputChannel - VS Code output channel for logging
 * @returns {Map<string, Object>} Map of agent ID to parsed agent configuration
 */
function loadAllAgents(agentsDir, outputChannel) {
    const agents = new Map();

    try {
        if (!fs.existsSync(agentsDir)) {
            if (outputChannel) {
                outputChannel.appendLine(`WARNING: Agents directory not found: ${agentsDir}`);
            }
            return agents;
        }

        const files = fs.readdirSync(agentsDir);

        for (const file of files) {
            if (file.endsWith('.agent.md')) {
                const filePath = path.join(agentsDir, file);
                const agent = parseAgentFile(filePath, outputChannel);

                if (agent) {
                    // Extract agent ID from filename (e.g., "architecture-strategist.agent.md" -> "architecture-strategist")
                    const agentId = file.replace('.agent.md', '');
                    agents.set(agentId, agent);
                    if (outputChannel) {
                        outputChannel.appendLine(`  Loaded agent: ${agentId}`);
                    }
                }
            }
        }
    } catch (error) {
        if (outputChannel) {
            outputChannel.appendLine(`ERROR: Failed to load agents from ${agentsDir}: ${error.message}`);
        }
    }

    return agents;
}

/**
 * Load all prompt files from a directory
 * @param {string} promptsDir - Path to the prompts directory
 * @param {Object} outputChannel - VS Code output channel for logging
 * @returns {Map<string, Object>} Map of prompt ID to parsed prompt configuration
 */
function loadAllPrompts(promptsDir, outputChannel) {
    const prompts = new Map();

    try {
        if (!fs.existsSync(promptsDir)) {
            if (outputChannel) {
                outputChannel.appendLine(`WARNING: Prompts directory not found: ${promptsDir}`);
            }
            return prompts;
        }

        const files = fs.readdirSync(promptsDir);

        for (const file of files) {
            if (file.endsWith('.prompt.md')) {
                const filePath = path.join(promptsDir, file);
                const prompt = parseAgentFile(filePath, outputChannel);

                if (prompt) {
                    // Extract prompt ID from filename
                    const promptId = file.replace('.prompt.md', '');
                    prompts.set(promptId, prompt);
                    if (outputChannel) {
                        outputChannel.appendLine(`  Loaded prompt: ${promptId}`);
                    }
                }
            }
        }
    } catch (error) {
        if (outputChannel) {
            outputChannel.appendLine(`ERROR: Failed to load prompts from ${promptsDir}: ${error.message}`);
        }
    }

    return prompts;
}

module.exports = {
    parseAgentFile,
    loadAllAgents,
    loadAllPrompts
};

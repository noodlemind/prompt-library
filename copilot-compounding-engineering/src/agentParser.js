const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

/**
 * Parse a markdown file with YAML frontmatter
 * @param {string} filePath - Path to the .agent.md or .prompt.md file
 * @returns {Object} Parsed agent/prompt configuration with metadata and instructions
 */
function parseAgentFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');

        // Extract YAML frontmatter between --- delimiters
        const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);

        if (!frontmatterMatch) {
            console.error(`No frontmatter found in ${filePath}`);
            return null;
        }

        const [, frontmatterStr, markdownContent] = frontmatterMatch;

        // Parse YAML frontmatter
        const metadata = yaml.parse(frontmatterStr);

        // Return combined object
        return {
            name: metadata.name,
            description: metadata.description,
            tools: metadata.tools || [],
            model: metadata.model || 'Claude Sonnet 4',
            handoffs: metadata.handoffs || [],
            instructions: markdownContent.trim(),
            filePath
        };
    } catch (error) {
        console.error(`Error parsing agent file ${filePath}:`, error);
        return null;
    }
}

/**
 * Load all agent files from a directory
 * @param {string} agentsDir - Path to the agents directory
 * @returns {Map<string, Object>} Map of agent ID to parsed agent configuration
 */
function loadAllAgents(agentsDir) {
    const agents = new Map();

    try {
        if (!fs.existsSync(agentsDir)) {
            console.warn(`Agents directory not found: ${agentsDir}`);
            return agents;
        }

        const files = fs.readdirSync(agentsDir);

        for (const file of files) {
            if (file.endsWith('.agent.md')) {
                const filePath = path.join(agentsDir, file);
                const agent = parseAgentFile(filePath);

                if (agent) {
                    // Extract agent ID from filename (e.g., "architecture-strategist.agent.md" -> "architecture-strategist")
                    const agentId = file.replace('.agent.md', '');
                    agents.set(agentId, agent);
                    console.log(`Loaded agent: ${agentId}`);
                }
            }
        }
    } catch (error) {
        console.error(`Error loading agents from ${agentsDir}:`, error);
    }

    return agents;
}

/**
 * Load all prompt files from a directory
 * @param {string} promptsDir - Path to the prompts directory
 * @returns {Map<string, Object>} Map of prompt ID to parsed prompt configuration
 */
function loadAllPrompts(promptsDir) {
    const prompts = new Map();

    try {
        if (!fs.existsSync(promptsDir)) {
            console.warn(`Prompts directory not found: ${promptsDir}`);
            return prompts;
        }

        const files = fs.readdirSync(promptsDir);

        for (const file of files) {
            if (file.endsWith('.prompt.md')) {
                const filePath = path.join(promptsDir, file);
                const prompt = parseAgentFile(filePath);

                if (prompt) {
                    // Extract prompt ID from filename
                    const promptId = file.replace('.prompt.md', '');
                    prompts.set(promptId, prompt);
                    console.log(`Loaded prompt: ${promptId}`);
                }
            }
        }
    } catch (error) {
        console.error(`Error loading prompts from ${promptsDir}:`, error);
    }

    return prompts;
}

/**
 * Extract agent name from handoff configuration
 * @param {Object} handoff - Handoff configuration from prompt
 * @returns {string} Agent ID to hand off to
 */
function extractHandoffAgent(handoff) {
    return handoff.agent;
}

module.exports = {
    parseAgentFile,
    loadAllAgents,
    loadAllPrompts,
    extractHandoffAgent
};

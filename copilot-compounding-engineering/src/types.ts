/**
 * Type definitions for the Compounding Engineering extension
 */

export interface Handoff {
    label?: string;
    agent: string;
    prompt?: string;
    send?: boolean;
}

export interface AgentConfig {
    name: string;
    description: string;
    tools: string[];
    model: string;
    handoffs: Handoff[];
    instructions: string;
    filePath: string;
}

export interface PromptConfig extends AgentConfig {
    // Prompts have the same structure as agents
}

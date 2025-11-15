const assert = require('assert');
const path = require('path');
const { parseAgentFile, loadAllAgents, loadAllPrompts } = require('../../src/agentParser');

suite('Agent Parser Test Suite', () => {
    
    suite('parseAgentFile', () => {
        test('should parse valid agent file', () => {
            const filePath = path.join(__dirname, '../fixtures/sample.agent.md');
            const result = parseAgentFile(filePath);
            
            assert.strictEqual(result.name, 'Test Agent');
            assert.strictEqual(result.description, 'A test agent for unit testing');
            assert.strictEqual(result.model, 'Claude Sonnet 4');
            assert.ok(Array.isArray(result.tools));
            assert.strictEqual(result.tools.length, 2);
            assert.strictEqual(result.tools[0], 'search');
            assert.strictEqual(result.tools[1], 'githubRepo');
        });

        test('should parse handoffs correctly', () => {
            const filePath = path.join(__dirname, '../fixtures/sample.agent.md');
            const result = parseAgentFile(filePath);
            
            assert.ok(Array.isArray(result.handoffs));
            assert.strictEqual(result.handoffs.length, 1);
            assert.strictEqual(result.handoffs[0].label, 'Consult Security');
            assert.strictEqual(result.handoffs[0].agent, 'security-sentinel');
            assert.strictEqual(result.handoffs[0].send, false);
        });

        test('should parse markdown content as instructions', () => {
            const filePath = path.join(__dirname, '../fixtures/sample.agent.md');
            const result = parseAgentFile(filePath);
            
            assert.ok(result.instructions);
            assert.ok(result.instructions.includes('Test Agent Instructions'));
            assert.ok(result.instructions.includes('unit testing the agent parser'));
        });

        test('should return null for non-existent file', () => {
            const result = parseAgentFile('/non/existent/file.agent.md');
            assert.strictEqual(result, null);
        });
    });

    suite('parseAgentFile - Prompt Files', () => {
        test('should parse valid prompt file', () => {
            const filePath = path.join(__dirname, '../fixtures/sample.prompt.md');
            const result = parseAgentFile(filePath);
            
            assert.strictEqual(result.name, 'Test Prompt');
            assert.strictEqual(result.description, 'A test prompt for unit testing');
            assert.ok(result.instructions.includes('Test Prompt Instructions'));
        });

        test('should parse prompt handoffs with send:true', () => {
            const filePath = path.join(__dirname, '../fixtures/sample.prompt.md');
            const result = parseAgentFile(filePath);
            
            assert.ok(Array.isArray(result.handoffs));
            assert.strictEqual(result.handoffs.length, 1);
            assert.strictEqual(result.handoffs[0].agent, 'architecture-strategist');
            assert.strictEqual(result.handoffs[0].send, true);
        });
    });

    suite('loadAllAgents', () => {
        test('should load agents from directory', () => {
            const agentsDir = path.join(__dirname, '../../.github/agents');
            const agents = loadAllAgents(agentsDir);
            
            assert.ok(agents instanceof Map);
            assert.ok(agents.size > 0);
            
            // Check that architecture-strategist exists
            assert.ok(agents.has('architecture-strategist'));
            const agent = agents.get('architecture-strategist');
            assert.strictEqual(agent.name, 'Architecture Strategist');
        });

        test('should return empty Map for non-existent directory', () => {
            const agents = loadAllAgents('/non/existent/directory');
            assert.ok(agents instanceof Map);
            assert.strictEqual(agents.size, 0);
        });
    });

    suite('loadAllPrompts', () => {
        test('should load prompts from directory', () => {
            const promptsDir = path.join(__dirname, '../../.github/prompts');
            const prompts = loadAllPrompts(promptsDir);
            
            assert.ok(prompts instanceof Map);
            assert.ok(prompts.size > 0);
        });

        test('should return empty Map for non-existent directory', () => {
            const prompts = loadAllPrompts('/non/existent/directory');
            assert.ok(prompts instanceof Map);
            assert.strictEqual(prompts.size, 0);
        });
    });
});

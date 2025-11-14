# Compounding Engineering Extension - Improvements & Roadmap

## Executive Summary

After reviewing GitHub Universe 2025 announcements and analyzing the current implementation, we've identified **10 critical improvements** needed to make the extension production-ready and leverage the latest VS Code and GitHub Copilot capabilities.

---

## 🚨 **Priority 1: Critical Missing Features**

### 1. ~~Tool Implementation~~ (NOT NEEDED! ✅)

**UPDATE:** Tools are **automatically available** in VS Code agent mode!

**Clarification:**
- VS Code provides **built-in tools** for workspace search, file operations, terminal commands, fetching web content, etc.
- These tools are **automatically invoked** by the language model based on the user's prompt
- The `tools: ['search', 'githubRepo', 'fetch']` in agent YAML is just **documentation** of expected capabilities
- We **DON'T need to manually register** basic tools - they're already there!

**Built-in Tools Available:**
- ✅ Workspace/codebase search (`#codebase`)
- ✅ File read/edit operations
- ✅ Terminal command execution
- ✅ Compile/lint error detection
- ✅ Web content fetching (`#fetch`)
- ✅ GitHub integration (part of Copilot)

**Only register custom tools if you need specialized functionality not provided by VS Code** (e.g., custom database queries, specialized API clients).

**Implementation:**
```javascript
// New file: src/toolRegistry.js

const vscode = require('vscode');

/**
 * Register all tools that agents can use
 */
function registerTools(context) {
    // 1. Search Tool
    const searchTool = vscode.lm.registerTool('search', {
        description: 'Search for code patterns in the workspace',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'The search pattern' },
                fileTypes: { type: 'array', items: { type: 'string' } }
            },
            required: ['pattern']
        },
        invoke: async (input, token) => {
            const results = await vscode.workspace.findFiles(
                '**/*',
                '**/node_modules/**',
                100
            );

            // Search through files
            // Return results as LanguageModelToolResult
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(results))
            ]);
        }
    });

    // 2. GitHub Repo Tool
    const githubRepoTool = vscode.lm.registerTool('githubRepo', {
        description: 'Access GitHub repository information',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['list-prs', 'get-pr', 'list-issues'],
                    description: 'The GitHub action to perform'
                },
                number: { type: 'number', description: 'PR or issue number' }
            },
            required: ['action']
        },
        invoke: async (input, token) => {
            // Use GitHub API or gh CLI
            const { exec } = require('child_process');
            const util = require('util');
            const execPromise = util.promisify(exec);

            try {
                const { stdout } = await execPromise(`gh ${input.action} --json url,title`);
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(stdout)
                ]);
            } catch (error) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Error: ${error.message}`)
                ]);
            }
        }
    });

    // 3. Fetch Tool (for external documentation)
    const fetchTool = vscode.lm.registerTool('fetch', {
        description: 'Fetch content from external URLs',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'URL to fetch' }
            },
            required: ['url']
        },
        invoke: async (input, token) => {
            try {
                const https = require('https');
                const response = await new Promise((resolve, reject) => {
                    https.get(input.url, (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => resolve(data));
                    }).on('error', reject);
                });

                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(response)
                ]);
            } catch (error) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Error fetching URL: ${error.message}`)
                ]);
            }
        }
    });

    context.subscriptions.push(searchTool, githubRepoTool, fetchTool);
}

module.exports = { registerTools };
```

**Impact:** 🔴 **CRITICAL** - Without tools, agents can't perform their core functions

---

### 2. ~~Dynamic Model Selection~~ (FIXED! ✅)

**UPDATE:** We now respect the user's model choice from the chat dropdown.

**Previous Problem:** Hardcoded to `family: 'gpt-4'`

**Fixed Implementation:**
```javascript
// chatHandlers.js - Now respects user's model selection
const models = await vscode.lm.selectChatModels({
    vendor: 'copilot'
    // No family specified - uses whatever model user selected in chat UI
});
```

**How It Works:**
- User selects model in chat dropdown (Auto, GPT-4, Claude Sonnet 4, etc.)
- Our agents honor that choice
- When "Auto" is selected, VS Code intelligently chooses between Claude Sonnet 4, GPT-5, GPT-5 mini, and GPT-4.1

**Why This Is Better:**
- ✅ User has full control
- ✅ Can use premium models (Copilot Pro+)
- ✅ Can switch models per conversation
- ✅ No hardcoded preferences

**Impact:** ✅ **FIXED** - Users control model selection

---

### 3. Conversation History Support

**Problem:** Not using `context.history` for conversation continuity

**Current State:** Each request is isolated, no memory of previous messages

**Solution:**
```javascript
// In createChatHandler, add history to messages

// Build messages array with conversation history
const messages = [];

// Add conversation history for context
if (context.history && context.history.length > 0) {
    for (const historyItem of context.history) {
        if (historyItem instanceof vscode.ChatRequestTurn) {
            messages.push(
                vscode.LanguageModelChatMessage.User(historyItem.prompt)
            );
        } else if (historyItem instanceof vscode.ChatResponseTurn) {
            // Add assistant responses from history
            const responseText = historyItem.response
                .map(part => part.value)
                .join('');
            messages.push(
                vscode.LanguageModelChatMessage.Assistant(responseText)
            );
        }
    }
}

// Add system prompt
messages.push(vscode.LanguageModelChatMessage.User(systemPrompt));

// Add current prompt
messages.push(vscode.LanguageModelChatMessage.User(finalPrompt));
```

**Impact:** 🟡 **HIGH** - Agents can't maintain context across conversation

---

## ⚡ **Priority 2: GitHub Universe 2025 Features**

### 4. Multi-Model Support (GPT-5-Codex, Claude Sonnet 4.5)

**Announced at GitHub Universe:**
- GPT-5-Codex: OpenAI's latest for agentic coding
- Claude Sonnet 4.5: Anthropic's most advanced coding model

**Implementation:**
```javascript
// Add to extension configuration (package.json)
"contributes": {
    "configuration": {
        "title": "Compounding Engineering",
        "properties": {
            "compoundingEngineering.preferredModel": {
                "type": "string",
                "enum": ["auto", "gpt-4", "gpt-5-codex", "claude-sonnet-4", "claude-sonnet-4.5"],
                "default": "auto",
                "description": "Preferred language model for agents"
            }
        }
    }
}
```

---

### 5. Mission Control Telemetry

**Announced:** Mission Control provides unified view of all agent sessions

**Implementation:**
```javascript
// Add telemetry tracking in extension.js

const telemetryLogger = vscode.env.createTelemetryLogger({
    sendEventData: (eventName, data) => {
        console.log(`Telemetry: ${eventName}`, data);
    },
    sendErrorData: (error, data) => {
        console.error(`Telemetry Error:`, error, data);
    }
});

// Track agent invocations
telemetryLogger.logUsage('agent.invoked', {
    agentId: participantId,
    timestamp: Date.now()
});
```

---

### 6. MCP (Model Context Protocol) Integration

**Announced:** VS Code now supports MCP servers for extended capabilities

**Implementation:**
```javascript
// Connect to MCP servers for additional context
// This would allow agents to access databases, APIs, etc.

const mcpClient = await vscode.mcp.connectToServer({
    serverPath: '/path/to/mcp/server',
    capabilities: ['prompts', 'resources', 'tools']
});

// Use MCP resources in agent context
const resources = await mcpClient.listResources();
```

---

## 🔧 **Priority 3: UX & Polish**

### 7. Custom Agent Icons

**Current:** Using generic ThemeIcon('robot')

**Improvement:**
```javascript
// Create SVG icons for different agent types
const iconMap = {
    'security-sentinel': 'shield',
    'performance-oracle': 'pulse',
    'architecture-strategist': 'organization',
    // ...
};

participant.iconPath = new vscode.ThemeIcon(iconMap[agentId] || 'robot');
```

---

### 8. Enhanced Error Handling

**Current:** Basic error messages

**Improvement:**
```javascript
// Add retry logic with exponential backoff
async function sendRequestWithRetry(model, messages, options, token, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await model.sendRequest(messages, options, token);
        } catch (error) {
            if (error.message.includes('rate limit') && i < retries - 1) {
                const delay = Math.pow(2, i) * 1000; // Exponential backoff
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            throw error;
        }
    }
}
```

---

### 9. User Configuration

**Add settings for:**
```json
{
    "compoundingEngineering.enabledAgents": ["*"],  // Or specific list
    "compoundingEngineering.modelPreference": "auto",
    "compoundingEngineering.maxTokens": 4000,
    "compoundingEngineering.temperature": 0.7,
    "compoundingEngineering.enableTelemetry": true
}
```

---

### 10. Plan Mode Integration

**For `/plan` prompt:**
- Integrate with VS Code's Plan Mode
- Ask clarifying questions
- Build step-by-step plans
- Track plan execution

---

## 📊 **Implementation Roadmap**

### ~~Phase 1: Critical Fixes~~ ✅ DONE!
- ✅ ~~Tool Implementation~~ - NOT NEEDED (built-in to VS Code agent mode)
- ✅ Dynamic Model Selection - FIXED (respects user's choice)
- ⚠️ Conversation History Support - STILL NEEDED (see below)

### Phase 2: GitHub Universe Features (2-3 days)
- ✅ Multi-Model Support
- ✅ Mission Control Telemetry
- ✅ MCP Integration (basic)

### Phase 3: Polish & UX (1-2 days)
- ✅ Custom Icons
- ✅ Enhanced Error Handling
- ✅ User Configuration
- ✅ Plan Mode Integration

---

## 🎯 **Expected Outcomes**

After implementing these improvements:

1. **Functional Tools**: Agents can actually search code, access GitHub, fetch docs
2. **Optimal Models**: Each agent uses the best model for its task
3. **Better Context**: Conversation history provides continuity
4. **GitHub Alignment**: Compatible with Agent HQ and Mission Control
5. **Production Ready**: Robust error handling, configuration, telemetry

---

## 🚀 **Remaining Work**

After clarifications, here's what actually needs work:

### ✅ Already Fixed:
1. ~~**Tool Implementation**~~ - Not needed! Built-in to VS Code
2. ~~**Dynamic Model Selection**~~ - Fixed! Now respects user's choice

### Still To Do (Optional):
1. **Conversation History** (1-2 hours) - Better multi-turn conversations
2. **Custom Icons** (30 mins) - Visual polish
3. **Enhanced Error Handling** (1 hour) - Better user experience
4. **User Configuration** (1 hour) - Settings for power users

---

## 📝 **Notes**

- All improvements maintain backward compatibility
- Extension will work without these but at reduced capability
- Tools are the most critical missing piece
- GitHub Universe 2025 features future-proof the extension

---

**Version:** 2.0.0 (current) → 2.1.0 (with improvements)
**Last Updated:** 2025-11-13

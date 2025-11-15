# Compounding Engineering for GitHub Copilot

A comprehensive collection of specialized AI agents and prompt templates for GitHub Copilot that work across VS Code, IntelliJ IDEA, and other JetBrains IDEs. Designed to compound your engineering productivity through systematic, multi-agent workflows.

## Overview

This repository provides a suite of 17 specialized agents and 6 workflow prompts that work together to deliver high-quality code reviews, architectural analysis, security audits, performance optimization, and more.

**Cross-IDE Compatibility:** The agents use the standard `.github/agents/*.agent.md` format that works in:
- ✅ VS Code
- ✅ IntelliJ IDEA, PyCharm, WebStorm, and other JetBrains IDEs
- ✅ GitHub.com (web interface)
- ✅ GitHub Copilot CLI

## Features

- **17 Specialized Agents**: Each agent is an expert in a specific domain (architecture, security, performance, etc.)
- **6 Workflow Prompts**: Pre-built workflows for common engineering tasks (review, plan, triage, etc.)
- **Agent Handoffs**: Agents can delegate to other agents for comprehensive multi-perspective analysis
- **GitHub Integration**: Deep integration with GitHub repositories via the `githubRepo` tool
- **Web Research**: Agents can fetch external documentation and best practices via the `fetch` and `search` tools

## Installation

### Prerequisites

- **For VS Code**: VS Code (version 1.85.0 or higher) with GitHub Copilot extension
- **For JetBrains IDEs**: IntelliJ IDEA, PyCharm, WebStorm, etc. with GitHub Copilot plugin
- GitHub Copilot subscription (Individual, Business, or Enterprise)

### Method 1: Install VSIX Extension (VS Code Only - Recommended for VS Code users)

**✨ This method installs all agents and prompts globally, making them available in ALL VS Code workspaces automatically!**

After installation, all 17 agents and 6 workflow prompts will be instantly available in GitHub Copilot Chat across every project you open in VS Code—no per-project setup required.

#### Option A: Install from VSIX file

1. **Download the latest `.vsix` file** from releases or build it yourself:
   ```bash
   cd copilot-compounding-engineering
   npm install
   npm install -g @vscode/vsce
   ./build.sh
   ```

2. **Install the extension**:

   Via command line:
   ```bash
   code --install-extension compounding-engineering-2.0.0.vsix
   ```

   Or via VS Code:
   - Open VS Code
   - Go to Extensions (Cmd/Ctrl+Shift+X)
   - Click the '...' menu → "Install from VSIX..."
   - Select the downloaded `.vsix` file

3. **Reload VS Code** when prompted

4. **Verify installation**: Open GitHub Copilot Chat and type `@` - you should see all 17 agents listed!

#### Option B: Install from VS Code Marketplace

Coming soon - this extension will be available on the VS Code Marketplace after publishing.

```text
Search for "Compounding Engineering" in the Extensions marketplace
```

### Method 2: Manual Installation (Works in VS Code, IntelliJ, and All JetBrains IDEs)

This method works for **all supported IDEs** and is the only way to install for IntelliJ/JetBrains IDEs.

#### For Individual Projects:

1. **Copy the `.github` directory to your project**:
   ```bash
   cp -r copilot-compounding-engineering/.github /path/to/your/project/
   ```

2. **Restart your IDE** to load the agents

#### For Organization-Wide Installation:

Create a `.github` repository in your organization and add the agents there:

1. **Create/navigate to your `{org}/.github` repository**
2. **Copy the agents and prompts**:
   ```bash
   cp -r copilot-compounding-engineering/.github/agents {org}/.github/agents
   cp -r copilot-compounding-engineering/.github/prompts {org}/.github/prompts
   ```

3. All repositories in your organization will have access to these agents

**Comparison of Installation Methods**:

| Method | Scope | Setup Effort | Best For |
|--------|-------|--------------|----------|
| **VSIX Extension** | Global (all VS Code workspaces) | One-time install | Individual VS Code users |
| **Manual Installation** | Per-project | Copy to each project | IntelliJ/JetBrains IDEs, or workspace-specific customization |
| **Organization Repository** | All org projects | One-time org setup | Teams and organizations |

**Note**: The VSIX extension uses VS Code's Chat Participant API to register all agents globally. Once installed, they work exactly like built-in chat participants (e.g., `@workspace`, `@terminal`) and are available in every workspace automatically.

## Usage

### Using Agents

Agents are invoked in GitHub Copilot Chat using the `@` mention syntax:

```
@architecture-strategist Review this authentication refactoring
```

#### Available Agents

| Agent | Purpose | Tools |
|-------|---------|-------|
| `@architecture-strategist` | Analyze architectural decisions and system design | search, githubRepo |
| `@best-practices-researcher` | Research industry best practices and standards | search, fetch |
| `@code-simplicity-reviewer` | Identify opportunities for simplification | search, githubRepo |
| `@data-integrity-guardian` | Review database migrations and data integrity | search, githubRepo |
| `@dhh-rails-reviewer` | Rails code review from DHH's perspective | search, githubRepo |
| `@every-style-editor` | Apply Every's editorial style guide | search |
| `@feedback-codifier` | Codify review feedback into standards | search, githubRepo |
| `@framework-docs-researcher` | Research framework documentation | search, fetch |
| `@git-history-analyzer` | Analyze git history and evolution | search, githubRepo |
| `@compounding-python-reviewer` | Python code review with high standards | search, githubRepo |
| `@compounding-rails-reviewer` | Rails code review with high standards | search, githubRepo |
| `@compounding-typescript-reviewer` | TypeScript code review with high standards | search, githubRepo |
| `@pattern-recognition-specialist` | Identify patterns and anti-patterns | search, githubRepo |
| `@performance-oracle` | Analyze performance and scalability | search, githubRepo |
| `@pr-comment-resolver` | Address PR comments systematically | search, githubRepo |
| `@repo-research-analyst` | Analyze repository structure and conventions | search, githubRepo, fetch |
| `@security-sentinel` | Perform security audits and vulnerability scanning | search, githubRepo |

### Using Prompts

Prompts are invoked using the `/` slash command syntax:

```
/review-code #123
```

#### Available Prompts

| Prompt | Purpose | Description |
|--------|---------|-------------|
| `/generate-command` | Create new workflow commands | Generate custom command templates |
| `/plan-issue` | Plan feature implementation | Research and create detailed implementation plans |
| `/resolve-todo-parallel` | Resolve multiple TODOs | Work through TODO lists systematically |
| `/review-code` | Comprehensive code review | Multi-agent code review with security, performance, and architecture analysis |
| `/triage-issues` | Triage and prioritize issues | Analyze and categorize GitHub issues |
| `/work-on-task` | Execute complex tasks | Systematic task execution with planning and validation |

## Agent Workflows

### Example: Comprehensive Code Review

```
/review-code #123
```

This will:
1. Check out the PR in a worktree
2. Invoke `@architecture-strategist` for architectural review
3. Invoke `@security-sentinel` for security audit
4. Invoke `@performance-oracle` for performance analysis
5. Invoke `@code-simplicity-reviewer` for simplification opportunities
6. Synthesize findings into a comprehensive review

### Example: Feature Planning

```
/plan-issue Add user authentication with OAuth
```

This will:
1. Invoke `@repo-research-analyst` to understand current patterns
2. Invoke `@best-practices-researcher` to gather industry standards
3. Invoke `@framework-docs-researcher` to check framework capabilities
4. Create a detailed, actionable implementation plan

## Customization

### Adding Custom Agents

Create a new file in `.github/agents/` with the `.agent.md` extension:

```markdown
---
name: My Custom Agent
description: Brief description of what this agent does
tools: ['search', 'githubRepo']
model: Claude Sonnet 4
---

## Agent Instructions

Your detailed agent instructions here...
```

### Adding Custom Prompts

Create a new file in `.github/prompts/` with the `.prompt.md` extension:

```markdown
---
name: My Custom Prompt
description: What this prompt does
tools: ['search']
model: Claude Sonnet 4
handoffs:
  - label: Consult Expert Agent
    agent: architecture-strategist
    prompt: Review this from an architectural perspective
    send: false
---

## Prompt Instructions

Your detailed prompt instructions here...
```

### Configuring Agent Handoffs

Agents can hand off work to other agents for specialized analysis. In your prompt frontmatter:

```yaml
handoffs:
  - label: Check Security
    agent: security-sentinel
    prompt: Review for security vulnerabilities
    send: false
```

## Best Practices

### When to Use Agents

- **Architecture decisions**: Use `@architecture-strategist`
- **Security concerns**: Use `@security-sentinel`
- **Performance issues**: Use `@performance-oracle`
- **Code complexity**: Use `@code-simplicity-reviewer`
- **Research needed**: Use `@best-practices-researcher` or `@framework-docs-researcher`
- **Language-specific reviews**: Use language reviewers (`@compounding-python-reviewer`, etc.)

### When to Use Prompts

- **Complete workflows**: Use prompts for multi-step processes
- **Standardized processes**: Use prompts for repeatable workflows
- **Complex tasks**: Use prompts that orchestrate multiple agents

### Combining Agents and Prompts

Start with a prompt for the workflow, which will automatically invoke the appropriate agents:

```
/review-code #123  # Uses multiple agents automatically
```

Or invoke agents directly for focused analysis:

```
@performance-oracle Analyze the query performance in UserService
```

## Architecture

### How It Works (VS Code Extension)

The Compounding Engineering extension uses **VS Code's Chat Participant API** to provide global agent availability:

1. **Extension Activation**: When VS Code starts, the extension automatically activates
2. **Agent Loading**: All 17 `.agent.md` and 6 `.prompt.md` files are parsed from the bundled `.github` directory
3. **Chat Participant Registration**: Each agent/prompt is registered as a chat participant using `vscode.chat.createChatParticipant()`
4. **Global Availability**: Registered participants are available in ALL workspaces, just like `@workspace` or `@terminal`
5. **Language Model Integration**: Uses VS Code's Language Model API to interact with GitHub Copilot's models
6. **Streaming Responses**: Responses stream in real-time for better user experience

**Key Technologies**:
- **Chat Participant API**: Native VS Code API for registering chat agents
- **Language Model API**: VS Code's interface to GitHub Copilot and other AI models
- **YAML Frontmatter Parsing**: Extracts agent metadata and configuration
- **Markdown Content**: Agent instructions embedded directly in response prompts

### Agent System

Each agent is a specialized expert with:
- **Domain expertise**: Focused on specific aspect (security, performance, etc.)
- **Tool access**: Can search code, fetch docs, access GitHub (via language model capabilities)
- **Context awareness**: Receives workspace and editor context automatically
- **Handoff capability**: Can delegate to other agents for comprehensive analysis
- **Persistent availability**: Always available once extension is installed

### Prompt System

Prompts orchestrate workflows by:
- **Planning**: Breaking down complex tasks into phases
- **Delegation**: Automatically invoking appropriate agents via handoffs
- **Synthesis**: Combining insights from multiple specialized agents
- **Validation**: Ensuring quality standards across all analysis
- **Command support**: Can include sub-commands for different workflow variations

## Troubleshooting

### Agents Not Appearing in VS Code (VSIX Extension)

1. **Verify extension is installed**: Go to Extensions (Cmd/Ctrl+Shift+X) and search for "Compounding Engineering"
2. **Check activation**: Look for the activation message in Output panel (View → Output → select "Compounding Engineering")
3. **Reload VS Code**: Run "Developer: Reload Window" from Command Palette (Cmd/Ctrl+Shift+P)
4. **Check GitHub Copilot**: Ensure GitHub Copilot extension is installed and active
5. **View extension logs**: Check the Output panel for any error messages during activation

### Agents Not Appearing (Manual Installation)

1. Ensure files are in the correct location (`.github/agents/*.agent.md`)
2. Restart your IDE (VS Code or IntelliJ)
3. Check file permissions
4. Verify YAML frontmatter syntax
5. For VS Code: Check that `chat.promptFiles` setting is enabled

### Language Model Errors

1. **"No language model available"**: Ensure you have an active GitHub Copilot subscription
2. **"Rate limit reached"**: Wait a few moments and try again
3. **"Model unavailable"**: Check your Copilot subscription status and network connection

### Agent Responses Not Helpful

1. Provide more context in your query
2. Use more specific prompts
3. Try combining multiple agents using handoffs
4. Include relevant code selections before invoking agents
5. Check that the agent has appropriate tool access

### Extension Not Loading (VS Code)

1. Check VS Code version: Requires VS Code 1.85.0 or higher
2. View Developer Tools: Help → Toggle Developer Tools → Console tab for errors
3. Reinstall the extension
4. Check for conflicting extensions

### Tested Environments

- ✅ VS Code 1.105.1 (Latest tested version)
- ✅ VS Code 1.85.0 (Minimum version)
- ✅ GitHub Copilot extension active
- ✅ GitHub Copilot subscription required

## Examples

### Example 1: Reviewing a Pull Request

```
/review-code #456
```

Output will include:
- Architectural compliance check
- Security vulnerability scan
- Performance analysis
- Code simplification suggestions
- Detailed recommendations

### Example 2: Planning a New Feature

```
/plan-issue Implement real-time notifications with WebSockets
```

Output will include:
- Research on existing patterns in the repo
- Best practices for WebSocket implementation
- Framework-specific documentation
- Phased implementation plan
- Testing requirements

### Example 3: Security Audit

```
@security-sentinel Review the authentication endpoints in api/auth.ts
```

Output will include:
- Input validation analysis
- SQL injection risk assessment
- XSS vulnerability detection
- Authentication/authorization review
- Sensitive data exposure check

### Example 4: Performance Optimization

```
@performance-oracle Analyze the performance of the user search feature
```

Output will include:
- Algorithmic complexity analysis
- Database query optimization
- Memory usage patterns
- Caching opportunities
- Scalability assessment

## Contributing

To add new agents or improve existing ones:

1. Create/modify files in `.github/agents/` or `.github/prompts/`
2. Test thoroughly with various scenarios
3. Document the agent's purpose and capabilities
4. Update this README with usage examples

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a detailed list of changes in each version.

## License

This collection is provided as-is for use with GitHub Copilot. Licensed under MIT License.

## Support

For issues or questions:
- Check the troubleshooting section above
- Review the agent/prompt documentation
- Consult GitHub Copilot documentation

## Credits

Adapted from the Claude Code compounding-engineering system for use with GitHub Copilot in VS Code.

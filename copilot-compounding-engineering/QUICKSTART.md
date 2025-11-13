# Quick Start Guide

Get up and running with Compounding Engineering for GitHub Copilot in 5 minutes.

Works in VS Code, IntelliJ IDEA, PyCharm, WebStorm, and other JetBrains IDEs!

## Prerequisites

- [ ] **IDE**: VS Code or IntelliJ IDEA/JetBrains IDE installed
- [ ] **GitHub Copilot**: Extension/plugin enabled
- [ ] **Subscription**: Active GitHub Copilot subscription
- [ ] **Git repository**: For GitHub-related features (optional)

## Installation

### Option 1: Install VSIX Extension (Recommended - Global)

This installs the agents and prompts for ALL your VS Code projects automatically.

1. **Build the VSIX** (or download from releases):
   ```bash
   cd copilot-compounding-engineering
   npm install -g @vscode/vsce
   ./build.sh
   ```

2. **Install the extension**:
   ```bash
   code --install-extension copilot-compounding-engineering-1.0.0.vsix
   ```

   Or via VS Code UI:
   - Open VS Code
   - Extensions (Cmd/Ctrl+Shift+X)
   - Click '...' → Install from VSIX
   - Select the `.vsix` file

3. **Reload VS Code**

### Option 2: Project-Specific Installation

Install agents for a single project only:

```bash
# From your project root
cp -r /path/to/copilot-compounding-engineering/.github .
```

## Verification

After installation, restart your IDE and verify:

**VS Code:**
1. Open GitHub Copilot Chat (Cmd/Ctrl + I)
2. Type `@` and you should see the new agents in the autocomplete
3. Type `/` and you should see the new prompts

**IntelliJ/JetBrains:**
1. Open GitHub Copilot Chat (usually via toolbar icon or Alt+C)
2. Type `@` and you should see the new agents
3. Type `/` for slash commands

## First Steps

### Try Your First Agent

Open Copilot Chat and ask:

```
@architecture-strategist What architectural patterns are used in this codebase?
```

### Try Your First Prompt

For a comprehensive code review:

```
/review-code main
```

For planning a new feature:

```
/plan-issue Add user profile editing
```

## Common Use Cases

### 1. Code Review

**Quick review of current changes:**
```
@code-simplicity-reviewer Review my changes
```

**Comprehensive PR review:**
```
/review-code #123
```

**Security-focused review:**
```
@security-sentinel Check this authentication code
```

### 2. Architecture & Design

**Evaluate architectural decisions:**
```
@architecture-strategist Is this service boundary appropriate?
```

**Identify patterns:**
```
@pattern-recognition-specialist What design patterns are used here?
```

### 3. Performance Optimization

**Analyze performance:**
```
@performance-oracle Will this scale to 1M users?
```

**Database optimization:**
```
@performance-oracle Review these database queries for N+1 issues
```

### 4. Research & Learning

**Find best practices:**
```
@best-practices-researcher What are the best practices for error handling in FastAPI?
```

**Framework documentation:**
```
@framework-docs-researcher How do I implement rate limiting in Express?
```

### 5. Language-Specific Reviews

**Python:**
```
@compounding-python-reviewer Review this FastAPI endpoint
```

**TypeScript:**
```
@compounding-typescript-reviewer Check this React component
```

**Rails:**
```
@compounding-rails-reviewer Review this Active Record model
```

## Understanding Agent Responses

Agents provide structured feedback:

1. **Context**: Understanding of what you asked
2. **Analysis**: Detailed examination
3. **Findings**: Issues or observations
4. **Recommendations**: Specific, actionable suggestions
5. **Examples**: Code examples when relevant

## Combining Agents

You can invoke multiple agents for comprehensive analysis:

```
@security-sentinel Review the auth endpoints in api/auth.ts

# Then follow up with:
@performance-oracle Check performance of the same endpoints
```

Or use prompts that automatically coordinate multiple agents:

```
/review-code #123  # Invokes security, performance, architecture, and simplicity agents
```

## Customizing Agent Behavior

### Provide Context

Help agents give better responses by providing context:

```
@architecture-strategist We're building a microservices architecture with event-driven communication. Review this new service.
```

### Be Specific

Instead of:
```
@security-sentinel Review my code
```

Try:
```
@security-sentinel Review the user input validation in UserController.create() for SQL injection risks
```

### Use Follow-ups

Agents remember context within a conversation:

```
You: @performance-oracle Analyze this query
Agent: [Provides analysis]
You: What if we add an index on user_id?
Agent: [Analyzes with index]
```

## Tips for Success

1. **Start with prompts** for complete workflows (`/review-code`, `/plan-issue`)
2. **Use agents directly** for focused questions
3. **Provide context** - the more specific, the better
4. **Iterate** - follow up with clarifying questions
5. **Combine agents** - get multiple perspectives on complex issues
6. **Read examples** in each agent's documentation

## Next Steps

- [ ] Explore all 17 agents - see what each specializes in
- [ ] Try each of the 6 workflow prompts
- [ ] Create custom agents for your team's needs
- [ ] Set up agent handoffs for your workflows
- [ ] Share successful patterns with your team

## Getting Help

### Agent Not Working?

1. Check the agent name (use `@` autocomplete)
2. Restart VS Code
3. Verify installation location
4. Check Copilot subscription status

### Unexpected Response?

1. Provide more context
2. Be more specific in your query
3. Try a different agent
4. Check the agent's documentation

### Want to Learn More?

- Read the full [README.md](README.md)
- Check individual agent files in `.github/agents/`
- Explore prompt files in `.github/prompts/`
- Review GitHub Copilot documentation

## Examples by Role

### For Backend Developers

```
@performance-oracle Review the database queries in this service
@security-sentinel Check the API endpoints for vulnerabilities
@data-integrity-guardian Review this migration file
```

### For Frontend Developers

```
@compounding-typescript-reviewer Review this React component
@performance-oracle Check if this component will perform well with 1000 items
@pattern-recognition-specialist What patterns are used in our components?
```

### For DevOps/SRE

```
@security-sentinel Review the deployment configuration
@performance-oracle Analyze the scalability of this service
@repo-research-analyst What infrastructure patterns are used?
```

### For Tech Leads

```
/review-code #123  # Comprehensive PR review
@architecture-strategist Evaluate this architectural proposal
@pattern-recognition-specialist Check for consistency with our patterns
```

## Quick Reference

| Task | Command |
|------|---------|
| Review PR | `/review-code #123` |
| Plan feature | `/plan-issue <description>` |
| Security check | `@security-sentinel <context>` |
| Performance check | `@performance-oracle <context>` |
| Architecture review | `@architecture-strategist <context>` |
| Research best practices | `@best-practices-researcher <question>` |
| Python review | `@compounding-python-reviewer <context>` |
| TypeScript review | `@compounding-typescript-reviewer <context>` |
| Rails review | `@compounding-rails-reviewer <context>` |

---

Now you're ready to compound your engineering productivity with specialized AI agents!

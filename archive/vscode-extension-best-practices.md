# VS Code Extension Best Practices for Chat Participants & Language Model API

## Official Documentation Sources

- **Chat Participant API**: https://code.visualstudio.com/api/extension-guides/ai/chat
- **Language Model API**: https://code.visualstudio.com/api/extension-guides/ai/language-model
- **Language Model Tool API**: https://code.visualstudio.com/api/extension-guides/ai/tools
- **Tutorial**: https://code.visualstudio.com/api/extension-guides/ai/chat-tutorial
- **Official Sample Repository**: https://github.com/microsoft/vscode-extension-samples/tree/main/chat-sample
- **Chat Extension Utils Library**: https://github.com/microsoft/vscode-chat-extension-utils
- **Prompt TSX Library**: https://github.com/microsoft/vscode-prompt-tsx

---

## 1. Chat Participant API Best Practices

### 1.1 Chat Participant Registration

**Pattern**:
```typescript
import * as vscode from 'vscode';

const CAT_PARTICIPANT_ID = 'chat-sample.cat';

export function activate(context: vscode.ExtensionContext) {
  const cat = vscode.chat.createChatParticipant(CAT_PARTICIPANT_ID, handler);
  cat.iconPath = vscode.Uri.joinPath(context.extensionUri, 'cat.jpeg');
  context.subscriptions.push(cat);
}
```

**Best Practices**:
- Use descriptive participant IDs matching your package.json configuration
- Always provide an iconPath for visual identification
- Add the participant to context.subscriptions for proper cleanup
- ID must match the one declared in package.json contributions

### 1.2 Request Handler Implementation

**Signature**:
```typescript
const handler: vscode.ChatRequestHandler = async (
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<ChatResult> => {
  // Implementation
};
```

**Key Components**:
- **request**: Contains user prompt, command, location, model, and references
- **context**: Provides access to message history via `context.history`
- **stream**: Enables streaming responses back to users
- **token**: Allows cancellation of long-running operations

**Best Practices**:
- Always return a ChatResult object containing error details and metadata
- Use `request.model` to access the currently selected language model
- Handle `request.command` to route different slash commands
- Check `request.location` to customize behavior based on chat context (Chat view, Quick Chat, inline)
- Access references through `request.references` (some like #codebase are in toolReferences)

---

## 2. Language Model API Best Practices

### 2.1 Model Selection

**Supported Models** (as of 2024-2025):
- gpt-4o (recommended for general performance)
- gpt-4o-mini (recommended for editor interactions)
- o1, o1-mini
- claude-3.5-sonnet

**Selection Pattern**:
```typescript
// Use request.model directly in chat participants
const chatResponse = await request.model.sendRequest(messages, {}, token);

// Or select specific model (must be called during user-initiated action)
const [model] = await vscode.lm.selectChatModels({
  vendor: 'copilot',
  family: 'gpt-4o'
});

// Always handle empty array case
if (!model) {
  stream.markdown('No language model available');
  return { metadata: { command: '' } };
}
```

**Best Practices**:
- ALWAYS call `selectChatModels` as part of user-initiated actions (commands) due to consent requirements
- Handle empty array returns gracefully (no models match criteria)
- Take a "defensive" approach - don't expect specific models to stay supported forever
- Prefer `request.model` in chat participants over manual selection
- Use gpt-4o for complex tasks, gpt-4o-mini for quick interactions
- Check `model.maxInputTokens` for context window limits (gpt-4o has 64K tokens)

### 2.2 Message Construction

**Pattern**:
```typescript
const messages = [
  vscode.LanguageModelChatMessage.User('System instructions here'),
  vscode.LanguageModelChatMessage.User(request.prompt)
];
```

**Message Types**:
- **User**: Represents the human interacting with the model (also used for system prompts)
- **Assistant**: Represents previous language model responses for conversation history

**Best Practices**:
- System messages are NOT supported - use User role for system instructions
- Place system instructions as the first User message
- Include conversation history using Assistant messages
- Add current user query as the final User message
- Keep messages in chronological order

### 2.3 Streaming Responses

**Pattern**:
```typescript
try {
  const chatResponse = await request.model.sendRequest(messages, {}, token);

  for await (const fragment of chatResponse.text) {
    stream.markdown(fragment);
  }
} catch (err) {
  if (err instanceof vscode.LanguageModelError) {
    console.log(err.message, err.code, err.cause);

    if (err.code === vscode.LanguageModelError.NoPermissions) {
      stream.markdown('User denied access to language model');
    } else if (err.code === vscode.LanguageModelError.Blocked) {
      stream.markdown('Request blocked by content filter');
    }
  }
  throw err;
}
```

**Best Practices**:
- Always use async iteration over `chatResponse.text`
- Stream fragments immediately for responsive UX
- Catch and handle `LanguageModelError` specifically
- Distinguish error types: NoPermissions, Blocked, quota exceeded, network issues
- Pass cancellation token to enable graceful abortion

### 2.4 Error Handling & Retry Strategies

**Error Types**:
- Model doesn't exist
- User didn't give consent (NoPermissions)
- Quota limits exceeded
- Network interruptions
- Content policy violations (Blocked)

**Best Practices**:
- Use `LanguageModelError` to distinguish failure types
- For tools: throw errors with messages that make sense to the LLM
- Provide remediation guidance in error messages (suggest different parameters, alternative actions)
- Implement exponential backoff for retries on transient failures
- Limit retry attempts to avoid long delays
- Don't retry on NoPermissions or Blocked errors
- Log errors for debugging but show user-friendly messages

**Retry Example**:
```typescript
async function sendWithRetry(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  token: vscode.CancellationToken,
  maxRetries = 3
) {
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await model.sendRequest(messages, {}, token);
    } catch (err) {
      if (err instanceof vscode.LanguageModelError) {
        // Don't retry on these
        if (err.code === vscode.LanguageModelError.NoPermissions ||
            err.code === vscode.LanguageModelError.Blocked) {
          throw err;
        }
      }

      lastError = err;
      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
    }
  }

  throw lastError;
}
```

### 2.5 Rate Limiting & Quota Management

**Best Practices**:
- Extensions should responsibly use the language model
- VS Code shows users how many requests each extension sends
- Don't use Language Model API in integration tests (rate-limited)
- Handle quota exceeded errors gracefully
- Inform users about quota usage when appropriate
- Batch operations when possible to minimize requests
- Cache responses for repeated queries

---

## 3. Conversation History & Context Management

### 3.1 Accessing Chat History

**Pattern**:
```typescript
const handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
  const messages = [vscode.LanguageModelChatMessage.User(BASE_PROMPT)];

  // Get previous participant messages
  const previousMessages = context.history.filter(
    h => h instanceof vscode.ChatResponseTurn
  );

  // Add previous messages to context
  previousMessages.forEach(m => {
    let fullMessage = '';
    m.response.forEach(r => {
      const mdPart = r as vscode.ChatResponseMarkdownPart;
      fullMessage += mdPart.value.value;
    });
    messages.push(vscode.LanguageModelChatMessage.Assistant(fullMessage));
  });

  // Add current user message
  messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

  const chatResponse = await request.model.sendRequest(messages, {}, token);
};
```

**Best Practices**:
- Access history through `context.history`
- Filter to only messages where participant was mentioned
- Convert `ChatResponseTurn` to Assistant messages
- Convert `ChatRequestTurn` to User messages
- Maintain chronological order
- Be selective - don't include all history (token limits)
- Use priority-based pruning for large histories

### 3.2 Context Management with vscode-chat-extension-utils

**History Component Usage**:
```typescript
import { History } from '@vscode/chat-extension-utils';

// In your prompt:
<History priority={0}>
  {olderMessages}
</History>
<History priority={80}>
  {recentMessages}
</History>
```

**Best Practices**:
- Assign older messages lowest priority (0)
- Give recent messages higher priority (80)
- Use priority system to ensure important context survives token budget cuts
- Combine with flex properties for responsive sizing

---

## 4. Streaming Responses & Progress Indicators

### 4.1 ChatResponseStream Methods

**Available Methods**:
```typescript
// Markdown content
stream.markdown('Response text here');

// Progress indicators
stream.progress('Analyzing code...');

// Buttons (invoke commands)
stream.button({
  command: 'myExtension.doSomething',
  title: 'Click me',
  arguments: [arg1, arg2]
});

// References (files, URLs, symbols)
stream.reference(vscode.Uri.file('/path/to/file'));
stream.reference(uri, { title: 'Custom Title' });

// Anchors (inline symbol references)
stream.anchor(location, 'symbol name');

// File trees
stream.filetree([
  { name: 'src', children: [...] },
  { name: 'package.json' }
], vscode.Uri.file('/base/path'));
```

**Best Practices**:
- Stream content incrementally for responsive UX
- Use `stream.progress()` for long-running operations
- Provide specific progress messages ("Analyzing files..." not "Working...")
- Use buttons for actionable next steps
- Add references to source materials
- File trees are great for workspace previews
- Combine multiple response types for rich experiences

### 4.2 Progress Reporting Pattern

**Pattern**:
```typescript
const handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
  stream.progress('Analyzing request...');

  const analysis = await analyzeRequest(request.prompt);

  stream.progress('Generating response...');

  const chatResponse = await request.model.sendRequest(messages, {}, token);

  for await (const fragment of chatResponse.text) {
    stream.markdown(fragment);
  }
};
```

**Best Practices**:
- Update progress for each major step
- Keep progress messages concise and actionable
- Clear progress messages after completion (automatic with next stream call)
- Use for operations taking > 1 second
- Provide context about what's happening

---

## 5. Tool Registration & Usage

### 5.1 Tool Registration (package.json)

**Configuration**:
```json
{
  "contributes": {
    "languageModelTools": [
      {
        "name": "myExtension_findFiles",
        "displayName": "Find Files",
        "description": "Searches the workspace for files matching a glob pattern",
        "inputSchema": {
          "type": "object",
          "properties": {
            "pattern": {
              "type": "string",
              "description": "Glob pattern to search for"
            }
          },
          "required": ["pattern"]
        }
      }
    ]
  }
}
```

**Best Practices**:
- Use namespaced tool names (e.g., `myExtension_toolName`)
- Provide clear, descriptive displayName and description
- Define comprehensive JSON Schema for input parameters
- Mark required parameters explicitly
- Include description for each parameter to guide LLM

### 5.2 Tool Implementation

**Pattern**:
```typescript
class FindFilesTool implements vscode.LanguageModelTool<{ pattern: string }> {
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<{ pattern: string }>,
    token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: `Searching for files matching: ${options.input.pattern}`
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ pattern: string }>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const files = await vscode.workspace.findFiles(options.input.pattern);

    return {
      content: [
        new vscode.LanguageModelTextPart(
          files.map(f => f.fsPath).join('\n')
        )
      ]
    };
  }
}

// Register tool
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.lm.registerTool('myExtension_findFiles', new FindFilesTool())
  );
}
```

**Best Practices**:
- Implement both `prepareInvocation` and `invoke` methods
- `prepareInvocation` generates user confirmation messages
- `invoke` executes the actual tool logic
- Validate input parameters against your schema
- Return `LanguageModelToolResult` with content parts
- Throw errors with LLM-friendly messages
- Include remediation guidance in error messages
- Register tools in activate() function
- Add to context.subscriptions for cleanup

### 5.3 Tool Calling in Chat Participants

**Manual Implementation**:
```typescript
const handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
  const tools = vscode.lm.tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema
  }));

  // Send request with tool definitions
  const chatResponse = await request.model.sendRequest(messages, { tools }, token);

  // Handle tool calls from LLM response
  // This is complex - consider using chat-extension-utils library instead
};
```

**Using @vscode/chat-extension-utils**:
```typescript
import { sendChatParticipantRequest } from '@vscode/chat-extension-utils';

const handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
  return await sendChatParticipantRequest(
    request,
    context,
    {
      prompt: 'You are a helpful assistant',
      responseStreamOptions: { stream }
    },
    token
  );
};
```

**Best Practices**:
- Use `@vscode/chat-extension-utils` for simplified tool calling
- Library handles the LLM tool calling loop automatically
- Manual implementation gives more control but is complex
- Access available tools via `vscode.lm.tools`
- Let LLM decide when to invoke tools
- Handle tool results in follow-up LLM requests

---

## 6. Extension Activation Patterns

### 6.1 Activation Events

**Common Events**:
```json
{
  "activationEvents": [
    "onChatParticipant:myParticipant",
    "onLanguageModelTool:myExtension_myTool"
  ]
}
```

**Smart Defaults** (VS Code 1.74.0+):
- Chat participants activate automatically (no explicit event needed)
- Language model tools activate automatically
- Commands, views, languages auto-activate

**Best Practices**:
- Use empty activationEvents array for chat participants (auto-activation)
- Avoid `*` activation event (slows startup significantly)
- Use `onStartupFinished` if you must activate early (doesn't block startup)
- Choose specific events over broad ones
- Minimize activation events for better performance
- Activate only when user needs your extension

### 6.2 Performance Optimization

**Lazy Loading**:
```typescript
export async function activate(context: vscode.ExtensionContext) {
  // Register participant immediately
  const participant = vscode.chat.createChatParticipant('myParticipant', handler);
  context.subscriptions.push(participant);

  // Defer heavy initialization
  let heavyModule: any;

  const handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
    if (!heavyModule) {
      stream.progress('Loading resources...');
      heavyModule = await import('./heavy-module');
    }

    return heavyModule.handleRequest(request, context, stream, token);
  };
}
```

**Best Practices**:
- Minimize work in activate() function
- Use async module loading for heavy dependencies
- Implement progressive loading (basic features first)
- Cache expensive computations
- Use worker threads for CPU-intensive tasks
- Avoid long-running operations on main thread
- Bundle and minify source files
- Use specific imports instead of entire modules

**Monitoring**:
- F1 → "Show running extensions" - see activation times
- F1 → "Developer: Startup Performance" - analyze startup
- Use Process Explorer to check CPU/memory usage

---

## 7. Prompt Engineering with @vscode/prompt-tsx

### 7.1 Core Concepts

**TSX-based Prompt Construction**:
```typescript
import { renderPrompt, UserMessage, AssistantMessage } from '@vscode/prompt-tsx';

const { messages } = await renderPrompt(
  <SystemPrompt />,
  { modelMaxPromptTokens: model.maxInputTokens },
  model
);
```

**Priority System**:
- Higher priority = more important (like z-index)
- Recommended hierarchy:
  1. Base instructions (highest)
  2. Current user query
  3. Recent conversation
  4. Supporting context
  5. Older history (lowest)

### 7.2 Flex Properties

**Token Budget Management**:
```typescript
<UserMessage priority={100} flexGrow={1} flexReserve="/5">
  {baseInstructions}
</UserMessage>

<AssistantMessage priority={80} flexGrow={2}>
  {recentResponse}
</AssistantMessage>

<UserMessage priority={0}>
  {olderContext}
</UserMessage>
```

**Properties**:
- **flexGrow**: Elements with higher values consume unused budget (after pruning)
- **flexReserve**: Reserves fractional portion of total budget (e.g., "/5" = one-fifth)
- **flexBasis**: Sets initial size allocation

**Best Practices**:
- Use priority for importance ranking
- Use flexGrow to fill available space
- Use flexReserve to guarantee minimum space
- Combine properties for sophisticated budget management
- Test with different token limits
- Recent context should have higher priority than old

### 7.3 Common Patterns

**History Management**:
```typescript
import { PrioritizedList, UserMessage, AssistantMessage } from '@vscode/prompt-tsx';

const HistoryMessages = ({ turns, priority }: { turns: Turn[], priority: number }) => (
  <PrioritizedList priority={priority} descending={false}>
    {turns.map(turn =>
      turn.role === 'user'
        ? <UserMessage>{turn.content}</UserMessage>
        : <AssistantMessage>{turn.content}</AssistantMessage>
    )}
  </PrioritizedList>
);

// Usage
<HistoryMessages turns={olderTurns} priority={0} />
<HistoryMessages turns={recentTurns} priority={80} />
```

**File Context**:
```typescript
import { FilesContext } from '@vscode/chat-extension-utils';

<FilesContext files={relevantFiles} priority={50} flexGrow={1} flexReserve="/5" />
```

**Best Practices**:
- Split history into recent/old with different priorities
- Use PrioritizedList for automatic priority assignment
- Combine FilesContext with flex properties for responsive sizing
- Use Tag component to wrap content in XML-like tags
- FileTree component for directory structures
- ToolCall component for tool invocation results

---

## 8. Multi-Model Support & Model Selection

### 8.1 Model Selection Patterns

**Defensive Selection**:
```typescript
async function selectBestModel(preferences: string[]) {
  for (const family of preferences) {
    const models = await vscode.lm.selectChatModels({ family });
    if (models.length > 0) {
      return models[0];
    }
  }

  // Fallback to any available model
  const anyModels = await vscode.lm.selectChatModels({});
  return anyModels[0];
}

// Usage
const model = await selectBestModel(['claude-3.5-sonnet', 'gpt-4o', 'gpt-4o-mini']);
```

**Best Practices**:
- Don't assume specific models will always be available
- Provide fallback options
- Handle case where no models are available
- Respect user's model selection in chat participants (`request.model`)
- Different models for different tasks (complex vs. simple)

### 8.2 Model Capabilities

**Model Characteristics**:
```typescript
interface ModelInfo {
  family: string;
  maxInputTokens: number;
  vendor: string;
  id: string;
}

function logModelInfo(model: vscode.LanguageModelChat) {
  console.log(`Family: ${model.family}`);
  console.log(`Max tokens: ${model.maxInputTokens}`);
  console.log(`Vendor: ${model.vendor}`);
}
```

**Best Practices**:
- Check `maxInputTokens` to adapt prompt length
- Use larger context windows for complex tasks
- Smaller models for quick interactions
- Consider model-specific capabilities
- Test with different models

### 8.3 Bring Your Own Key (BYOK) & Custom Models

**Language Model Picker**:
- Users can select models via chat input field
- Customize shown models via "Chat: Manage Language Models"
- Extensions see user-selected model through `request.model`
- BYOK enables access to models beyond built-in ones

**Best Practices**:
- Respect user's model choice
- Don't override unless necessary
- Test with multiple model families
- Document which models work best
- Handle model-specific quirks gracefully

---

## 9. Cancellation & Long-Running Operations

### 9.1 Cancellation Token Usage

**Pattern**:
```typescript
const handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
  // Set up cancellation handler
  token.onCancellationRequested(() => {
    console.log('Request cancelled');
    // Clean up resources
  });

  // Check if already cancelled
  if (token.isCancellationRequested) {
    return { metadata: { command: '' } };
  }

  // Pass token to all async operations
  const chatResponse = await request.model.sendRequest(messages, {}, token);

  for await (const fragment of chatResponse.text) {
    if (token.isCancellationRequested) {
      break;
    }
    stream.markdown(fragment);
  }
};
```

**Best Practices**:
- Always pass cancellation token to async operations
- Check `token.isCancellationRequested` periodically in loops
- Register cleanup handlers with `token.onCancellationRequested()`
- Clean up resources (file handles, network connections)
- Stop work immediately when cancelled
- Don't stream more content after cancellation

---

## 10. Testing Strategies

### 10.1 Mocking VS Code API

**Using Jest with Manual Mocks**:
```typescript
// __mocks__/vscode.ts
export const chat = {
  createChatParticipant: jest.fn()
};

export const LanguageModelChatMessage = {
  User: jest.fn(content => ({ role: 'user', content })),
  Assistant: jest.fn(content => ({ role: 'assistant', content }))
};
```

**Best Practices**:
- Create `__mocks__` folder for vscode module
- Only mock parts of API you need
- Use type assertions for incomplete mocks
- Design code in modular way for testability
- Separate deterministic logic from LLM interactions

### 10.2 Testing Strategy

**Unit Tests**:
- Test prompt building logic separately
- Test tool implementations independently
- Mock Language Model API (nondeterministic)
- Test error handling paths
- Verify context processing

**Integration Tests**:
- Run in Extension Development Host
- Test participant registration
- Test command routing
- Avoid Language Model API (rate-limited)
- Test tool registration

**Best Practices**:
- Don't use Language Model API in automated tests
- Design modular code for testability
- Test deterministic parts thoroughly
- Use wrapper classes for VS Code API (easier mocking)
- Test error scenarios extensively

---

## 11. Bundling & Production Build

### 11.1 esbuild Configuration (Recommended)

**package.json**:
```json
{
  "scripts": {
    "vscode:prepublish": "npm run esbuild-base -- --minify",
    "esbuild-base": "esbuild ./src/extension.ts --bundle --outfile=dist/extension.js --external:vscode --format=cjs --platform=node",
    "watch": "npm run esbuild-base -- --sourcemap --watch"
  },
  "main": "./dist/extension.js"
}
```

**.vscodeignore**:
```
src/**
tsconfig.json
.gitignore
```

**Best Practices**:
- Use esbuild (10-100x faster than webpack)
- Enable minify for production builds
- Disable sourcemaps in production
- Mark 'vscode' as external
- Point main to bundled output
- Exclude source files from package
- Bundle is required for web extensions

### 11.2 webpack Configuration (Alternative)

**package.json**:
```json
{
  "scripts": {
    "vscode:prepublish": "webpack --mode production",
    "compile": "webpack --mode development",
    "watch": "webpack --mode development --watch"
  }
}
```

**webpack.config.js**:
```javascript
const path = require('path');

module.exports = {
  target: 'node',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: ['ts-loader']
      }
    ]
  }
};
```

**Best Practices**:
- Production mode enables minification
- Use hidden-source-map for debugging
- Bundle improves load time significantly
- Smaller bundle = faster activation

---

## 12. GitHub Copilot Integration Patterns

### 12.1 Agent Mode Integration

**Capabilities**:
- Autonomous planning and execution
- Multi-step workflows
- Terminal command execution
- Specialized tool invocation
- Multi-file edits

**Best Practices**:
- Use agent mode for complex, open-ended tasks
- Use edits mode for well-defined tasks
- Provide custom instructions for coding style
- Use tool sets to group related tools
- Enable MCP server integration for extended capabilities

### 12.2 Custom Instructions

**Pattern**:
- Custom instructions apply to all chat interactions
- Tell AI about coding preferences and standards
- Project-specific conventions
- Testing requirements
- Documentation standards

**Best Practices**:
- Define clear coding standards
- Specify preferred libraries/frameworks
- Document testing expectations
- Include style guide references
- Keep instructions concise but comprehensive

---

## 13. Common Patterns & Examples

### 13.1 Basic Chat Participant

**simple.ts pattern** (from official samples):
```typescript
import * as vscode from 'vscode';

const CAT_PARTICIPANT_ID = 'chat-sample.cat';

export function activate(context: vscode.ExtensionContext) {
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ) => {
    // Handle different commands
    if (request.command === 'teach') {
      stream.progress('Picking topic...');
      const topic = pickRandomTopic();

      const messages = [
        vscode.LanguageModelChatMessage.User(`Explain ${topic} as a cat`),
      ];

      const chatResponse = await request.model.sendRequest(messages, {}, token);

      for await (const fragment of chatResponse.text) {
        stream.markdown(fragment);
      }
    }

    return { metadata: { command: request.command } };
  };

  const cat = vscode.chat.createChatParticipant(CAT_PARTICIPANT_ID, handler);
  cat.iconPath = vscode.Uri.joinPath(context.extensionUri, 'cat.jpeg');

  context.subscriptions.push(cat);
}
```

### 13.2 Using Chat Extension Utils

**chatUtilsSample.ts pattern**:
```typescript
import { sendChatParticipantRequest } from '@vscode/chat-extension-utils';

const handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
  return await sendChatParticipantRequest(
    request,
    context,
    {
      prompt: 'You are a helpful coding assistant',
      responseStreamOptions: { stream },
      extensionMode: vscode.ExtensionMode.Development
    },
    token
  );
};
```

### 13.3 Tool-Calling Participant with prompt-tsx

**toolParticipant.ts pattern**:
```typescript
import { renderPrompt, UserMessage } from '@vscode/prompt-tsx';

const handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
  const { messages } = await renderPrompt(
    <>
      <UserMessage priority={100}>
        You are a helpful assistant. You have access to tools.
      </UserMessage>
      <HistoryMessages turns={context.history} priority={50} />
      <UserMessage priority={90}>
        {request.prompt}
      </UserMessage>
    </>,
    { modelMaxPromptTokens: request.model.maxInputTokens },
    request.model
  );

  // Handle tool calling loop
  // ...
};
```

---

## 14. Security & Privacy Best Practices

### 14.1 Data Handling

**Best Practices**:
- Minimize data sent to language models
- Don't send sensitive information (API keys, passwords, PII)
- Respect workspace privacy settings
- Ask user consent before sending workspace content
- Use .gitignore patterns to filter sensitive files
- Log what data is being sent (transparency)

### 14.2 User Consent

**Best Practices**:
- selectChatModels triggers consent dialog
- Call during user-initiated actions only
- Respect when user denies consent
- Handle NoPermissions error gracefully
- Don't circumvent consent mechanisms
- Be transparent about model usage

---

## 15. Performance Metrics & Monitoring

### 15.1 Key Metrics

**Monitor**:
- Extension activation time
- Request/response latency
- Memory usage
- Token consumption
- Error rates
- Quota usage

**Tools**:
- F1 → "Show Running Extensions"
- F1 → "Developer: Startup Performance"
- Process Explorer
- Extension logs
- VS Code telemetry

### 15.2 Optimization Checklist

- [ ] Bundle extension with esbuild/webpack
- [ ] Use specific activation events
- [ ] Implement lazy loading for heavy modules
- [ ] Cache expensive computations
- [ ] Stream responses incrementally
- [ ] Use priority-based pruning for prompts
- [ ] Minimize data sent to language models
- [ ] Handle errors gracefully with retries
- [ ] Monitor and stay within rate limits
- [ ] Test with multiple models
- [ ] Profile and optimize slow paths

---

## 16. Common Pitfalls & Solutions

### 16.1 Model Selection Issues

**Pitfall**: Assuming specific models always exist
**Solution**: Defensive selection with fallbacks

**Pitfall**: Calling selectChatModels outside user action
**Solution**: Only call during command execution

### 16.2 Context Window Issues

**Pitfall**: Sending too much context, hitting token limits
**Solution**: Use prompt-tsx priority pruning

**Pitfall**: Not checking maxInputTokens
**Solution**: Always verify model capabilities

### 16.3 Error Handling

**Pitfall**: Not distinguishing error types
**Solution**: Use LanguageModelError instanceof checks

**Pitfall**: Retrying on permanent failures
**Solution**: Don't retry NoPermissions/Blocked errors

### 16.4 Performance

**Pitfall**: Activating on startup (*)
**Solution**: Use specific activation events or onStartupFinished

**Pitfall**: Loading heavy dependencies synchronously
**Solution**: Lazy load and use async imports

### 16.5 History Management

**Pitfall**: Including all history, exceeding token limits
**Solution**: Filter recent messages, use priority system

**Pitfall**: Not converting history to proper message types
**Solution**: ChatRequestTurn → User, ChatResponseTurn → Assistant

---

## 17. Example Extension Structure

```
my-chat-extension/
├── src/
│   ├── extension.ts          # Entry point, activate/deactivate
│   ├── chatHandler.ts         # Main chat participant handler
│   ├── tools/
│   │   ├── findFiles.ts       # Tool implementations
│   │   └── runCommand.ts
│   ├── prompts/
│   │   ├── base.tsx           # Base prompt with prompt-tsx
│   │   └── history.tsx        # History management
│   └── utils/
│       ├── modelSelection.ts  # Model selection helpers
│       └── errors.ts          # Error handling utilities
├── dist/                      # Bundled output (gitignored)
├── package.json              # Extension manifest
├── tsconfig.json             # TypeScript config
├── esbuild.js                # Build configuration
└── README.md                 # Extension documentation
```

---

## 18. Additional Resources

### Official Documentation
- VS Code Extension API: https://code.visualstudio.com/api
- Activation Events: https://code.visualstudio.com/api/references/activation-events
- Testing Extensions: https://code.visualstudio.com/api/working-with-extensions/testing-extension
- Bundling Extensions: https://code.visualstudio.com/api/working-with-extensions/bundling-extension
- Publishing Extensions: https://code.visualstudio.com/api/working-with-extensions/publishing-extension

### Libraries
- @vscode/chat-extension-utils: https://github.com/microsoft/vscode-chat-extension-utils
- @vscode/prompt-tsx: https://github.com/microsoft/vscode-prompt-tsx

### Examples
- Official Samples: https://github.com/microsoft/vscode-extension-samples
- Chat Sample: https://github.com/microsoft/vscode-extension-samples/tree/main/chat-sample
- Over 100 extensions built on Language Model API (VS Code Marketplace)

### Community
- VS Code Discussions: https://github.com/microsoft/vscode-discussions
- Stack Overflow: Tag [visual-studio-code]
- VS Code Extension Development Discord

---

## 19. Quick Reference

### Essential Imports
```typescript
import * as vscode from 'vscode';
import { renderPrompt, UserMessage, AssistantMessage } from '@vscode/prompt-tsx';
import { sendChatParticipantRequest } from '@vscode/chat-extension-utils';
```

### Key APIs
- `vscode.chat.createChatParticipant(id, handler)` - Create participant
- `vscode.lm.selectChatModels(criteria)` - Select language model
- `vscode.lm.registerTool(name, tool)` - Register tool
- `vscode.lm.tools` - Access available tools
- `model.sendRequest(messages, options, token)` - Send LLM request

### Message Types
- `vscode.LanguageModelChatMessage.User(content)` - User message
- `vscode.LanguageModelChatMessage.Assistant(content)` - Assistant message

### Stream Methods
- `stream.markdown(text)` - Markdown content
- `stream.progress(message)` - Progress indicator
- `stream.button(command)` - Command button
- `stream.reference(uri)` - File/URL reference
- `stream.anchor(location, title)` - Symbol reference
- `stream.filetree(tree, base)` - File tree

### Error Handling
```typescript
try {
  const response = await model.sendRequest(messages, {}, token);
} catch (err) {
  if (err instanceof vscode.LanguageModelError) {
    console.log(err.code, err.message);
  }
}
```

---

This comprehensive guide covers the latest VS Code extension development practices for Chat Participants and Language Model API as of 2024-2025. All recommendations are based on official Microsoft documentation, official sample repositories, and current industry best practices.

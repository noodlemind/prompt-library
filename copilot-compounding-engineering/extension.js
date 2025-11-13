// This extension provides GitHub Copilot agents and prompts
// The agents and prompts are defined in .github/agents/*.agent.md and .github/prompts/*.prompt.md

const vscode = require('vscode');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('Copilot Compounding Engineering extension is now active!');

    // Display a message when the extension activates
    vscode.window.showInformationMessage(
        'Copilot Compounding Engineering loaded! Use @ for agents and / for prompts in Copilot Chat.'
    );
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};

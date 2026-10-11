import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const path = String.raw`C:\Users\sam_1\AppData\Roaming\Code\User\settings.json`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${path}.omniroute-launcher-backup-${stamp}`;
copyFileSync(path, backup);

const settings = JSON.parse(readFileSync(path, 'utf8'));
settings['claudeCode.useTerminal'] = true;
settings['claudeCode.claudeProcessWrapper'] = String.raw`C:\Users\sam_1\bin\claude.exe`;

const variables = Array.isArray(settings['claudeCode.environmentVariables'])
  ? settings['claudeCode.environmentVariables'].filter(
      (entry) => entry && !['CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL'].includes(entry.name),
    )
  : [];
variables.push(
  {
    name: 'CLAUDE_CONFIG_DIR',
    value: String.raw`C:\Users\sam_1\.claude\profiles\omniroute`,
  },
  {
    name: 'ANTHROPIC_BASE_URL',
    value: 'http://localhost:20128',
  },
);
settings['claudeCode.environmentVariables'] = variables;

const terminalEnvironment =
  settings['terminal.integrated.env.windows'] &&
  typeof settings['terminal.integrated.env.windows'] === 'object' &&
  !Array.isArray(settings['terminal.integrated.env.windows'])
    ? settings['terminal.integrated.env.windows']
    : {};
terminalEnvironment.CLAUDE_CONFIG_DIR = String.raw`C:\Users\sam_1\.claude\profiles\omniroute`;
terminalEnvironment.ANTHROPIC_BASE_URL = 'http://localhost:20128';
settings['terminal.integrated.env.windows'] = terminalEnvironment;

writeFileSync(path, `${JSON.stringify(settings, null, 4)}\n`, 'utf8');
console.log(JSON.stringify({ updated: path, backup }, null, 2));

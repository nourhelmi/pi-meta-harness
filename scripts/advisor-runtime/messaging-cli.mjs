#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { agentMessageTool, callAgentMessage, messageError, parseAgentMessage } from './messaging-client.mjs';
import { createMcpHandler, serveMcp } from './mcp.mjs';
import { demand } from './security.mjs';

export function createAgentMessageFacade(request = callAgentMessage) {
  return {
    tools: [agentMessageTool],
    async call(name, input) {
      let args;
      try {
        demand(name === 'agent_message', 'UNKNOWN_TOOL');
        args = parseAgentMessage(input);
        return { ok: true, value: await request(args) };
      } catch (error) { return messageError(error, args?.messageId ?? error?.messageId); }
    },
  };
}

async function main(argv) {
  demand(argv.length === 1, 'MESSAGE_CLI_USAGE: agent-message <JSON|-> or agent-message mcp');
  const facade = createAgentMessageFacade();
  if (argv[0] === 'mcp') return serveMcp(null, process.stdin, process.stdout, createMcpHandler(null, facade));
  let input;
  try { input = JSON.parse(argv[0] === '-' ? readFileSync(0, 'utf8') : argv[0]); }
  catch { demand(false, 'INVALID_JSON'); }
  const result = await facade.call('agent_message', input);
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(JSON.stringify(messageError(error, error?.messageId)) + '\n');
    process.exitCode = 1;
  });
}

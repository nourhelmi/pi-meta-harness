import { expect, it } from 'vitest';
import { commandSchema, responseSchema } from '../src/runtime-contract.js';

it('preserves large command and response content while retaining envelope validation', () => {
  const text = 'oversized legitimate message🙂'.repeat(60000);
  const command = { v: 1, op: 'root.message', scope: { workstream: 'w', run: 'r', node: 'root', ownerEpoch: 1 }, commandId: 'large', expectedRevision: 0, payload: { text } };
  expect(commandSchema.parse(command)).toEqual(command);
  expect(responseSchema.parse({ ok: true, value: { text } })).toEqual({ ok: true, value: { text } });
  expect(commandSchema.safeParse({ ...command, socketPath: '/foreign' }).success).toBe(false);
  expect(commandSchema.safeParse({ ...command, expectedRevision: -1 }).success).toBe(false);
});

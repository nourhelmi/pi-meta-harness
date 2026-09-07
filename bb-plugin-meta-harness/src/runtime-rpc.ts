import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { commandSchema, responseSchema } from "./runtime-contract.js";
export const runtimeRpcContract = defineRpcContract({ runtime: { input: commandSchema, output: responseSchema } });
export type RuntimeRpcContract = typeof runtimeRpcContract;
export const runtimeHostMethod = { input: z.object({ descriptorPath: z.string().min(1).max(4096), command: commandSchema }).strict(), output: responseSchema };

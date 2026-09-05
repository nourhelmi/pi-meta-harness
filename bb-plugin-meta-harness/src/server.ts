import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  hostIdSettingSchema,
  stateRootSettingSchema,
  traceHostContract,
  traceRpcContract,
  type TraceReadError,
} from "./contracts.js";

const CONFIGURE_MESSAGE =
  "Set hostId and an absolute advisor stateRoot, then reload the plugin.";

const configurationError: TraceReadError = {
  code: "INVALID_CONFIGURATION",
  message: CONFIGURE_MESSAGE,
};

export const traceSettings = {
  hostId: {
    type: "string",
    label: "Advisor host",
    description: "Explicit BB machine id that owns the configured state root.",
    experimental_schema: hostIdSettingSchema,
  },
  stateRoot: {
    type: "string",
    label: "Advisor state root",
    description: "Absolute path containing the canonical traces directory.",
    experimental_schema: stateRootSettingSchema,
  },
} as const;

export default async function metaHarnessPlugin(
  bb: BbPluginApi,
): Promise<void> {
  const settings = bb.settings.define(traceSettings);
  const host = bb.hosts.experimental_client({ contract: traceHostContract });

  async function configuredValues(): Promise<{
    hostId: string;
    stateRoot: string;
  } | null> {
    const values = await settings.get();
    const hostId = hostIdSettingSchema.safeParse(values.hostId);
    const stateRoot = stateRootSettingSchema.safeParse(values.stateRoot);
    if (!hostId.success || !stateRoot.success) return null;
    return { hostId: hostId.data, stateRoot: stateRoot.data };
  }

  if ((await configuredValues()) === null) {
    bb.status.needsConfiguration(CONFIGURE_MESSAGE);
  }

  bb.rpc.register(traceRpcContract, {
    async listTraces() {
      const configuration = await configuredValues();
      if (configuration === null) {
        return { ok: false as const, error: configurationError };
      }
      return host.call(
        "listTraces",
        { stateRoot: configuration.stateRoot },
        { hostId: configuration.hostId },
      );
    },
    async readTrace(input) {
      const configuration = await configuredValues();
      if (configuration === null) {
        return {
          ok: false as const,
          fileName: input.fileName,
          error: configurationError,
        };
      }
      return host.call(
        "readTrace",
        { stateRoot: configuration.stateRoot, fileName: input.fileName },
        { hostId: configuration.hostId },
      );
    },
  });
}

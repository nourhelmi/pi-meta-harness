import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { traceHostContract } from "./contracts.js";
import { traceStore } from "./trace-policy.js";

export default experimental_defineHostEntry({
  contract: traceHostContract,
  handlers: {
    listTraces(input, context) {
      return traceStore.listTraces(input.stateRoot, context.signal);
    },
    readTrace(input, context) {
      return traceStore.readTrace(
        input.stateRoot,
        input.fileName,
        context.signal,
      );
    },
  },
});

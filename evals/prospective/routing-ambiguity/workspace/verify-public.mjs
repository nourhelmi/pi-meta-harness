import { routeProvider } from "./router.mjs";

const selected = routeProvider("account-sync");
if (selected.id !== "current" || selected.deprecated !== false || selected.endpoint !== "/v2/account-sync") {
  process.stderr.write(`account-sync selected ${selected.id}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("provider routing verified\n");
}

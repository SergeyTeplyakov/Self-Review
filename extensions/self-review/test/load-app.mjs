import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createSettingsApi } from "../web/settings-api.mjs";

// Keep the renderer's existing classic-script VM harness, using its real imported API.
export async function loadApp(context) {
    const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
    const declaration = 'import { createSettingsApi } from "./settings-api.mjs";';
    if (!source.includes(declaration)) throw new Error("Update the renderer test harness for its module imports.");
    context.createSettingsApi = createSettingsApi;
    vm.runInContext(source.replace(declaration, ""), context);
}

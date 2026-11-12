import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createSettingsApi } from "./modules.mjs";

export class MockElement {
    readonly tagName: string;
    dataset: Record<string, string> = {};
    name = "";
    value = "";
    checked = false;
    type = "";
    innerHTML = "";
    textContent = "";
    className = "";
    hidden = false;
    inert = false;
    scrollTop = 0;
    classList = { toggle: (_name: string, _force?: boolean) => false };
    closest(_selector: string): MockElement | null {
        return this;
    }

    constructor(tagName = "DIV") {
        this.tagName = tagName;
    }

    focus(): void {}

    static [Symbol.hasInstance](value: unknown): boolean {
        return typeof value === "object" && value !== null &&
            ("tagName" in value || "dataset" in value || "name" in value || "closest" in value);
    }
}

class MockInputElement extends MockElement {
    static [Symbol.hasInstance](value: unknown): boolean {
        return value instanceof MockElement && "checked" in value && "name" in value;
    }
}

class MockTextAreaElement extends MockElement {
    static [Symbol.hasInstance](value: unknown): boolean {
        return value instanceof MockElement && "value" in value && !("checked" in value);
    }
}

class MockSelectElement extends MockElement {
    static [Symbol.hasInstance](value: unknown): boolean {
        return value instanceof MockElement && "value" in value && !("checked" in value);
    }
}

class MockButtonElement extends MockElement {
    static [Symbol.hasInstance](value: unknown): boolean {
        return value instanceof MockElement && value.tagName === "BUTTON";
    }
}

// Keep the renderer's existing classic-script VM harness, using its real imported API.
export async function loadApp(context: vm.Context) {
    const source = await readFile(new URL("../dist/web/app.js", import.meta.url), "utf8");
    const declaration = 'import { createSettingsApi } from "./settings-api.mjs";';
    if (!source.includes(declaration)) throw new Error("Update the renderer test harness for its module imports.");
    Object.assign(context, {
        createSettingsApi,
        Element: MockElement,
        HTMLElement: MockElement,
        HTMLInputElement: MockInputElement,
        HTMLTextAreaElement: MockTextAreaElement,
        HTMLSelectElement: MockSelectElement,
        HTMLButtonElement: MockButtonElement,
    });
    vm.runInContext(source.replace(declaration, ""), context);
}

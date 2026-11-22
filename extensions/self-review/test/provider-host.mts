import { EventEmitter } from "node:events";
import { register, type ResolveHook } from "node:module";
import type { SendOptions } from "../src/lib/delivery.mjs";

interface TestCanvas {
    open(ctx: { instanceId: string; input: Record<string, unknown>; session: { workingDirectory: string } }): Promise<{ url: string }>;
    onClose(ctx: { instanceId: string }): Promise<void>;
    actions: { name: string; inputSchema?: unknown; handler(ctx: { instanceId: string; input: Record<string, unknown> }): unknown }[];
}

export const host = {
    canvases: [] as TestCanvas[],
    logs: [] as { message: string; level?: string }[],
    events: new EventEmitter(),
};

export class CanvasError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}
export const createCanvas = (canvas: TestCanvas) => canvas;
export async function joinSession(config: { canvases: TestCanvas[] }) {
    host.canvases = config.canvases;
    let sequence = 0;
    return {
        sessionId: "test-session",
        log: async (message: string, options?: { level: string }) => { host.logs.push({ message, level: options?.level }); },
        send: async (options: SendOptions) => {
            host.events.emit("send", options);
            return `message-${++sequence}`;
        },
        on: (event: string, handler: () => void) => {
            host.events.on(event, handler);
            return () => host.events.off(event, handler);
        },
    };
}

// This module is both the Node 22.12-compatible loader and the SDK fixture it resolves to.
export const resolve: ResolveHook = (specifier, context, next) => specifier === "@github/copilot-sdk/extension"
    ? { url: import.meta.url, shortCircuit: true }
    : next(specifier, context);

export function registerTestHost() {
    register(import.meta.url);
}

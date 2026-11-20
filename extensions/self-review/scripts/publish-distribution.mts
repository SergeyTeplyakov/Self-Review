import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

export function publishDirectory(staged: string, destination: string) {
    const obsolete: string[] = [];
    function install(source: string, target: string) {
        mkdirSync(target, { recursive: true });
        const previous = new Map(readdirSync(target, { withFileTypes: true }).map((entry) => [entry.name, entry]));
        // Publish the build identity last, while keeping existing directories watched.
        const entries = readdirSync(source, { withFileTypes: true }).sort((a, b) =>
            Number(a.name === "version.json") - Number(b.name === "version.json"));
        for (const entry of entries) {
            const from = path.join(source, entry.name);
            const to = path.join(target, entry.name);
            const old = previous.get(entry.name);
            previous.delete(entry.name);
            if (old && old.isDirectory() !== entry.isDirectory()) {
                // A rename cannot replace a different entry type. Remove only the
                // conflict, then install the complete staged file or subtree.
                rmSync(to, { recursive: old.isDirectory(), force: true });
                renameSync(from, to);
            } else if (entry.isDirectory()) install(from, to);
            else if (!old?.isFile() || !readFileSync(from).equals(readFileSync(to))) renameSync(from, to);
        }
        obsolete.push(...[...previous.keys()].map((name) => path.join(target, name)));
    }
    install(staged, destination);
    for (const entry of obsolete) rmSync(entry, { recursive: true, force: true });
}

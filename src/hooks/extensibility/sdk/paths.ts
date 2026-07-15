import { dirname, join } from "path";
import { omxRoot } from "../../../utils/paths.js";

export function sanitizeHookPluginName(name: string): string {
	const cleaned = (name || "unknown-plugin").replace(/[^a-zA-Z0-9._-]/g, "-");
	return cleaned || "unknown-plugin";
}

function resolvedStateRoot(cwd: string, stateRoot?: string): string {
	return stateRoot ?? join(omxRoot(cwd), "state");
}

export function hookPluginRootDir(
	cwd: string,
	pluginName: string,
	stateRoot?: string,
): string {
	return join(
		resolvedStateRoot(cwd, stateRoot),
		"hooks",
		"plugins",
		sanitizeHookPluginName(pluginName),
	);
}

export function hookPluginTmuxStatePath(
	cwd: string,
	pluginName: string,
	stateRoot?: string,
): string {
	return join(hookPluginRootDir(cwd, pluginName, stateRoot), "tmux.json");
}

export function hookPluginDataPath(
	cwd: string,
	pluginName: string,
	stateRoot?: string,
): string {
	return join(hookPluginRootDir(cwd, pluginName, stateRoot), "data.json");
}

export function hookPluginLogPath(
	cwd: string,
	now = new Date(),
	stateRoot?: string,
): string {
	const day = now.toISOString().slice(0, 10);
	return join(
		dirname(resolvedStateRoot(cwd, stateRoot)),
		"logs",
		`hooks-${day}.jsonl`,
	);
}

export function omxRootStateFilePath(
	cwd: string,
	fileName: string,
	stateRoot?: string,
): string {
	return join(resolvedStateRoot(cwd, stateRoot), fileName);
}

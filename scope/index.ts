/**
 * Scope Mode Extension
 *
 * Collaborative scoping/thinking mode. The user and the model ask questions and
 * deepen their understanding until the user is satisfied. The model keeps a
 * concise per-session brief that re-anchors the discussion if it drifts.
 *
 * While active:
 * - Everything is read-only except `<cwd>/.pi/briefs/<session-id>.md`.
 * - bash is restricted to a read-only allowlist.
 * - A hidden [SCOPE MODE ACTIVE] context is injected before each user turn.
 *
 * Commands:
 * - /scope  Toggle scope mode
 * - /brief  View and edit the current session brief
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Read-only command allowlist (adapted from pi's plan-mode example utils)
// ---------------------------------------------------------------------------

// Destructive commands blocked while scoping
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Safe read-only commands allowed while scoping
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

// ---------------------------------------------------------------------------
// Brief helpers
// ---------------------------------------------------------------------------

const BRIEF_SECTIONS = ["Goal", "Decisions", "Constraints", "Open questions", "Out of scope"];

function seedBrief(): string {
	return `# Scope Brief\n\n${BRIEF_SECTIONS.map((section) => `## ${section}\n`).join("\n")}`;
}

function buildScopeContext(briefPath: string): string {
	return `[SCOPE MODE ACTIVE]
You are in collaborative scoping mode. The user wants to think through the problem with you until they are confident it matches their intent or is scoped well enough.

Behavior:
- Ask clarifying questions. Converse freely for open exploration, and use the ask_user_question tool for concrete decisions or preferences.
- Explore the codebase with read-only tools to ground the discussion in reality.
- Maintain a concise "scope brief" at: ${briefPath}
  Keep it short and current. Update it whenever understanding changes (decisions made, constraints found, questions opened/closed, things ruled out).
  Use exactly these sections: ## Goal, ## Decisions, ## Constraints, ## Open questions, ## Out of scope.
- Only the brief file is writable. Do not modify any other file. Non-read-only bash commands are blocked.
- When you believe the scope is clear, gently ask the user whether anything is missing before stopping. Do not start implementing.`;
}

function scopeBriefPath(ctx: ExtensionContext): string {
	const rawId = ctx.sessionManager.getSessionId() || "session";
	const safeId = rawId.replace(/[^A-Za-z0-9._-]/g, "_");
	return resolve(ctx.cwd, ".pi", "briefs", `${safeId}.md`);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

interface ScopeModeState {
	enabled: boolean;
	briefPath?: string;
}

export default function scopeModeExtension(pi: ExtensionAPI): void {
	let scopeEnabled = false;
	let briefPath: string | undefined;

	function currentBriefPath(ctx: ExtensionContext): string {
		return briefPath ?? scopeBriefPath(ctx);
	}

	function ensureBrief(path: string): void {
		if (existsSync(path)) return;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, seedBrief(), "utf8");
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("scope-mode", scopeEnabled ? ctx.ui.theme.fg("accent", "🔎 scope") : undefined);
	}

	function persistState(): void {
		const state: ScopeModeState = { enabled: scopeEnabled, briefPath };
		pi.appendEntry("scope-mode", state);
	}

	function enterScope(ctx: ExtensionContext): void {
		scopeEnabled = true;
		briefPath = scopeBriefPath(ctx);
		ensureBrief(briefPath);
		updateStatus(ctx);
		persistState();
		ctx.ui.notify(`Scope mode enabled. Brief: ${briefPath}`, "info");
	}

	function exitScope(ctx: ExtensionContext): void {
		scopeEnabled = false;
		updateStatus(ctx);
		persistState();
		ctx.ui.notify("Scope mode disabled.", "info");
	}

	pi.registerCommand("scope", {
		description: "Toggle scoping mode (read-only; only the session brief is writable)",
		handler: async (_args, ctx) => {
			if (scopeEnabled) {
				exitScope(ctx);
			} else {
				enterScope(ctx);
			}
		},
	});

	pi.registerCommand("brief", {
		description: "View and edit the current session scope brief",
		handler: async (_args, ctx) => {
			const path = currentBriefPath(ctx);
			if (!existsSync(path)) {
				ctx.ui.notify("No scope brief yet. Run /scope to start one.", "info");
				return;
			}
			const current = readFileSync(path, "utf8");
			const edited = await ctx.ui.editor("Scope brief", current);
			if (edited === undefined) return;
			writeFileSync(path, edited, "utf8");
			ctx.ui.notify("Scope brief updated.", "info");
		},
	});

	// Read-only enforcement while scope mode is active.
	pi.on("tool_call", async (event, ctx) => {
		if (!scopeEnabled) return;

		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown }).command ?? "");
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Scope mode: command blocked (not on the read-only allowlist). Run /scope to exit first.\nCommand: ${command}`,
				};
			}
			return;
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			const inputPath = String((event.input as { path?: unknown }).path ?? "");
			const target = resolve(ctx.cwd, inputPath);
			const brief = currentBriefPath(ctx);
			if (target !== resolve(brief)) {
				return {
					block: true,
					reason: `Scope mode: only the session brief is writable (${brief}). Run /scope to exit first.\nBlocked: ${inputPath}`,
				};
			}
		}
	});

	// Drop stale scope context once the mode is off.
	pi.on("context", async (event) => {
		if (scopeEnabled) return;
		return {
			messages: event.messages.filter((message) => {
				const msg = message as AgentMessage & { customType?: string };
				if (msg.customType === "scope-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[SCOPE MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[SCOPE MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject scoping instructions before each user-initiated run.
	pi.on("before_agent_start", async (event, ctx) => {
		if (!scopeEnabled || event.messageType !== "user") return;
		return {
			message: {
				customType: "scope-mode-context",
				content: buildScopeContext(currentBriefPath(ctx)),
				display: false,
			},
		};
	});

	// Restore state on start/resume.
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const entry = entries
			.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === "scope-mode")
			.pop() as { data?: ScopeModeState } | undefined;

		if (entry?.data) {
			scopeEnabled = entry.data.enabled ?? false;
			briefPath = entry.data.briefPath ?? scopeBriefPath(ctx);
		}

		if (scopeEnabled) {
			ensureBrief(currentBriefPath(ctx));
		}
		updateStatus(ctx);
	});
}

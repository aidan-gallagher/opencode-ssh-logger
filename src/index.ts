import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
const LOG_DIR = join(xdgData, "opencode", "storage", "plugins", "opencode-ssh-logger")
const GLOBAL_LOG = join(LOG_DIR, "ssh-all.log")
const HOST_LOG_DIR = join(LOG_DIR, "hosts")
const SESSION_LOG_DIR = join(LOG_DIR, "sessions")
const MAX_OUTPUT_LINES = 100

// SSH connection failure patterns — skip logging these
const CONNECTION_FAILURE_PATTERNS = [
  /^ssh: connect to host .+ port \d+: Connection refused/m,
  /^ssh: connect to host .+ port \d+: Connection timed out/m,
  /^ssh: connect to host .+ port \d+: No route to host/m,
  /^ssh: Could not resolve hostname/m,
  /^ssh: connect to host .+ port \d+: Network is unreachable/m,
  /^Permission denied/m,
  /^ssh_exchange_identification:/m,
  /^kex_exchange_identification:/m,
]

// ---------------------------------------------------------------------------
// SSH command parser
// ---------------------------------------------------------------------------

// Flags that consume the next token as their value
const FLAGS_WITH_VALUE = new Set([
  "-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i",
  "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R",
  "-S", "-W", "-w",
])

// Flags that are standalone (no value)
const FLAGS_STANDALONE = new Set([
  "-4", "-6", "-A", "-a", "-C", "-f", "-G", "-g", "-K",
  "-k", "-M", "-N", "-n", "-q", "-s", "-T", "-t", "-V",
  "-v", "-X", "-x", "-Y", "-y",
])

interface ParsedSSH {
  user: string
  host: string
  remoteCmd: string
}

/**
 * Tokenize a shell command string, respecting single and double quotes.
 * Does not handle escape sequences beyond \" and \' inside quotes.
 */
function tokenize(cmd: string): string[] {
  const tokens: string[] = []
  let current = ""
  let inSingle = false
  let inDouble = false
  let escaped = false

  for (const ch of cmd) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === "\\" && !inSingle) {
      escaped = true
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += ch
  }
  if (current.length > 0) {
    tokens.push(current)
  }
  return tokens
}

/**
 * Parse an SSH command string into its components.
 * Returns null if the command is not an SSH invocation, has no remote command
 * (interactive session), or cannot be parsed.
 */
function parseSSH(command: string): ParsedSSH | null {
  const trimmed = command.trim()

  // Must start with "ssh " — reject ssh-keygen, sshfs, sshpass, etc.
  if (!trimmed.startsWith("ssh ") && trimmed !== "ssh") return null

  const tokens = tokenize(trimmed)
  if (tokens[0] !== "ssh") return null

  let i = 1
  while (i < tokens.length) {
    const tok = tokens[i]

    // "--" means end of options — next token is the hostname
    if (tok === "--") {
      i += 1
      break
    }

    // Long flags (rare in OpenSSH but handle gracefully)
    if (tok.startsWith("--")) {
      i += 1
      continue
    }

    // Short flag with value: -F /path, -o Key=Val, -J host, etc.
    if (FLAGS_WITH_VALUE.has(tok)) {
      i += 2 // skip flag and its value
      continue
    }

    // Combined short flag with value: -p22, -oStrictHostKeyChecking=no, -Fpath
    if (
      tok.startsWith("-") &&
      tok.length > 2 &&
      FLAGS_WITH_VALUE.has(tok.slice(0, 2))
    ) {
      i += 1
      continue
    }

    // Standalone flag: -v, -A, -C, etc.
    if (FLAGS_STANDALONE.has(tok)) {
      i += 1
      continue
    }

    // Combined standalone flags: -vvv, -Av, etc.
    if (tok.startsWith("-") && tok.length > 1) {
      // Check if all chars after "-" are standalone flag chars
      const chars = tok.slice(1).split("")
      if (chars.every((c) => FLAGS_STANDALONE.has(`-${c}`))) {
        i += 1
        continue
      }
    }

    // Unknown flag — skip it to be safe
    if (tok.startsWith("-")) {
      i += 1
      continue
    }

    // First non-flag token is the hostname
    break
  }

  // No hostname found
  if (i >= tokens.length) return null

  const hostToken = tokens[i]
  const remoteParts = tokens.slice(i + 1)

  // No remote command = interactive SSH session, skip
  if (remoteParts.length === 0) return null

  const remoteCmd = remoteParts.join(" ")

  // Parse user@host
  let user: string
  let host: string
  if (hostToken.includes("@")) {
    const atIdx = hostToken.indexOf("@")
    user = hostToken.slice(0, atIdx)
    host = hostToken.slice(atIdx + 1)
  } else {
    user = process.env.USER ?? process.env.USERNAME ?? "unknown"
    host = hostToken
  }

  return { user, host, remoteCmd }
}

// ---------------------------------------------------------------------------
// Log writer
// ---------------------------------------------------------------------------

let dirEnsured = false

function ensureLogDir(): void {
  if (dirEnsured) return
  for (const dir of [LOG_DIR, HOST_LOG_DIR, SESSION_LOG_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }
  dirEnsured = true
}

function logFileName(value: string): string {
  return encodeURIComponent(value) || "unknown"
}

function formatTimestamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  )
}

function truncateOutput(output: string): string {
  const lines = output.split("\n")
  if (lines.length <= MAX_OUTPUT_LINES) return output
  const truncated = lines.slice(0, MAX_OUTPUT_LINES).join("\n")
  const remaining = lines.length - MAX_OUTPUT_LINES
  return `${truncated}\n... (${remaining} more lines truncated)`
}

function formatEntry(
  user: string,
  host: string,
  remoteCmd: string,
  output: string,
): string {
  const timestamp = formatTimestamp()
  const trimmedOutput = output.trim()
  const displayOutput = truncateOutput(trimmedOutput)

  let entry = `# ${timestamp}\n${user}@${host}: $ ${remoteCmd}\n`
  if (displayOutput.length > 0) {
    entry += `${displayOutput}\n`
  }
  entry += "\n"
  return entry
}

function appendLog(filePath: string, entry: string): void {
  try {
    ensureLogDir()
    appendFileSync(filePath, entry, { encoding: "utf-8", flag: "a" })
  } catch (err) {
    // Silently fail — don't break the agent's workflow for a logging issue
    if (process.env.OPENCODE_SSH_LOGGER_DEBUG) {
      console.error(`[opencode-ssh-logger] Failed to write to ${filePath}:`, err)
    }
  }
}

function isConnectionFailure(output: string): boolean {
  return CONNECTION_FAILURE_PATTERNS.some((pattern) => pattern.test(output))
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export const SSHLogger: Plugin = async () => {
  return {
    config: async (cfg) => {
      cfg.command ??= {}
      cfg.command["ssh-logger"] = {
        description: "Show SSH logger log file locations",
        template: `Tell the user where opencode-ssh-logger writes SSH logs.

Do not inspect files or run commands. Reply with this information:
- Log directory: ${LOG_DIR}
- Global log: ${GLOBAL_LOG}
- Per-host logs: ${join(HOST_LOG_DIR, "<host>.log")}
- Per-session logs: ${join(SESSION_LOG_DIR, "<sessionID>.log")}
- Host and session file names are URL-encoded when needed.
- Log format: each entry starts with "# YYYY-MM-DD HH:MM:SS", followed by "user@host: $ <remote command>", then the command output. Entries are separated by a blank line.
- Example entry:
  # 2026-05-27 14:30:00
  ubuntu@example.com: $ uname -s
  Linux

Mention that the log directory is based on XDG_DATA_HOME, defaulting to ~/.local/share when XDG_DATA_HOME is not set.`,
      }
    },
    "tool.execute.after": async (input, output) => {
      // Only interested in bash tool calls
      if (input.tool !== "bash") return

      // Parse the SSH command
      const command = input.args?.command
      if (typeof command !== "string") return

      const parsed = parseSSH(command)
      if (!parsed) return

      // Skip connection failures that never reached the host
      if (isConnectionFailure(output.output ?? "")) return

      // Format and write the log entry
      const entry = formatEntry(
        parsed.user,
        parsed.host,
        parsed.remoteCmd,
        output.output ?? "",
      )

      // Write to global, per-host, and per-session logs
      const hostLog = join(HOST_LOG_DIR, `${logFileName(parsed.host)}.log`)
      const sessionLog = join(SESSION_LOG_DIR, `${logFileName(input.sessionID)}.log`)
      appendLog(GLOBAL_LOG, entry)
      appendLog(hostLog, entry)
      appendLog(sessionLog, entry)
    },
  }
}

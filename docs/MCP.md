# MCP — AI assistants and AiDM

AiDM ships a Model Context Protocol (MCP) server, so an AI assistant — Claude Desktop, Claude Code, Cursor, VS Code — can work with your downloads: read the list, queue a file, pause one, resume one, cancel one. The assistant never touches the disk or the network itself. It talks to the running app over a local channel, and the app decides what is allowed. Nothing works until you turn it on.

## How it fits together

| Piece | File | What it does |
|---|---|---|
| Client entry point | `tools/aidm-mcp.js` | The program an MCP client launches. Speaks MCP over stdio; every diagnostic goes to stderr. |
| Protocol layer | `src/mcp/stdio-server.js` | JSON-RPC 2.0 over stdio: `initialize`, `tools/list`, `tools/call`, `ping`, `resources/list`, `prompts/list`, `logging/setLevel`, `shutdown`. |
| Bridge | `src/mcp/bridge-server.js` | The listener that runs inside the app and carries out the commands. |
| Bridge client | `src/mcp/bridge-client.js` | The client half, in the `aidm-mcp` process. |
| Rules | `src/mcp/safety.js` | Access levels, the URL guard, text hygiene, the rate limiter. |
| Tool catalog | `src/mcp/tools.js` | The tools and their argument checks. |
| Audit log | `src/mcp/audit.js` | The append-only record of every call. |

The app opens a TCP listener on `127.0.0.1` on a random port and writes the port and a random token to `%LOCALAPPDATA%\AiDM\mcp-bridge.json`. The `aidm-mcp` process reads that file, presents the token, and only then may ask the app to do anything. If the app is not running, or the bridge is off, there is no file to read and the process says so.

## The security model

| # | Rule |
|---|---|
| 1 | **Off by default.** The bridge stays off until you tick "Allow AI assistants to use AiDM" in Settings › AI. Until then nothing on the computer can drive AiDM. |
| 2 | **The app has the final word.** The effective access level is the lower of the level the app allows and the level the client asked for. A client can lower its own level, never raise it, and the app enforces the result — the level in the client configuration is a request, not a grant. |
| 3 | **Loopback only, token required.** The listener binds `127.0.0.1` on a random port. Every connection must present the random token before a single command runs. The token lives in the connection file, in your own user profile — on Windows under `%LOCALAPPDATA%`, which only your account can read; where the platform honours POSIX modes, the file is written `0600`. |
| 4 | **No file deletion, no folder choice.** `remove_download` takes the row off the list and keeps the file. Downloads go to the folder you configured in Settings; an assistant cannot choose another one. |
| 5 | **Links are checked before anything is fetched.** Loopback, private, link-local, CGNAT, ULA, multicast and cloud-metadata addresses are refused, as are the shorthand forms of those, and so is a host that resolves to a private address. |
| 6 | **Rate limit.** At most 60 calls per minute per connection. Further calls are refused until the window frees up. |
| 7 | **Everything is written down.** Every call is appended to the audit log, with query-string values redacted. |
| 8 | **An import cannot open the bridge.** `mcpEnabled` is stripped from an imported settings file. Only the checkbox in Settings can turn the bridge on. |

Two further rules apply to text that came from outside the app: a server's file name, error message or URL is stripped of control characters and capped in length before it reaches the assistant, and a file name an assistant suggests is turned into a name and never a path — separators and the characters Windows reserves are removed.

### The URL guard

Only `http`, `https` and `ftp` links are considered; anything else is refused outright. Within those:

- **Host names that only ever mean this machine or the local network** are refused: `localhost`, `localhost.localdomain`, `metadata`, `metadata.google.internal`, `instance-data`, and anything ending in `.localhost`, `.local`, `.localdomain`, `.internal`, `.intranet` or `.home.arpa`.
- **Literal IPv4 addresses** in these ranges are refused: `0.0.0.0/8`, `10/8`, `127/8` (loopback), `169.254/16` (link-local, which covers the cloud metadata address `169.254.169.254`), `172.16/12`, `192.168/16`, `100.64/10` (CGNAT), `192.0.0/24`, `198.18/15`, and `224/4` and above (multicast and reserved).
- **Literal IPv6 addresses** are refused when they are `::`, `::1`, `fc00::/7` (unique local), `fe80::/10` (link-local), `ff00::/8` (multicast), `2001:db8::/32` (documentation) or `2001::/32` (Teredo). IPv4-mapped, NAT64 and 6to4 forms are judged by the IPv4 address they carry.
- **Shorthand forms of an address** are refused rather than guessed at: `012.1.2.3` (an ambiguous octal), `127.1`, and a plain decimal or hexadecimal integer.
- **A host name that resolves to a private address** is refused. The check runs against every address the name resolves to.

## Access levels

| Level | Tools | What it amounts to |
|---|---|---|
| `look` | `list_downloads`, `get_download`, `get_status`, `get_audit_log` | Read the list, the status and the audit log. Changes nothing. |
| `standard` | `look` plus `add_download`, `probe_link`, `pause_download`, `resume_download`, `cancel_download`, `start_queue`, `pause_queue` | Add, probe, pause, resume, cancel; run and hold the queue. |
| `full` | `standard` plus `remove_download` | Also take a row off the list. The file is still kept. |

Two details worth knowing:

- The app re-reads its allowed level from Settings on **every call**, so lowering the level in Settings takes effect at once — even for a connection that is already open. A client may lower the level it asked for; it can never raise the app's.
- The tool list is fixed when the connection opens, but the enforcement is not: a tool the connection may no longer use is refused at call time even if it was advertised.

## Tool reference

| Tool | Level | What it does | Arguments |
|---|---|---|---|
| `list_downloads` | `look` | List the downloads AiDM knows about, newest first. Each row carries its id, name, address, status, size, progress and speed. | `status` — `queued`, `downloading`, `paused`, `completed`, `error` or `all`; omit for every row. `text` — match on name or address, at most 200 characters. `limit` — 1 to 200, default 50. |
| `get_download` | `look` | Show one download in full: id, name, address, status, size, progress, speed, target folder and the last error. | `id` — required. Use `list_downloads` to find it. |
| `get_status` | `look` | A one-glance summary: how many downloads are running, queued, paused, finished or failed, and whether the queue is paused. | none |
| `get_audit_log` | `look` | Read the audit log: what an assistant asked AiDM to do, and what came of it. | `limit` — 1 to 200, default 50. |
| `add_download` | `standard` | Queue a download from an `http`, `https` or `ftp` address. AiDM works out the file name and the folder itself. | `url` — required. `filename` — optional, a name and never a path, at most 120 characters; any folder in it is ignored. `start` — start now (default true) or add to the list without starting. |
| `probe_link` | `standard` | Look at a link before downloading it: does the server answer, how big is the file, what is its name and type, can it be resumed. Nothing is downloaded. | `url` — required. |
| `pause_download` | `standard` | Pause one download. The partial file is kept so it can resume later. | `id` — required. |
| `resume_download` | `standard` | Resume a paused, queued or failed download. | `id` — required. |
| `cancel_download` | `standard` | Cancel one running download. The partial file is left on disk so it can be resumed later; nothing is deleted. | `id` — required. |
| `start_queue` | `standard` | Start the queue, so queued downloads begin. | none |
| `pause_queue` | `standard` | Pause the whole queue: nothing new starts, and running downloads keep running. | none |
| `remove_download` | `full` | Take one download off the list. The file is kept — this never deletes anything on disk. | `id` — required. |

## Turning it on

1. Start AiDM.
2. Open **Settings › AI** and find the section **AI assistants (MCP)**.
3. Tick **Allow AI assistants to use AiDM** (the setting `mcpEnabled`, off by default).
4. Pick an access level (the setting `mcpAccessLevel`, `standard` by default). The three options are "Look only", "Standard" and "Full".

The app writes the connection file when the bridge starts:

| Path | Contents |
|---|---|
| `%LOCALAPPDATA%\AiDM\mcp-bridge.json` | `version`, `app`, `port`, `token`, `pid`, `level`, `startedAt` |

The file is written inside your own user profile and is removed when the bridge stops. On Windows that is `%LOCALAPPDATA%\AiDM`, which only your account can read; where the platform honours POSIX modes the file is written `0600`. On platforms other than Windows the same shape is used under the user's home folder. Clients find the file automatically; `--bridge <file>` points a client somewhere else.

The server can also be started by hand, which is how you check that it works:

```
npm run mcp
```

That is the same as `node tools/aidm-mcp.js`. The flags are:

| Flag | Meaning |
|---|---|
| `--level look\|standard\|full` | The level this client asks for. The app may lower it. Default `standard`. |
| `--read-only` | The same as `--level look`. |
| `--bridge <file>` | Use a different connection file. |
| `--help` | Print the usage text. |

Standard output carries the protocol and nothing else; every note, warning and error goes to standard error.

## Client configuration

Every example below runs the server with `node` and the absolute path to `tools/aidm-mcp.js` on this machine. In JSON, backslashes are escaped, so `D:\000000 Lab\AiDM\aidm\tools\aidm-mcp.js` becomes `D:\\000000 Lab\\AiDM\\aidm\\tools\\aidm-mcp.js`.

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aidm": {
      "command": "node",
      "args": [
        "D:\\000000 Lab\\AiDM\\aidm\\tools\\aidm-mcp.js",
        "--level",
        "standard"
      ]
    }
  }
}
```

Restart Claude Desktop after editing the file.

### Claude Code

```
claude mcp add --scope user aidm -- node "D:\000000 Lab\AiDM\aidm\tools\aidm-mcp.js" --level standard
```

Drop `--scope user` to keep the server to the current project instead.

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "aidm": {
      "command": "node",
      "args": [
        "D:\\000000 Lab\\AiDM\\aidm\\tools\\aidm-mcp.js",
        "--level",
        "standard"
      ]
    }
  }
}
```

### VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "aidm": {
      "type": "stdio",
      "command": "node",
      "args": [
        "D:\\000000 Lab\\AiDM\\aidm\\tools\\aidm-mcp.js",
        "--level",
        "standard"
      ]
    }
  }
}
```

### Starting from a lower level

Use `look` when the assistant only needs to report on the list, and `full` when it should also be able to take a row off the list:

```
node "D:\000000 Lab\AiDM\aidm\tools\aidm-mcp.js" --level look
node "D:\000000 Lab\AiDM\aidm\tools\aidm-mcp.js" --read-only
```

Whichever level the client asks for, the app applies the lower of that and the level set in Settings.

## The audit log

| | |
|---|---|
| File | `%LOCALAPPDATA%\AiDM\logs\mcp-audit.log` |
| Format | One JSON object per line |
| Fields | `ts`, `tool`, `level`, `outcome`, `detail` |

Every call is appended, including the ones that were refused. `outcome` is `ok`, `error`, `denied`, `rate-limited` or `unknown-command`; a connection that presented a bad token is recorded as `hello` with `denied`.

A URL written to the log keeps its parameter names and loses their values, because signed links carry tokens: `https://host/file.zip?sig=REDACTED`.

The log is rotated once it passes 1 MB, and three rotated copies are kept.

The assistant can read the same log through the `get_audit_log` tool, so "what did you just download?" is a question the assistant can answer from the app's own record.

## Troubleshooting

**"AiDM is not reachable (…)."** The app is not running, or the bridge is off. Start AiDM and tick "Allow AI assistants to use AiDM" in Settings › AI. The server cannot start the app.

**"the connection was refused"** The connection file is stale — it belongs to an app that has since closed. Restart AiDM so it writes a new one.

**A link is refused.** The message says which rule applied: `localhost is this computer or the local network`, `127.0.0.1 is a private or local address`, `169.254.169.254 is a private or local address`, `012.1.2.3 is not a plain IP address (it may be shorthand for a local one)`, or `example.com could not be resolved (getaddrinfo ENOTFOUND)`. Use a public address.

**"This connection may not use "add_download" — it needs the "standard" access level, and this one has "look"."** The client asked for less than the command needs, or the app allows less. Raise the access level in Settings and reconnect, or raise the `--level` flag — the app still has the last word.

**"The "remove_download" tool needs the "full" access level. This connection runs at "standard"."** `remove_download` is a `full` tool. Set the level to `full` in Settings, and pass `--level full` to the client. The file is kept either way.

**A tool is missing from the assistant's list.** Tools outside the effective level are not advertised. This is the level working as intended, not a fault.

**"Too many calls. Try again in 4 second(s)."** The rate limit is 60 calls per minute per connection. Wait for the window to clear.

**"AiDM has no default download folder yet. Set one in Settings first."** `add_download` needs a configured save path. Set the download folder in Settings.

## Known limits

- The URL guard checks the link **before** the download starts. A redirect to a private address is not re-checked mid-transfer.
- Magnet links are not accepted by `add_download`, so an assistant cannot drive the torrent picker. Use the app for torrents and magnets.
- The server needs the app running; it cannot start it, and it does not survive the app closing.
- `remove_download` takes the row off the list and keeps the file. There is no way for an assistant to delete a file, and none is offered.

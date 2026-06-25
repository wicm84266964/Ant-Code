export const BUILT_IN_TOOLS = Object.freeze([
  {
    name: "read_file",
    description: "Read a UTF-8 text file inside the active workspace, or an approved/full-access local path. Returns the full file unless maxBytes is explicitly supplied.",
    risk: "read",
    supportsAbort: false,
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        maxBytes: { type: "number" }
      }
    }
  },
  {
    name: "list_files",
    description: "List direct children of a workspace directory, or an approved/full-access local directory.",
    risk: "read",
    supportsAbort: false,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" }
      }
    }
  },
  {
    name: "glob",
    description: "Match workspace files with a glob pattern, or files under an approved/full-access local path. Returns all matches unless maxMatches is explicitly supplied.",
    risk: "read",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        maxMatches: { type: "number" }
      }
    }
  },
  {
    name: "grep",
    description: "Search workspace text files, or text files under an approved/full-access local path. Returns all matching lines unless maxMatches is explicitly supplied.",
    risk: "read",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        maxMatches: { type: "number" }
      }
    }
  },
  {
    name: "rg_search",
    description: "Search workspace files with local ripgrep using regex, glob filters, context lines, and bounded structured results. Falls back only by explicit caller choice; the legacy grep tool remains unchanged.",
    risk: "read",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "array" },
        ignoreCase: { type: "boolean" },
        caseSensitive: { type: "boolean" },
        fixedStrings: { type: "boolean" },
        wordRegexp: { type: "boolean" },
        multiline: { type: "boolean" },
        hidden: { type: "boolean" },
        noIgnore: { type: "boolean" },
        beforeContext: { type: "number" },
        afterContext: { type: "number" },
        maxResults: { type: "number" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "rg_files",
    description: "List workspace files with local ripgrep, honoring .gitignore by default and supporting glob filters.",
    risk: "read",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        glob: { type: "array" },
        hidden: { type: "boolean" },
        noIgnore: { type: "boolean" },
        maxResults: { type: "number" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "rg_files_with_matches",
    description: "Return only workspace file paths that match a ripgrep pattern.",
    risk: "read",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "array" },
        ignoreCase: { type: "boolean" },
        fixedStrings: { type: "boolean" },
        hidden: { type: "boolean" },
        noIgnore: { type: "boolean" },
        maxResults: { type: "number" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "rg_count",
    description: "Count ripgrep matches or matching files in the workspace without returning every match.",
    risk: "read",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        mode: { type: "string", enum: ["matches", "files"] },
        glob: { type: "array" },
        ignoreCase: { type: "boolean" },
        fixedStrings: { type: "boolean" },
        hidden: { type: "boolean" },
        noIgnore: { type: "boolean" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "ts_symbols",
    description: "List TypeScript/JavaScript symbols for a workspace source file using the local TypeScript language service.",
    risk: "read",
    supportsAbort: false,
    inputSchema: {
      type: "object",
      required: ["file"],
      properties: {
        file: { type: "string" },
        maxResults: { type: "number" }
      }
    }
  },
  {
    name: "ts_diagnostics",
    description: "Return bounded TypeScript/JavaScript syntactic and semantic diagnostics for a file or workspace.",
    risk: "read",
    supportsAbort: false,
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        maxResults: { type: "number" },
        maxFiles: { type: "number" }
      }
    }
  },
  {
    name: "ts_find_definition",
    description: "Find the true TypeScript/JavaScript definition at a 1-based file line and column.",
    risk: "read",
    supportsAbort: false,
    inputSchema: {
      type: "object",
      required: ["file", "line", "column"],
      properties: {
        file: { type: "string" },
        line: { type: "number" },
        column: { type: "number" },
        maxResults: { type: "number" }
      }
    }
  },
  {
    name: "ts_find_references",
    description: "Find true TypeScript/JavaScript references at a 1-based file line and column.",
    risk: "read",
    supportsAbort: false,
    inputSchema: {
      type: "object",
      required: ["file", "line", "column"],
      properties: {
        file: { type: "string" },
        line: { type: "number" },
        column: { type: "number" },
        maxResults: { type: "number" }
      }
    }
  },
  {
    name: "git_status",
    description: "Show local git status without shell interpolation.",
    risk: "read",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      properties: {
        pathspecs: { type: "array" }
      }
    }
  },
  {
    name: "git_diff",
    description: "Show local git diff or diff stat without shell interpolation.",
    risk: "read",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      properties: {
        pathspecs: { type: "array" },
        stat: { type: "boolean" }
      }
    }
  },
  {
    name: "git_log",
    description: "Show bounded local git commit history without shell interpolation.",
    risk: "read",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      properties: {
        maxCount: { type: "number" },
        path: { type: "string" },
        author: { type: "string" },
        grep: { type: "string" },
        since: { type: "string" }
      }
    }
  },
  {
    name: "git_show",
    description: "Show a bounded local git object, commit, tag, or file at a revision without shell interpolation.",
    risk: "read",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      required: ["revision"],
      properties: {
        revision: { type: "string" },
        path: { type: "string" },
        stat: { type: "boolean" },
        maxBytes: { type: "number" }
      }
    }
  },
  {
    name: "git_branch_list",
    description: "List local and remote git branches with current/upstream metadata.",
    risk: "read",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean" },
        maxCount: { type: "number" }
      }
    }
  },
  {
    name: "git_stash_list",
    description: "List local git stash entries without shell interpolation.",
    risk: "read",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      properties: {
        maxCount: { type: "number" }
      }
    }
  },
  {
    name: "git_tag_list",
    description: "List local git tags without shell interpolation.",
    risk: "read",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        maxCount: { type: "number" }
      }
    }
  },
  {
    name: "git_add",
    description: "Stage explicit workspace paths for git commit after write approval. Does not accept broad '.' staging.",
    risk: "write",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      required: ["paths"],
      properties: {
        paths: { type: "array" }
      }
    }
  },
  {
    name: "git_commit",
    description: "Create a git commit from already staged changes after write approval.",
    risk: "write",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      required: ["message"],
      properties: {
        message: { type: "string" },
        body: { type: "string" }
      }
    }
  },
  {
    name: "git_branch",
    description: "Create, switch, or delete local git branches after write approval. Delete requires explicit force=true.",
    risk: "write",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      required: ["action", "name"],
      properties: {
        action: { type: "string", enum: ["create", "switch", "delete"] },
        name: { type: "string" },
        startPoint: { type: "string" },
        force: { type: "boolean" }
      }
    }
  },
  {
    name: "git_stash",
    description: "Run explicit git stash actions after write approval. Supports push, apply, pop, drop, and show.",
    risk: "write",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["push", "apply", "pop", "drop", "show"] },
        ref: { type: "string" },
        message: { type: "string" },
        includeUntracked: { type: "boolean" },
        paths: { type: "array" }
      }
    }
  },
  {
    name: "git_tag",
    description: "Create or delete local git tags after write approval.",
    risk: "write",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      required: ["action", "name"],
      properties: {
        action: { type: "string", enum: ["create", "delete"] },
        name: { type: "string" },
        target: { type: "string" },
        message: { type: "string" }
      }
    }
  },
  {
    name: "write_file",
    description: "Create or replace a text file after policy approval; approved/full-access mode allows paths outside the workspace.",
    risk: "write",
    supportsAbort: false,
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: { type: "string" },
        content: { type: "string" }
      }
    }
  },
  {
    name: "edit_file",
    description: "Replace exact text in an existing text file after policy approval; approved/full-access mode allows paths outside the workspace.",
    risk: "write",
    supportsAbort: false,
    inputSchema: {
      type: "object",
      required: ["path", "oldText", "newText"],
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        expectedReplacements: { type: "number" },
        dryRun: { type: "boolean" }
      }
    }
  },
  {
    name: "powershell",
    description: "Run a PowerShell command through the permission engine.",
    risk: "execute",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "bash",
    description: "Run a POSIX shell command through the permission engine.",
    risk: "execute",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "background_shell",
    description: "Start a long-running terminal command as a registered background task with stdout/stderr logs, then return immediately. Use for discover, crawls, downloads, renders, servers, or other long jobs the user should be able to monitor and cancel while continuing the conversation.",
    risk: "execute",
    supportsAbort: false,
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        title: { type: "string" },
        taskId: { type: "string" },
        logDir: { type: "string" }
      }
    }
  },
  {
    name: "mcp_list",
    description: "List configured MCP servers, tools, prompts, resources, or read a resource from one configured MCP server.",
    risk: "mcp",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string" },
        kind: { type: "string", enum: ["tools", "prompts", "resources", "resource"] },
        uri: { type: "string" }
      }
    }
  },
  {
    name: "mcp_call",
    description: "Call a configured local or lab-approved MCP tool through the permission engine.",
    risk: "mcp",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      required: ["server", "tool"],
      properties: {
        server: { type: "string" },
        tool: { type: "string" },
        arguments: { type: "object" }
      }
    }
  },
  {
    name: "web_fetch",
    description: "Fetch an HTTP(S) URL and return text, markdown, or html through the network permission engine. Returns the full fetched body unless maxBytes is explicitly supplied.",
    risk: "network",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string" },
        format: { type: "string", enum: ["text", "markdown", "html"] },
        timeoutMs: { type: "number" },
        maxBytes: { type: "number" }
      }
    }
  },
  {
    name: "web_search",
    description: "Search the public web through a configured SearXNG endpoint or DuckDuckGo HTML fallback. Results are best-effort and must be cited.",
    risk: "network",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        maxResults: { type: "number" },
        timeoutMs: { type: "number" },
        searxngUrl: { type: "string" }
      }
    }
  },
  {
    name: "document_intake",
    description: "Extract local text or Markdown from txt/md/html/xml/json/csv and lightweight Office documents inside the workspace, or an approved/full-access local path. Returns full extracted content unless maxBytes is explicitly supplied.",
    risk: "document",
    supportsAbort: false,
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        maxBytes: { type: "number" }
      }
    }
  },
  {
    name: "skill_list",
    description: "List configured local skills and their bounded metadata.",
    risk: "read",
    supportsAbort: false,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        includeDisabled: { type: "boolean" }
      }
    }
  },
  {
    name: "skill_read",
    description: "Read a bounded local skill instruction file before applying that workflow.",
    risk: "read",
    supportsAbort: false,
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" }
      }
    }
  },
  {
    name: "skill_run",
    description: "Prepare a local skill instruction bundle for the current task. Scripts are not executed by this tool.",
    risk: "read",
    supportsAbort: false,
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        message: { type: "string" }
      }
    }
  },
  {
    name: "agent_run",
    description: "Run a configured one-shot local subagent with a focused task through the same lab gateway and local permission engine. Built-in profiles include explorer, readonly-researcher, planner, verifier, junior, reviewer, browser-verifier, visual-verifier, and code-worker. For broad work, split the job into bounded slices, set difficulty/modelTier deliberately, and provide writeScope plus acceptance for junior/write tasks.",
    risk: "read",
    supportsAbort: true,
    inputSchema: {
      type: "object",
      required: ["profile", "query"],
      properties: {
        profile: { type: "string" },
        query: { type: "string" },
        taskId: { type: "string" },
        title: { type: "string" },
        parallel: { type: "boolean" },
        background: { type: "boolean" },
        groupId: { type: "string" },
        waitForGroup: { type: "string", enum: ["all", "any", "none"] },
        wakeParent: { type: "boolean" },
        wakeReason: { type: "string" },
        purpose: { type: "string", enum: ["explore", "research", "plan", "execute", "verify", "review", "browser", "visual"] },
        difficulty: { type: "string", enum: ["quick", "standard", "deep"] },
        risk: { type: "string", enum: ["low", "medium", "high"] },
        modelTier: { type: "string" },
        writeScope: { type: "array", items: { type: "string" } },
        acceptance: { type: "array", items: { type: "string" } },
        contextPack: { type: "object" }
      }
    }
  },
  {
    name: "todo_read",
    description: "Read the current session-local todo list.",
    risk: "read",
    supportsAbort: false,
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "todo_write",
    description: "Replace the current session-local todo list. Prefer items, but todos/tasks/list are accepted aliases.",
    risk: "write",
    supportsAbort: false,
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array" },
        todos: { type: "array" },
        tasks: { type: "array" },
        list: { type: "array" }
      }
    }
  },
  {
    name: "plan_update",
    description: "Replace the current session-local plan steps. Prefer steps, but plan/items are accepted aliases.",
    risk: "write",
    supportsAbort: false,
    inputSchema: {
      type: "object",
      properties: {
        explanation: { type: "string" },
        steps: { type: "array" },
        plan: { type: "array" },
        items: { type: "array" }
      }
    }
  },
  {
    name: "ask_user",
    description: "Ask the local user for clarification during an interactive session. Supports plain text, single-choice, multi-choice, and custom-answer confirmation prompts.",
    risk: "read",
    supportsAbort: false,
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: {
        header: { type: "string" },
        question: { type: "string" },
        choices: { type: "array" },
        multiple: { type: "boolean" },
        allowCustom: { type: "boolean" },
        confirmLabel: { type: "string" }
      }
    }
  }
]);

export function getToolDefinitions() {
  return BUILT_IN_TOOLS.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } }));
}

export const RECOMMENDED_MCP_SERVERS = Object.freeze([
  {
    name: "fetch",
    description: "免 key 网页抓取 MCP；适合抓取文档、网页正文和简单 API 响应。",
    enabled: true,
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch"],
    toolRisks: {
      fetch: "network"
    },
    recommended: true,
    category: "web"
  },
  {
    name: "duckduckgo-search",
    description: "免 key DuckDuckGo 搜索 MCP；可能受公开搜索限流影响。",
    enabled: true,
    transport: "stdio",
    command: "uvx",
    args: ["duckduckgo-mcp-server"],
    toolRisks: {
      search: "network",
      news_search: "network"
    },
    recommended: true,
    category: "web"
  },
  {
    name: "searxng",
    description: "连接实验室自建 SearXNG 的搜索 MCP；需要本地 SearXNG 服务后再启用。",
    enabled: false,
    transport: "stdio",
    command: "npx",
    args: ["-y", "mcp-searxng"],
    env: {
      SEARXNG_URL: "http://localhost:8080"
    },
    toolRisks: {
      search: "network"
    },
    recommended: true,
    category: "web"
  },
  {
    name: "playwright",
    description: "浏览器自动化 MCP；用于网页点击、输入、截图和页面状态观察。",
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    toolRisks: {
      browser_navigate: "browser",
      browser_click: "browser",
      browser_type: "browser",
      browser_snapshot: "read",
      browser_take_screenshot: "read",
      browser_close: "browser"
    },
    recommended: true,
    category: "browser"
  },
  {
    name: "memory",
    description: "本地知识图谱/记忆 MCP；写入长期记忆仍受权限策略控制。",
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    toolRisks: {
      read_graph: "memory",
      search_nodes: "memory",
      create_entities: "memory",
      create_relations: "memory",
      add_observations: "memory"
    },
    recommended: true,
    category: "memory"
  },
  {
    name: "filesystem",
    description: "标准文件系统 MCP；与 Ant Code 内置文件工具重叠，主要用于兼容 MCP 生态。",
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    toolRisks: {
      read_file: "read",
      list_directory: "read",
      search_files: "read",
      write_file: "write",
      edit_file: "write"
    },
    recommended: true,
    category: "filesystem"
  },
  {
    name: "sequential-thinking",
    description: "结构化思考 MCP；用于复杂任务拆解，不能替代 todo/plan 和真实验证。",
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    toolRisks: {
      sequentialthinking: "read"
    },
    recommended: true,
    category: "planning"
  },
  {
    name: "sqlite",
    description: "本地 SQLite MCP；用于后续数据分析场景，启用前请配置具体数据库路径。",
    enabled: false,
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-sqlite", "--db-path", ".lab-agent/data.sqlite"],
    toolRisks: {
      read_query: "read",
      write_query: "write",
      list_tables: "read",
      describe_table: "read"
    },
    recommended: true,
    category: "data"
  }
]);

export function recommendedMcpServers() {
  return RECOMMENDED_MCP_SERVERS.map((server) => ({
    ...server,
    args: [...server.args],
    env: server.env ? { ...server.env } : undefined,
    toolRisks: { ...server.toolRisks }
  }));
}

export function mergeRecommendedMcpServers(servers = []) {
  const configured = Array.isArray(servers) ? servers : [];
  const seen = new Set(configured.map((server) => String(server?.name ?? "").toLowerCase()).filter(Boolean));
  return [
    ...configured,
    ...recommendedMcpServers().filter((server) => !seen.has(server.name.toLowerCase()))
  ];
}

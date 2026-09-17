# Module Provenance: net

## Scope

`src/net/` contains small networking support helpers used by local tools and
stdio MCP launchers. It does not define model providers, external endpoints, or
remote services.

## Files

- `src/net/proxy.js`

## Provenance

This module is an independent implementation created for the lab-agent clean
room codebase.

The proxy helper was written to solve a local Windows runtime issue: Node's
native `fetch` does not automatically inherit the Windows system proxy used by
the browser and PowerShell. The implementation reads explicit proxy environment
variables first, then reads the Windows Internet Settings registry key when no
proxy environment is present. It also bypasses loopback hosts so local tools and
tests do not accidentally route through a public proxy.

No source code, prompts, package manifests, generated bundles, or runtime assets
from the archived legacy Ant Code project were copied into this module.

## Safety Notes

- Proxy URLs are read from process environment, project config, or Windows
  system settings at runtime.
- The module does not persist proxy credentials.
- Child process proxy injection only adds standard `HTTP_PROXY`,
  `HTTPS_PROXY`, and `NO_PROXY` variables before the existing environment
  scrubber removes sensitive values.
- SOCKS proxies are not implemented directly; users should expose an HTTP mixed
  port from their proxy tool if needed.

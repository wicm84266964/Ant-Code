# Third-Party Notices

Ant Code is licensed under AGPL-3.0-only. It also includes or generates local
runtime assets from the following third-party packages:

| Component | Use | License |
| --- | --- | --- |
| `@vscode/ripgrep` | local ripgrep executable resolver for workspace search tools | MIT |
| `@vscode/ripgrep-*` platform packages | optional platform-local ripgrep binaries installed by npm for the current OS/CPU | MIT |
| `typescript` | local JavaScript/TypeScript language service for symbols, diagnostics, definitions, and references | Apache-2.0 |
| `ink` | terminal UI runtime dependency | MIT |
| `react` | UI runtime dependency | MIT |
| `katex` | math rendering runtime dependency; Dashboard CSS and font assets | MIT |
| `mermaid` | Dashboard diagram rendering bundle input | MIT |
| `yaml` | Dashboard YAML parsing bundle input | ISC |
| `esbuild` | development/build tool for Dashboard assets | MIT |
| `postject` | development/build tool for optional executable packaging | MIT |

The checked-in Dashboard assets under `src/dashboard/public/vendor/` are built
from local npm dependencies, not from a CDN. `rich-renderers.js` preserves
bundler license comments for included browser dependencies. `katex.min.css` and
the `fonts/` directory are copied from KaTeX.

Dependency versions and package licenses are recorded in the public lockfiles:

- `package-lock.json`
- `npm-shrinkwrap.json`

Local maintainers can also generate dependency evidence with:

```sh
npm run audit:sbom
npm run audit:licenses
```

## MIT License Text

Permission is hereby granted, free of charge, to any person obtaining a copy of
software and associated documentation files licensed under the MIT License, to
deal in the software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the software, and to permit persons to whom the software is furnished to do
so, subject to the following conditions:

The copyright notice and this permission notice shall be included in all copies
or substantial portions of the software.

The software is provided "as is", without warranty of any kind, express or
implied, including but not limited to the warranties of merchantability, fitness
for a particular purpose and noninfringement. In no event shall the authors or
copyright holders be liable for any claim, damages or other liability, whether
in an action of contract, tort or otherwise, arising from, out of or in
connection with the software or the use or other dealings in the software.

## ISC License Text

Permission to use, copy, modify, and/or distribute software licensed under the
ISC License for any purpose with or without fee is hereby granted, provided that
the copyright notice and this permission notice appear in all copies.

The software is provided "as is" and the author disclaims all warranties with
regard to this software including all implied warranties of merchantability and
fitness. In no event shall the author be liable for any special, direct,
indirect, or consequential damages or any damages whatsoever resulting from loss
of use, data or profits, whether in an action of contract, negligence or other
tortious action, arising out of or in connection with the use or performance of
this software.

## Apache License 2.0 Notice

`typescript` is licensed under the Apache License, Version 2.0. A copy of the
license is available from the Apache Software Foundation at:

https://www.apache.org/licenses/LICENSE-2.0

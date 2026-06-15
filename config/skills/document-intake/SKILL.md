---
name: document-intake
description: 本地文档解析、摘要和资料接手工作流。
when_to_use: 需要读取 PDF、Word、PPT、Excel、HTML、CSV、Markdown 等资料并整理摘要时使用。
allowed-tools: document_intake, read_file, list_files, glob, powershell, bash
argument_hint: 提供文档路径、需要提取的内容类型、摘要粒度和是否允许使用本地转换工具。
---
# Document Intake

用这个 skill 把本地资料转成可供模型处理的有界文本。

## 工作流

1. 先确认文档路径在当前 workspace 内。
2. 优先调用 `document_intake`：
   - 支持 txt/md/json/csv/xml/html。
   - 支持轻量解析 docx/pptx/xlsx。
   - PDF 在核心实现中只给出边界提示。
3. 如果用户允许，并且本机安装了 MarkItDown，可通过受权限控制的 shell 命令做额外转换。
4. 对大文件只提取目录、标题、表格预览和关键段落，不输出全文。

## 输出要求

- 标注文件名、类型、大小和是否截断。
- 把“可确认内容”和“转换器可能漏掉的内容”分开写。
- 不把私有文档全文复制到主聊天，除非用户明确要求。

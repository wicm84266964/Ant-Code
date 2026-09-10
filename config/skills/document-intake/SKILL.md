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
   - PDF 抽取内嵌文本层，默认每次最多 20 页；需要后续页时传 `pageStart`。
   - Dashboard 回形针也可直接附上这些文件；发送时会写入 `ant-code-uploads/` 并抽文本。
   - 有文字层的 PDF：用抽取的文字回答；预览不够时用 `document_intake` 按页补读，不要自动逐页走视觉。
   - 无文字层的扫描件：先完整渲染前几页做视觉识别，尽快参与对话，并标明已读页码；不能假定这些页包含摘要。
   - 还需要更多扫描页时：说明未覆盖范围，询问是继续后几页还是全量视觉，并提示额外耗时和费用。全量视觉必须由用户在回形针上填写起止页后重新发送。失败或取消不能视为已读完整文档。没有本地 OCR 引擎。
3. 只有文本层为空、且用户允许时，才考虑本机 MarkItDown 或其他 OCR 转换器。
4. 对大文件只提取目录、标题、表格预览和关键段落，不输出全文。

## 输出要求

- 标注文件名、类型、大小和是否截断。
- 把“可确认内容”和“转换器可能漏掉的内容”分开写。
- 不把私有文档全文复制到主聊天，除非用户明确要求。

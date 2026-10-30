# AlembicAgent Architecture Atlas

本目录是独立研发文档与只读阅读器，根 AGENTS.md 仍适用。

- 常规图谱任务只修改本目录；产品 src/test/scripts/config、Core 与相邻仓库只读。
- maps Markdown/Mermaid 是人工说明正典；AST依赖数据、页面和渲染回执都是派生材料。
- 导入、调用、状态、运行证据分别表达；每条图边有稳定ID与代码/测试依据。
- 测试引用只能证明定位，行为覆盖须说明断言；未运行不得写通过。
- 来源变化后先重读差异，不只更新hash；历史快照不可覆盖。不得提交本机路径、凭据或私有会话标识。
- 图谱不加入根workspace、发布包或产品门禁；自有输出只在本目录的ignored dist/.cache。
- 新代码先写检查反例，再实现；交付运行 npm run check，并在浏览器完成渲染及代表视口核对。

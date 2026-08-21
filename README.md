# Customs Crawl

独立运行的中国海关统计数据抓取协调器。这个子项目只负责：

`配置读取 -> 任务展开 -> 普通浏览器查询 -> 官方 CSV 导出 -> raw 保存`

它不依赖 `pipeline`、`retracker` 或仓库根目录 Python 包，也不处理后续结构化转换。

## 环境

需要：

- Python 3.11–3.14
- [uv](https://docs.astral.sh/uv/)
- Chrome 或 Edge
- Tampermonkey 浏览器扩展

在 `scripts/customs_crawl` 目录执行：

```powershell
uv sync --all-extras
```

将 [customs_crawl.user.js](customs_crawl.user.js) 导入 Tampermonkey。浏览器端脚本只访问本机协调服务，不依赖仓库中的其他脚本。

## 使用

先查看配置展开结果：

```powershell
uv run customs-crawl plan
```

开始抓取：

```powershell
uv run customs-crawl fetch
```

默认数据目录为 `scripts/customs_crawl/data/customs/raw/`。可以指定独立目录：

```powershell
uv run customs-crawl fetch --data-dir D:\CustomsData
```

`--replace` 会重新处理已有任务：

```powershell
uv run customs-crawl fetch --replace
```

脚本默认使用 `127.0.0.1:8765`。端口被占用时，协调器和浏览器端脚本可以一起改用新端口：

```powershell
uv run customs-crawl fetch --port 8766
```

打开的海关地址会携带 `#customs-crawl-port=8766`，userscript 会读取这个端口。手动打开页面时，也可以使用这个 hash。

## 配置

编辑 [config/customs_queries.json](config/customs_queries.json)：

- `start_year`、`end_year`、`start_month`、`end_month`：查询范围
- `months_per_job`：每次查询包含的月份数，四维明细建议使用 `3`
- `ie_types`：`export`、`import` 或 `import-export`
- `groups`：`commodity`、`partner`、`trade_mode`、`province`
- `products`：商品编码和启用状态

每个 CSV 保留官网原始字段和编码。任务状态保存在 `fetch_state.json`，文件清单和哈希保存在 `fetch_manifest.json`。重新运行会跳过已保存 CSV 和明确记录为无数据的任务。

## 检查

```powershell
uv run ruff check src tests
uv run pytest
```

# -*- coding: utf-8 -*-
"""把 EaglePDFReader 打包为 .eagleplugin（Eagle 插件安装包 = 根目录含 manifest.json 的 zip）。

用法：
    python pack-plugin.py                        # 打 EaglePDFReader，版本号取自 manifest.json
    python pack-plugin.py 1.0.1                  # 覆盖版本号
    python pack-plugin.py "" EagleNoteWorkbench  # 打伴生插件（版本取自其 manifest）
"""
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, sys.argv[2] if len(sys.argv) > 2 else "EaglePDFReader")

# 不进入安装包的开发期文件
EXCLUDE_DIRS = {"dist", "__pycache__", ".git", "node_modules", "Plugins"}
EXCLUDE_FILES = {".DS_Store", "Thumbs.db"}

MAIN_DIR = "EaglePDFReader"       # 版本号以主插件为准
WB_DIR = "EagleNoteWorkbench"     # 工作台（启动器）必须与主插件同版本


def sync_launcher_version():
    """版本号联动：不管打哪个包，先把主插件的版本同步给工作台。

    两个插件在 Eagle 里是配套的（主插件 4.2.1 改名别名等数据格式，
    工作台的读取端必须匹配），历史上靠手工同步漏过一次，这里在机制上焊死。"""
    main_path = os.path.join(HERE, MAIN_DIR, "manifest.json")
    wb_path = os.path.join(HERE, WB_DIR, "manifest.json")
    with open(main_path, encoding="utf-8") as f:
        main_ver = json.load(f).get("version")
    with open(wb_path, encoding="utf-8") as f:
        wb = json.load(f)
    if wb.get("version") == main_ver:
        return main_ver
    wb["version"] = main_ver
    with open(wb_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(wb, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"synced  {WB_DIR} version -> {main_ver}")
    return main_ver


def main():
    sync_launcher_version()
    manifest_path = os.path.join(SRC, "manifest.json")
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)

    version = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else manifest.get("version", "1.0.0")
    name = manifest.get("name", "eagle-plugin")
    for ch in '\\/:*?"<>|':
        name = name.replace(ch, "-")
    out = os.path.join(HERE, f"{name}-{version}.eagleplugin")
    if os.path.exists(out):
        os.remove(out)

    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for root, dirs, files in os.walk(SRC):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            for fn in files:
                if fn in EXCLUDE_FILES:
                    continue
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, SRC).replace("\\", "/")
                z.write(full, rel)
                count += 1

    with zipfile.ZipFile(out) as z:
        names = set(z.namelist())
        assert "manifest.json" in names, "packaging error: manifest.json must be at archive root"

    size_mb = os.path.getsize(out) / 1048576
    print(f"OK  {os.path.basename(out)}  {count} files  {size_mb:.2f} MB")
    print(f"    id={manifest.get('id')}  version={version}  devTools={manifest.get('devTools')}")


if __name__ == "__main__":
    main()

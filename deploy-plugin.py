# -*- coding: utf-8 -*-
"""把 EaglePDFReader / EagleNoteWorkbench 部署到 Eagle 的 Plugins 目录。

为什么单独成脚本（v4.5.1）：
  以前每次发版都在对话里现写一段 python —— 快照、同步、md5 校验、清理，
  每次略有出入，而且「远端有、源码没有」的旧文件（比如 300KB 的 README.md）
  一直不会被删掉，越堆越多。这里把流程固定下来：

    1) 旧版本先整目录快照到 plugin-snapshots/（**必须在 Plugins 目录之外** ——
       Eagle 会把 Plugins 下所有含 manifest.json 的子目录都注册成插件，
       快照放里面就会出现多个同名旧版本）；
    2) 同步源码 → Plugins/<id>/，并删掉源码里已经不存在的文件
       （保留 Eagle 自己写的 window-state.json）；
    3) 逐个文件比 md5，打印差异。

用法：
    python deploy-plugin.py            # 双插件一起部署
    python deploy-plugin.py LB7PDFRDK3QM
"""
import hashlib
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUG = os.path.join(os.environ.get("APPDATA", ""), "Eagle", "Plugins")
SNAP = os.path.join(os.environ.get("APPDATA", ""), "Eagle", "plugin-snapshots")

PAIRS = [("EaglePDFReader", "LB7PDFRDK3QM"), ("EagleNoteWorkbench", "LB7NOTEWB01")]

# 不进安装包、也不该出现在插件目录里的非运行时文件
SKIP_FILES = {".DS_Store", "Thumbs.db", "README.md", "FEATURES.md"}
SKIP_DIRS = {"__pycache__", ".git", "node_modules", "dist"}

# Eagle 自己写进插件目录的运行时文件：源码里没有，但**不能删**
PRESERVE = {"window-state.json"}


def version_of(path):
    with open(os.path.join(path, "manifest.json"), encoding="utf-8") as f:
        return json.load(f).get("version", "0.0.0")


def md5(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def manifest(root):
    out = {}
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in files:
            if fn in SKIP_FILES:
                continue
            full = os.path.join(base, fn)
            out[os.path.relpath(full, root).replace("\\", "/")] = full
    return out


def manifest_all(root):
    """目标目录的**全部**文件（含 README 这类非运行时文件）。

    清理陈旧文件必须用这一份：manifest() 会把 README 过滤掉，
    拿它当基准就永远发现不了「插件目录里躺着一个 300KB 的 README」——
    v4.5.1 第一次跑就是这么漏掉的。"""
    out = {}
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in files:
            full = os.path.join(base, fn)
            out[os.path.relpath(full, root).replace("\\", "/")] = full
    return out


def deploy(src_name, dst_id):
    src = os.path.join(HERE, src_name)
    dst = os.path.join(PLUG, dst_id)
    if not os.path.isdir(src):
        print("MISS  %s（源码目录不存在）" % src_name)
        return False
    if not os.path.isdir(dst):
        print("MISS  %s（插件未安装，跳过快照，直接写入）" % dst_id)
        os.makedirs(dst, exist_ok=True)
    else:
        old = version_of(dst)
        new = version_of(src)
        snap = os.path.join(SNAP, "%s-snap-%s" % (dst_id, old))
        if old == new:
            # 同版本重部署（调试时很常见）：没有可回滚的旧版，别刷一堆同版快照
            print("SNAP  跳过（目标已是 %s，无需快照）" % old)
        elif not os.path.exists(snap):
            os.makedirs(SNAP, exist_ok=True)
            shutil.copytree(dst, snap)
            print("SNAP  %s  (旧版 %s，快照在 Plugins 之外)" % (os.path.basename(snap), old))
        else:
            print("SNAP  已存在 %s" % os.path.basename(snap))

    want = manifest(src)
    have = manifest_all(dst) if os.path.isdir(dst) else {}

    # 1) 写入 / 覆盖
    for rel, full in want.items():
        target = os.path.join(dst, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(full, target)

    # 2) 清掉源码里已经不存在的旧文件（PRESERVE 除外）
    removed = []
    for rel in have:
        if rel in want or os.path.basename(rel) in PRESERVE:
            continue
        try:
            os.remove(os.path.join(dst, rel.replace("/", os.sep)))
            removed.append(rel)
        except OSError:
            pass
    # 清掉因删文件而空掉的目录（不动根目录）
    for base, dirs, files in os.walk(dst, topdown=False):
        if base == dst:
            continue
        if not os.listdir(base):
            try:
                os.rmdir(base)
            except OSError:
                pass

    # 3) 校验
    after = manifest(dst)
    diff = [rel for rel, full in want.items() if rel not in after or md5(full) != md5(after[rel])]
    print("DONE  %s  version=%s  files=%d  md5-diff=%d%s"
          % (dst_id, version_of(dst), len(want), len(diff),
             ("  已清理陈旧文件: " + ", ".join(removed[:8])) if removed else ""))
    if diff:
        print("  DIFF:", diff[:12])
    return not diff


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    ok = True
    for src_name, dst_id in PAIRS:
        if only and only not in (src_name, dst_id):
            continue
        ok = deploy(src_name, dst_id) and ok
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

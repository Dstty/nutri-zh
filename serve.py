#!/usr/bin/env python3
"""本地静态服务 —— 让浏览器的 ES module 与 fetch 正常工作。

为什么需要它: 直接以 file:// 打开 index.html 时, 浏览器会拦截
本地 fetch 读取(同源策略), 数据加载会失败。

用法:
    python serve.py            # 默认 8000 端口, 自动打开浏览器
    python serve.py 8080       # 指定端口
    python serve.py --no-open  # 不自动开浏览器

零依赖, 仅标准库。
"""
import argparse
import http.server
import os
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB, **kwargs)

    def end_headers(self):
        # 允许 .gz / .wasm 等被 fetch 正常取用
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 静音常规请求, 只报错误
        if args and str(args[1]).startswith(("4", "5")):
            sys.stderr.write("  %s\n" % (fmt % args))


def main():
    ap = argparse.ArgumentParser(description="汉字正则查找 · 本地服务")
    ap.add_argument("port", nargs="?", type=int, default=8000)
    ap.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    args = ap.parse_args()

    if not os.path.isdir(WEB):
        sys.exit(f"找不到 web/ 目录: {WEB}")
    if not os.path.exists(os.path.join(WEB, "data", "words.bin.gz")):
        sys.exit(
            "缺少数据文件 web/data/words.bin.gz\n"
            "请先运行:  node tools/build_index.mjs")

    socketserver.TCPServer.allow_reuse_address = True
    try:
        httpd = socketserver.TCPServer(("127.0.0.1", args.port), Handler)
    except OSError as e:
        sys.exit(f"端口 {args.port} 无法绑定: {e}\n换一个端口, 例如: python serve.py 8080")

    url = f"http://127.0.0.1:{args.port}/"
    print(f"汉字正则查找 -> {url}")
    print("按 Ctrl+C 停止\n")
    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()

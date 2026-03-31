#!/usr/bin/env python3
"""
Generate index.html for top-level directory listing.

Scans for:
- Top-level {name}.html files
- Folders with index.html
- Folders with dist/index.html (if no root index.html)
- Subfolders containing only HTML files (includes those HTML files)
"""

import os
from pathlib import Path

# Exclude paths containing any of these substrings (empty by default)
EXCLUDED = [
    "clipper-issue-repro"
]

SCRIPT_DIR = Path(__file__).parent.resolve()


def is_excluded(path: str) -> bool:
    """Check if path contains any excluded substring."""
    return any(exclude in path for exclude in EXCLUDED)


def folder_has_only_html_files(folder: Path) -> bool:
    """Check if folder contains only HTML files (no subdirs, no other files)."""
    has_html = False
    for item in folder.iterdir():
        if item.is_file():
            if item.suffix == ".html":
                has_html = True
            else:
                return False
        elif item.is_dir():
            return False
    return has_html


def collect_entries() -> list[tuple[str, str]]:
    """Collect all entries for the index page.

    Returns list of (display_name, href) tuples.
    """
    entries = []

    # 1. Top-level {name}.html files
    for item in SCRIPT_DIR.glob("*.html"):
        if item.name == "index.html":
            continue
        if is_excluded(item.name):
            continue
        if item.stem.startswith("_"):
            continue
        display_name = item.stem
        entries.append((display_name, item.name))

    # 2. Folders
    for item in SCRIPT_DIR.iterdir():
        if not item.is_dir():
            continue
        if item.name.startswith("."):
            continue
        if is_excluded(item.name):
            continue

        # Check for index.html in folder root
        if (item / "index.html").exists():
            display_name = item.name
            entries.append((display_name, f"{item.name}/index.html"))
        # Check for dist/index.html
        elif (item / "dist" / "index.html").exists():
            display_name = item.name
            entries.append((display_name, f"{item.name}/dist/index.html"))
        # Check if folder has only HTML files - include each HTML file
        elif folder_has_only_html_files(item):
            for html_file in sorted(item.glob("*.html")):
                if html_file.stem.startswith("_"):
                    continue
                display_name = html_file.stem
                entries.append((display_name, f"{item.name}/{html_file.name}"))
    
    # Sort entries alphabetically by display name
    entries.sort(key=lambda x: x[0].lower())
    
    return entries


def generate_html(entries: list[tuple[str, str]]) -> str:
    """Generate the index.html content."""
    entries_html = "\n".join(
        f'            <li><a href="{href}">{name}</a></li>'
        for name, href in entries
    )

    return f'''<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Utils Index</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap');

        :root {{
            --flexoki-bg: #100F0F;
            --flexoki-bg-2: #1C1B1A;
            --flexoki-ui: #282726;
            --flexoki-ui-2: #343331;
            --flexoki-ui-3: #403E3C;
            --flexoki-tx-3: #575653;
            --flexoki-tx-2: #878580;
            --flexoki-tx: #CECDC3;
            --flexoki-red: #D14D41;
            --flexoki-orange: #DA702C;
            --flexoki-yellow: #D0A215;
            --flexoki-green: #879A39;
            --flexoki-cyan: #3AA99F;
            --flexoki-blue: #4385BE;
            --flexoki-purple: #8B7EC8;
            --flexoki-magenta: #CE5D97;
            --width: 720px;
            --font-main: 'Inter', sans-serif;
            --font-secondary: 'Inter', sans-serif;
            --font-scale: 16px;
            --background-color: var(--flexoki-bg);
            --heading-color: var(--flexoki-tx);
            --text-color: var(--flexoki-tx);
            --link-color: var(--flexoki-cyan);
            --code-background-color: var(--flexoki-bg-2);
            --code-color: var(--flexoki-tx);
            --blockquote-color: var(--flexoki-tx-2);
        }}

        body {{
            font-family: var(--font-secondary);
            font-size: var(--font-scale);
            font-weight: 445;
            margin: auto;
            padding: 20px;
            max-width: var(--width);
            text-align: left;
            background-color: var(--background-color);
            word-wrap: break-word;
            overflow-wrap: break-word;
            line-height: 1.5;
            color: var(--text-color);
        }}

        h2 {{
            font-family: var(--font-main);
            color: var(--heading-color);
            border-bottom: 2px solid var(--flexoki-cyan);
            padding-bottom: 8px;
            margin-bottom: 20px;
            font-size: var(--font-scale);
        }}

        ul {{
            list-style: disc;
            padding-left: 20px;
            margin: 0;
        }}

        li {{
            margin: 8px 0;
        }}

        a {{
            color: var(--link-color);
            cursor: pointer;
            text-decoration: none;
        }}

        a:hover {{
            text-decoration: underline;
        }}

        code {{
            font-family: monospace;
            padding: 2px;
            background-color: var(--code-background-color);
            color: var(--code-color);
            border-radius: 3px;
        }}

        blockquote {{
            border-left: 1px solid #999;
            color: var(--blockquote-color);
            padding-left: 20px;
            font-style: italic;
        }}
    </style>
</head>

<body>

    <div class="container">
        <h2>utils</h2>
        <ul>
{entries_html}
        </ul>
    </div>

</body>

</html>
'''


def main():
    entries = collect_entries()
    html_content = generate_html(entries)
    
    output_path = SCRIPT_DIR / "index.html"
    output_path.write_text(html_content, encoding="utf-8")
    
    print(f"[pre-commit hook] [generate-index.py] Generated index.html with {len(entries)} entries")


if __name__ == "__main__":
    main()

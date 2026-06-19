#!/usr/bin/env python3
"""
Generate index.html for top-level directory listing.

Scans recursively one level deep:
- Top-level {name}.html files
- Per folder: index.html, dist/index.html, individual .html files, .user.js files,
  and sub-subfolder index.html entries
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


def scan_folder(folder: Path, prefix: str) -> list[tuple[str, str]]:
    """Scan a folder for indexable entries.

    Returns list of (display_name, href) tuples with paths relative to repo root.
    """
    entries = []

    # If folder has its own index.html, use that as the sole entry
    if (folder / "index.html").exists():
        entries.append((folder.name, f"{prefix}/index.html"))
        return entries

    # Check for dist/index.html (e.g. built SPAs)
    if (folder / "dist" / "index.html").exists():
        entries.append((folder.name, f"{prefix}/dist/index.html"))
        return entries

    # Individual .html files (non-index, non-hidden)
    for item in sorted(folder.glob("*.html")):
        if item.name == "index.html":
            continue
        if item.stem.startswith("_"):
            continue
        if is_excluded(str(item.relative_to(SCRIPT_DIR))):
            continue
        entries.append((item.stem, f"{prefix}/{item.name}"))

    # .user.js files (userscripts) — show full filename
    for item in sorted(folder.glob("*.user.js")):
        if is_excluded(str(item.relative_to(SCRIPT_DIR))):
            continue
        entries.append((item.name, f"{prefix}/{item.name}"))

    # Subfolders with their own index.html
    for subfolder in sorted(folder.iterdir()):
        if not subfolder.is_dir():
            continue
        if subfolder.name.startswith("."):
            continue
        if is_excluded(str(subfolder.relative_to(SCRIPT_DIR))):
            continue
        if (subfolder / "index.html").exists():
            entries.append((subfolder.name, f"{prefix}/{subfolder.name}/index.html"))

    return entries


def collect_entries() -> dict[str, list[tuple[str, str]]]:
    """Collect all entries into Tools and Userscripts sections."""
    tools: list[tuple[str, str]] = []
    userscripts: list[tuple[str, str]] = []

    # Top-level {name}.html files
    for item in sorted(SCRIPT_DIR.glob("*.html")):
        if item.name == "index.html":
            continue
        if item.stem.startswith("_"):
            continue
        if is_excluded(item.name):
            continue
        tools.append((item.stem, item.name))

    # Top-level folders
    for item in sorted(SCRIPT_DIR.iterdir()):
        if not item.is_dir():
            continue
        if item.name.startswith("."):
            continue
        if is_excluded(item.name):
            continue
        entries = scan_folder(item, prefix=item.name)
        if not entries:
            continue
        if item.name == "userscripts":
            userscripts.extend(entries)
        else:
            tools.extend(entries)

    tools.sort(key=lambda x: x[0].lower())
    userscripts.sort(key=lambda x: x[0].lower())

    sections: dict[str, list[tuple[str, str]]] = {}
    if tools:
        sections["tools"] = tools
    if userscripts:
        sections["userscripts"] = userscripts
    return sections


def generate_html(sections: dict[str, list[tuple[str, str]]]) -> str:
    """Generate the index.html content from categorized sections."""
    sections_html = ""

    for heading, entries in sections.items():
        entries_html = "\n".join(
            f'            <li><a href="{href}">{name}</a></li>'
            for name, href in entries
        )
        sections_html += f'''        <h3>{heading}</h3>
        <ul>
{entries_html}
        </ul>

'''

    return f'''<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>cdn</title>
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
            margin-bottom: 24px;
            font-size: var(--font-scale);
        }}

        h3 {{
            font-family: var(--font-main);
            color: var(--heading-color);
            margin-bottom: 12px;
            margin-top: 24px;
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
        <h2>cdn</h2>
{sections_html}    </div>

</body>

</html>
'''


def main():
    entries = collect_entries()
    html_content = generate_html(entries)
    
    output_path = SCRIPT_DIR / "index.html"
    output_path.write_text(html_content, encoding="utf-8")
    
    total = sum(len(v) for v in entries.values())
    print(f"[generate-index.py] Generated index.html with {total} entries")


if __name__ == "__main__":
    main()

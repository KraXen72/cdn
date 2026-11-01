# /// script
# requires-python = ">=3.11"
# dependencies = ["markdown-it-py==4.0.0"]
# ///
"""Render the four Markdown notes as static pages with optional progress saving."""

import argparse
from html import escape
from pathlib import Path
import re
from string import Template

from markdown_it import MarkdownIt
from markdown_it.token import Token

ROOT = Path(__file__).resolve().parent
INFO_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>'


def html_token(content: str) -> Token:
    """Insert trusted generated markup into the Markdown token stream."""
    token = Token("html_inline", "", 0)
    token.content = content
    return token


def checkbox(kind: str, ids: list[int], label: str, checked: bool = False) -> str:
    attributes = f'data-type="{kind}" data-ids="{",".join(map(str, ids))}"'
    if kind == "reading":
        attributes += f' data-id="{ids[0]}"'
    return (
        f'<input type="checkbox" class="check {kind}-check" {attributes}'
        f' aria-label="{escape(label, quote=True)}" disabled'
        f"{' checked' if checked else ''}>"
    )


def add_reading_checkboxes(
    markdown: MarkdownIt, tokens: list[Token], path: Path
) -> list[tuple[int, int]]:
    """Add labeled tasks, retaining the original app's week/reading IDs."""
    readings = []
    week = None
    week_readings = 0

    for index, token in enumerate(tokens):
        if token.type == "heading_open" and token.tag == "h3":
            match = re.fullmatch(r"Week (\d+)", tokens[index + 1].content)
            if not match:
                raise ValueError(f"{path.name}: expected a Week heading")
            week = int(match[1])
            week_readings = 0

        if token.type != "inline" or not re.match(r"^\[[ xX]\] ", token.content):
            continue
        if week is None or tokens[index - 2].type != "list_item_open":
            raise ValueError(f"{path.name}: reading outside a weekly task list")

        week_readings += 1
        if week_readings > (3 if week == 104 else 5):
            raise ValueError(f"{path.name}: too many readings in Week {week}")
        reading_id = (week - 1) * 5 + week_readings
        readings.append((index, reading_id))
        item = tokens[index - 2]
        item.attrSet("class", "task-list-item")
        item.attrSet("id", f"reading-{reading_id}")
        label = token.content[4:]
        checked = token.content[1].lower() == "x"
        token.children = [
            html_token("<label>" + checkbox("reading", [reading_id], label, checked))
        ]
        token.children += markdown.parseInline(label)[0].children
        token.children.append(html_token("</label>"))

    return readings


def add_section_checkboxes(
    tokens: list[Token], readings: list[tuple[int, int]]
) -> None:
    """Derive each parent checkbox's readings from Markdown heading boundaries."""
    # Scope boundaries follow heading levels, just like Markdown sections.
    for index, token in enumerate(tokens):
        if token.type != "heading_open" or token.tag not in {"h1", "h2", "h3"}:
            continue
        end = next(
            (
                i
                for i in range(index + 1, len(tokens))
                if tokens[i].type == "heading_open" and tokens[i].tag <= token.tag
            ),
            len(tokens),
        )
        ids = [
            reading_id for position, reading_id in readings if index < position < end
        ]
        title = tokens[index + 1]
        kind = {"h1": "part", "h2": "month", "h3": "week"}[token.tag]
        title.children.insert(0, html_token(checkbox(kind, ids, title.content)))
        token.attrSet("class", "section-heading")
        number = re.search(r"\d+", title.content).group()
        token.attrSet("id", f"{kind}-{int(number)}")


def render_callouts(markdown: MarkdownIt, tokens: list[Token]) -> None:
    """Render Obsidian info callouts without treating ordinary quotes as callouts."""
    for index, token in enumerate(tokens):
        if token.type != "blockquote_open":
            continue
        title = tokens[index + 2]
        match = re.match(r"\[!info\] ([^\n]+)\n?", title.content)
        if not match:
            continue
        end = next(
            i
            for i in range(index + 1, len(tokens))
            if tokens[i].type == "blockquote_close" and tokens[i].level == token.level
        )
        token.type = "html_block"
        token.content = (
            '<aside class="callout"><div class="callout-title">'
            + INFO_ICON
            + escape(match[1])
            + '</div><div class="callout-content">\n'
        )
        title.children = markdown.parseInline(title.content[match.end() :])[0].children
        tokens[end].type = "html_block"
        tokens[end].content = "</div></aside>\n"


def render_note(path: Path, part: int) -> tuple[str, list[int]]:
    """Render a note and verify its reading IDs match the existing plan.

    IDs depend on week and task position. Preserve passage order when editing
    content so saved progress continues to refer to the same passage.
    """
    source = path.read_text(encoding="utf-8")
    source = re.sub(r"\A---\n.*?\n---\n", "", source, count=1, flags=re.S)
    markdown = MarkdownIt("commonmark", {"html": False, "breaks": True})
    tokens = markdown.parse(source)
    readings = add_reading_checkboxes(markdown, tokens, path)
    add_section_checkboxes(tokens, readings)
    render_callouts(markdown, tokens)

    ids = [reading_id for _, reading_id in readings]
    expected = list(range((part - 1) * 130 + 1, min(part * 130, 518) + 1))
    if ids != expected:
        raise ValueError(
            f"{path.name}: expected the original reading order for Part {part}"
        )
    return markdown.renderer.render(tokens, markdown.options, {}), ids


def main() -> None:
    """Build from checked-in notes, or copy and render an external notes folder."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=ROOT / "markdown",
        help="folder containing Part 1 … Part 4 Markdown notes",
    )
    args = parser.parse_args()
    template = Template((ROOT / "page.html.template").read_text())
    pages = []
    for part in range(1, 5):
        matches = list(args.source.glob(f"Part {part} - Months *.md"))
        if len(matches) != 1:
            raise ValueError(f"Expected one Part {part} note in {args.source}")
        path = matches[0]
        content, ids = render_note(path, part)
        pages.append((part, path, content, ids))

    # Validate all notes before replacing any generated files.
    total = pages[-1][3][-1]
    ends = ",".join(str(ids[-1]) for _, _, _, ids in pages)
    for part, path, content, ids in pages:
        navigation = "\n".join(
            f'<a href="./part-{number}.html"{" aria-current=page" if number == part else ""}>Part {number}</a>'
            for number in range(1, 5)
        )
        page = template.substitute(
            part=part, ends=ends, total=total, navigation=navigation, content=content
        )
        (ROOT / f"part-{part}.html").write_text(page, encoding="utf-8")
        destination = ROOT / "markdown" / path.name
        if path.resolve() != destination.resolve():
            destination.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    index = template.substitute(
        part=0,
        ends=ends,
        total=total,
        navigation=navigation.replace(" aria-current=page", ""),
        content="<h1>Bible Reading Plan</h1><p>Choose a part above to start reading.</p>",
    )
    (ROOT / "index.html").write_text(index, encoding="utf-8")
    print("Built four static notes and index (518 readings).")


if __name__ == "__main__":
    main()

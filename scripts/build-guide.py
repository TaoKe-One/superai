"""Render the repository's bilingual user guide into the Pages artifact."""

import argparse
from html import escape
from os.path import relpath
from pathlib import Path
from shutil import copyfile
from urllib.parse import urlsplit, urlunsplit
from xml.etree.ElementTree import SubElement

from markdown import Markdown
from markdown.extensions import Extension
from markdown.extensions.toc import TocExtension, slugify_unicode
from markdown.treeprocessors import Treeprocessor


ROOT = Path(__file__).resolve().parents[1]
SCREENSHOTS = ROOT / "docs" / "previews"
SECTIONS = {
    "index": ("", "概览", "Overview"),
    "deployment": ("deployment", "系统部署", "Deployment"),
    "usage": ("usage", "功能使用", "Feature guide"),
    "faq": ("faq", "常见问题", "FAQ"),
}


def page_path(name, english):
    return Path("guide") / ("en" if english else "") / SECTIONS[name][0]


PAGES = {
    name + suffix + ".md": page_path(name, english)
    for name in SECTIONS
    for english, suffix in ((False, ""), (True, ".en"))
}


def directory_link(target, current):
    return relpath(target, current) + "/"


class GuideLinks(Treeprocessor):
    def __init__(self, md, current):
        super().__init__(md)
        self.current = current

    def run(self, root):
        for anchor in root.iter("a"):
            url = urlsplit(anchor.attrib["href"])
            if url.netloc or url.scheme:
                continue
            if url.path in PAGES:
                target = directory_link(PAGES[url.path], self.current)
                anchor.set("href", urlunsplit(("", "", target, url.query, url.fragment)))
            elif Path(url.path).parent == Path("previews"):
                anchor.set("href", relpath(url.path, self.current))

            image = anchor.find("img")
            if image is None:
                continue
            path = Path(image.attrib["src"])
            if path.parent != Path("previews") or not (SCREENSHOTS / path.name).is_file():
                continue
            anchor.remove(image)
            picture = SubElement(anchor, "picture", {"class": "guide-screenshot"})
            mobile = path.with_stem(path.stem + "-mobile")
            if (SCREENSHOTS / mobile.name).is_file():
                SubElement(picture, "source", {
                    "media": "(max-width: 600px)",
                    "srcset": relpath(mobile, self.current),
                })
            image.set("src", relpath(path, self.current))
            image.set("loading", "lazy")
            picture.append(image)


class GuideExtension(Extension):
    def __init__(self, current):
        self.current = current
        super().__init__()

    def extendMarkdown(self, md):
        md.treeprocessors.register(GuideLinks(md, self.current), "guide-links", 4)


def render(name, english, output):
    current = page_path(name, english)
    source = ROOT / "docs" / (name + (".en" if english else "") + ".md")
    heading, _, content = source.read_text(encoding="utf-8").partition("\n")
    title = heading.removeprefix("# ").strip()
    if heading == title or not title:
        raise ValueError(f"{source} must start with a page title")
    markdown = Markdown(extensions=[
        "fenced_code",
        "tables",
        TocExtension(slugify=slugify_unicode, toc_depth="2-3"),
        GuideExtension(current),
    ])
    # Python-Markdown's serializer predates the HTML void element <source>.
    article = markdown.convert(content).replace("</source>", "")
    labels = (
        ("en", "Guide", "Preview", "On this page", "简体中文", "Skip to content")
        if english else
        ("zh-CN", "使用手册", "界面预览", "本页目录", "English", "跳到正文")
    )
    lang, guide, preview, contents, language, skip = labels
    section_links = []
    for section, (_, zh, en) in SECTIONS.items():
        target = directory_link(page_path(section, english), current)
        active = ' aria-current="page"' if name == section else ""
        section_links.append(f'<a href="{target}"{active}>{en if english else zh}</a>')
    assets = directory_link(Path("guide"), current)
    home = directory_link(Path("."), current)
    overview = directory_link(page_path("index", english), current)
    other_language = directory_link(page_path(name, not english), current)
    document = f"""<!doctype html>
<html lang="{lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="{escape(title)} · SuperAI">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self'; form-action 'none'; base-uri 'none'">
  <title>{escape(title)} · SuperAI</title>
  <link rel="icon" href="{assets}superai-icon.png" type="image/png">
  <link rel="stylesheet" href="{assets}guide.css">
</head>
<body>
  <a class="skip" href="#main">{skip}</a>
  <header class="top">
    <div class="top-inner">
      <a class="brand" href="{overview}"><img src="{assets}superai-icon.png" width="30" height="30" alt=""><span>超级爱 <small>{guide}</small></span></a>
      <nav class="utilities">
        <a href="{home}">{preview}</a>
        <a href="{other_language}" lang="{'zh-CN' if english else 'en'}">{language}</a>
        <a href="https://github.com/TaoKe-One/superai">GitHub</a>
      </nav>
    </div>
  </header>
  <div class="layout">
    <nav class="sections" aria-label="{guide}">{"".join(section_links)}</nav>
    <aside class="contents">
      <nav aria-label="{contents}">
        <strong>{contents}</strong>
        {markdown.toc}
      </nav>
    </aside>
    <main id="main" tabindex="-1">
      <h1>{escape(title)}</h1>
      {article}
    </main>
  </div>
</body>
</html>
"""
    destination = output / current / "index.html"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(document, encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    for name in SECTIONS:
        for english in (False, True):
            render(name, english, args.output)
    copyfile(ROOT / "demo" / "guide.css", args.output / "guide" / "guide.css")
    copyfile(ROOT / "public" / "superai-icon.png", args.output / "guide" / "superai-icon.png")
    previews = args.output / "previews"
    previews.mkdir(exist_ok=True)
    for screenshot in SCREENSHOTS.glob("*.png"):
        copyfile(screenshot, previews / screenshot.name)

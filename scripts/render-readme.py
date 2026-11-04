"""Render README artwork from demo.json; Pillow and FFmpeg are authoring-only tools."""
from pathlib import Path
import json
import os
import re
import subprocess
import tempfile
import textwrap
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
MEDIA = ROOT / 'docs/media'
DATA = json.loads((MEDIA / 'demo.json').read_text())
NAVY, PANEL, WHITE, MUTED, TEAL = '#0d1729', '#142238', '#edf4ff', '#a6b7ce', '#72e2cd'


def font(size, mono=False, bold=False):
    override = os.environ.get('MYAB_MEDIA_MONO' if mono else 'MYAB_MEDIA_FONT')
    candidates = [override] if override else []
    candidates += (['/System/Library/Fonts/Menlo.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'] if mono else
                   ['/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold else '/System/Library/Fonts/Supplemental/Arial.ttf',
                    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'])
    for candidate in candidates:
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    raise RuntimeError('Set MYAB_MEDIA_FONT and MYAB_MEDIA_MONO to local font files.')


def text(draw, xy, value, size=24, colour=WHITE, mono=False, bold=False):
    draw.text(xy, value, font=font(size, mono, bold), fill=colour)


def banner():
    image = Image.new('RGB', (1440, 420), NAVY)
    d = ImageDraw.Draw(image)
    d.rounded_rectangle((64, 65, 151, 152), 22, fill=PANEL)
    text(d, (81, 82), '>_', 44, TEAL, True)
    text(d, (180, 78), 'myab', 72, bold=True)
    text(d, (66, 193), 'MyAberdeen, from your terminal.', 48, bold=True)
    text(d, (68, 272), 'Courses. Files. Lecture transcripts. All in your local archive.', 25, MUTED)
    text(d, (68, 352), 'UNOFFICIAL  /  READ-ONLY  /  LOCAL ARCHIVE', 17, TEAL, True)
    # Original geometric arch motif; no university crest or third-party artwork.
    for x, y, h in [(1110, 120, 212), (1215, 78, 254), (1320, 142, 190)]:
        d.rounded_rectangle((x, y, x + 66, y + h), 33, outline='#28445a', width=2)
        d.line((x, y + h - 32, x + 66, y + h - 32), fill='#28445a', width=2)
    image.save(MEDIA / 'banner.png', optimize=True)


def terminal(scene, typed=None, output=True, progress=0):
    image = Image.new('RGB', (1440, 900), NAVY)
    d = ImageDraw.Draw(image)
    text(d, (58, 39), scene['title'], 32, bold=True)
    text(d, (58, 89), scene['note'], 23, MUTED)
    d.rounded_rectangle((48, 155, 1392, 795), 20, fill='#101c2e', outline='#2a3c54', width=2)
    for x, colour in [(80, '#ee8a83'), (106, '#e8ca7b'), (132, '#72c7a5')]:
        d.ellipse((x, 180, x + 12, 192), fill=colour)
    text(d, (576, 174), 'myab — local archive', 19, MUTED, True)
    d.line((49, 213, 1391, 213), fill='#2a3c54', width=1)
    command = scene['command'] if typed is None else scene['command'][:typed]
    y = 247
    for i, line in enumerate(command.split('\n')):
        # Long jq pipelines are wrapped visually, just as in a narrow terminal.
        for j, wrapped in enumerate(textwrap.wrap(line, 91, replace_whitespace=False, drop_whitespace=False) or ['']):
            text(d, (80, y), ('$ ' if i == j == 0 else '  ') + wrapped, 23, TEAL, True)
            y += 34
    if output:
        y += 24
        for line in scene['output'].strip().splitlines():
            for wrapped in textwrap.wrap(line, 91, replace_whitespace=False, drop_whitespace=False) or ['']:
                if y > 747:
                    raise ValueError('Scene does not fit: shorten it or paginate the captured output.')
                text(d, (80, y), wrapped, 23, WHITE, True)
                y += 32
    else:
        d.rectangle((82, y + 3, 93, y + 24), fill=TEAL)
    text(d, (58, 836), 'SYNTHETIC DATA · Actual CLI output · jq used to select JSON fields', 18, MUTED, True)
    d.rectangle((48, 884, 1392, 888), fill=PANEL)
    d.rectangle((48, 884, 48 + int(1344 * progress), 888), fill=TEAL)
    return image


def export_preview():
    """Render real generated Markdown; this is a preview, not an Obsidian screenshot."""
    image = Image.new('RGB', (1440, 1000), NAVY)
    d = ImageDraw.Draw(image)
    text(d, (54, 36), 'A place for your course archive', 38, bold=True)
    text(d, (54, 96), 'Generated Markdown, ready to open in your own Obsidian vault.', 25, MUTED)
    d.rounded_rectangle((48, 160, 1392, 926), 18, fill='#101c2e', outline='#2a3c54', width=2)
    d.line((392, 161, 392, 925), fill='#2a3c54', width=2)
    text(d, (75, 191), 'EXAMPLE VAULT', 18, TEAL, True)
    files = ['Uni / 2026-27 / CS1000', '  MyAberdeen', '    Index.md', '    Content.md', '    Files.md', '    Recordings.md', '    Announcements.md', '    Gradebook.md', '    Messages.md', '    Discussions.md', '    Schedule.md']
    for i, name in enumerate(files):
        text(d, (75, 246 + 43 * i), name, 18, TEAL if 'Index.md' in name else MUTED, True)
    text(d, (435, 191), 'MyAberdeen / Index.md', 19, MUTED, True)
    # Use the real generated heading, term and section labels. Omit machine paths.
    heading = next(line[2:] for line in DATA['index'].splitlines() if line.startswith('# '))
    for i, line in enumerate(textwrap.wrap(heading, 40)):
        text(d, (435, 248 + i * 43), line, 33, bold=True)
    text(d, (435, 364), 'Term: 2026-27', 22, MUTED)
    text(d, (435, 422), 'Offline sections', 27, bold=True)
    links = re.findall(r'^- \[([^]]+)\]\([^)]+\) — (.+)$', DATA['index'], re.M)
    for i, (label, detail) in enumerate(links):
        text(d, (448, 480 + i * 44), label, 23, TEAL)
        text(d, (720, 480 + i * 44), detail, 22, MUTED)
    text(d, (54, 956), 'SYNTHETIC DATA · Generated export preview · Obsidian is optional', 18, MUTED, True)
    image.save(MEDIA / 'obsidian-export.png', optimize=True)


def animation():
    fps, seconds = 8, 10
    with tempfile.TemporaryDirectory(prefix='myab-readme-frames-') as directory:
        count = fps * seconds * len(DATA['scenes'])
        for scene_index, scene in enumerate(DATA['scenes']):
            for frame in range(fps * seconds):
                index = scene_index * fps * seconds + frame
                elapsed = frame / fps
                typed = int(len(scene['command']) * min(1, elapsed / 2))
                terminal(scene, typed, elapsed >= 2.3, index / (count - 1)).save(Path(directory) / f'{index:04d}.png')
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(fps), '-i', str(Path(directory) / '%04d.png'),
                        '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(MEDIA / 'terminal-demo.mp4')], check=True)
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(MEDIA / 'terminal-demo.mp4'),
                        '-filter_complex', '[0:v]scale=1008:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
                        '-loop', '0', str(MEDIA / 'terminal-demo.gif')], check=True)
    terminal(DATA['scenes'][0], progress=1/3).save(MEDIA / 'terminal-demo.png', optimize=True)


banner()
export_preview()
animation()
print('Rendered banner, export preview, terminal poster, 30-second GIF and MP4.')

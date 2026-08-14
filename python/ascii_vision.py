#!/usr/bin/env python3

import sys
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps, ImageStat

ASCII_WIDTH = 72
CHARACTERS = " .:-=+*#%@"

COLOR_PALETTE = {
    "K": (20, 20, 20),       # black
    "A": (128, 128, 128),    # gray
    "W": (235, 235, 235),    # white
    "R": (210, 45, 45),      # red
    "O": (230, 125, 35),     # orange
    "Y": (225, 205, 55),     # yellow
    "G": (55, 155, 70),      # green
    "C": (50, 180, 180),     # cyan
    "B": (55, 100, 200),     # blue
    "P": (125, 70, 170),     # purple
    "M": (220, 130, 170),    # pink
    "N": (120, 75, 45),      # brown
}

COLOR_LEGEND = (
    "K=black A=gray W=white R=red O=orange Y=yellow "
    "G=green C=cyan B=blue P=purple M=pink N=brown"
)


def grid_height(image: Image.Image, width: int) -> int:
    """Calculate a height adjusted for the aspect ratio of text characters."""
    return max(1, round(width * image.height / image.width * 0.45))


def to_ascii(image: Image.Image, width: int, edges: bool = False) -> str:
    grayscale = ImageOps.grayscale(image)

    if edges:
        grayscale = grayscale.filter(ImageFilter.FIND_EDGES)

    height = grid_height(grayscale, width)
    resized = grayscale.resize((width, height), Image.Resampling.LANCZOS)
    pixels = list(resized.getdata())

    rows = []
    for row_start in range(0, len(pixels), width):
        row = pixels[row_start:row_start + width]
        rows.append(
            "".join(
                CHARACTERS[value * (len(CHARACTERS) - 1) // 255]
                for value in row
            )
        )

    return "\n".join(rows)


def nearest_color_code(pixel: tuple[int, int, int]) -> str:
    return min(
        COLOR_PALETTE,
        key=lambda code: sum(
            (channel - reference) ** 2
            for channel, reference in zip(pixel, COLOR_PALETTE[code])
        ),
    )


def to_color_grid(image: Image.Image, width: int) -> str:
    rgb = image.convert("RGB")
    height = grid_height(rgb, width)
    resized = rgb.resize((width, height), Image.Resampling.BOX)
    pixels = list(resized.getdata())

    rows = []
    for row_start in range(0, len(pixels), width):
        row = pixels[row_start:row_start + width]
        rows.append("".join(nearest_color_code(pixel) for pixel in row))

    return "\n".join(rows)


def describe(path: Path) -> str:
    with Image.open(path) as image:
        image_format = image.format
        normalized = ImageOps.exif_transpose(image)
        brightness = ImageStat.Stat(ImageOps.grayscale(normalized)).mean[0]

        if normalized.width > normalized.height:
            orientation = "landscape"
        elif normalized.height > normalized.width:
            orientation = "portrait"
        else:
            orientation = "square"

        return f"""METADATA
format={image_format}
size={normalized.width}x{normalized.height}
orientation={orientation}
mean_brightness={brightness:.1f}
grid_size={ASCII_WIDTH}x{grid_height(normalized, ASCII_WIDTH)}
GRAYSCALE VIEW
{to_ascii(normalized, ASCII_WIDTH)}
EDGE VIEW
{to_ascii(normalized, ASCII_WIDTH, edges=True)}
COARSE COLOR GRID
legend: {COLOR_LEGEND}
{to_color_grid(normalized, ASCII_WIDTH)}
"""


def main() -> None:
    if len(sys.argv) != 2:
        print(f"Usage: {Path(sys.argv[0]).name} IMAGE", file=sys.stderr)
        raise SystemExit(2)

    path = Path(sys.argv[1])

    if not path.is_file():
        print(f"Error: file not found: {path}", file=sys.stderr)
        raise SystemExit(1)

    try:
        print(describe(path))
    except (OSError, ValueError) as error:
        print(f"Error: unable to process {path}: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()

"""Create an extension-free SB3 with a stage and one sprite for the D3 test."""
import hashlib
import json
import sys
import zipfile


def costume(archive, name, width, height, color):
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">'
        f'<rect width="{width}" height="{height}" fill="{color}"/></svg>'
    )
    asset_id = hashlib.md5(svg.encode()).hexdigest()
    filename = asset_id + ".svg"
    archive.writestr(filename, svg)
    return {
        "name": name, "assetId": asset_id, "dataFormat": "svg", "md5ext": filename,
        "rotationCenterX": width // 2, "rotationCenterY": height // 2,
    }


with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as archive:
    backdrop = costume(archive, "Backdrop", 480, 360, "#fafafa")
    square = costume(archive, "Square", 40, 40, "#087f8c")
    common = {
        "variables": {}, "lists": {}, "broadcasts": {}, "blocks": {}, "comments": {},
        "currentCostume": 0, "sounds": [], "volume": 100,
    }
    archive.writestr("project.json", json.dumps({
        "targets": [
            dict(common, isStage=True, name="Stage", layerOrder=0, costumes=[backdrop],
                 tempo=60, videoTransparency=50, videoState="off"),
            dict(common, isStage=False, name="Sprite1", layerOrder=1, costumes=[square],
                 visible=True, x=0, y=0, size=100, direction=90, draggable=False,
                 rotationStyle="all around"),
        ],
        "monitors": [], "extensions": [],
        "meta": {"semver": "3.0.0", "vm": "0.2.0", "agent": "D3 test fixture"},
    }))
